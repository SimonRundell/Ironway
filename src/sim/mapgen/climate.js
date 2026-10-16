/**
 * Generates rainfall with an orographic effect: moisture is carried
 * inland from the sea by the prevailing wind, drops extra rain when
 * forced to climb (the windward side of a range), and is left depleted
 * on the way back down (the rain shadow on the lee side). DESIGN.md
 * 5.2 step 6. Pure function of elevation and the island's shape; no
 * randomness is involved, so this needs no seed.
 *
 * @module sim/mapgen/climate
 */

import { indexOf } from './grid.js'

/** @type {Record<string, {axis: 'x'|'y', step: 1|-1}>} Scan axis and direction moisture travels for each wind. */
const WIND_AXES = {
  west: { axis: 'x', step: 1 },
  east: { axis: 'x', step: -1 },
  north: { axis: 'y', step: 1 },
  south: { axis: 'y', step: -1 },
}

/**
 * Clamps and rounds a value to a Uint8-safe byte (0 to 255).
 *
 * @param {number} value The value to clamp.
 * @returns {number} An integer in [0, 255].
 */
function clampByte(value) {
  const rounded = Math.floor(value + 0.5)
  if (rounded < 0) return 0
  if (rounded > 255) return 255
  return rounded
}

/**
 * Builds the sequence of cell indices moisture travels along: one line
 * per row (for an east-west wind) or per column (for a north-south
 * wind), each ordered from the sea-facing edge inland.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {{axis: 'x'|'y', step: 1|-1}} wind The wind's scan axis and direction.
 * @returns {number[][]} One array of cell indices per line.
 */
function buildMoistureLines(grid, wind) {
  const { width, height } = grid
  const lines = []

  if (wind.axis === 'x') {
    for (let y = 0; y < height; y++) {
      const line = []
      for (let step = 0; step < width; step++) {
        const x = wind.step === 1 ? step : width - 1 - step
        line.push(indexOf(grid, x, y))
      }
      lines.push(line)
    }
  } else {
    for (let x = 0; x < width; x++) {
      const line = []
      for (let step = 0; step < height; step++) {
        const y = wind.step === 1 ? step : height - 1 - step
        line.push(indexOf(grid, x, y))
      }
      lines.push(line)
    }
  }

  return lines
}

/**
 * Generates the rain layer (step 6): marches moisture inland from the
 * sea along the prevailing wind, depositing a rain bonus proportional
 * to any climb (orographic uplift, drawn from the moisture pool) and
 * a baseline rain scaled by remaining moisture otherwise. Moisture
 * fully replenishes whenever the line crosses open sea, so bays and
 * inlets get their own fresh supply.
 *
 * @param {object} grid The world grid (rain is written; elev and water are read).
 * @param {{windDirection: string, baseRain: number, maxMoisture: number, upliftRainFactor: number, travelLossPerCell: number}} params
 *   mapgen.json's climate settings.
 * @returns {void}
 */
export function generateRain(grid, params) {
  const wind = WIND_AXES[params.windDirection] ?? WIND_AXES.west
  const lines = buildMoistureLines(grid, wind)

  for (const line of lines) {
    let moisture = params.maxMoisture
    let previousElev = 0

    for (const i of line) {
      if (grid.water[i] === 1) {
        moisture = params.maxMoisture
        previousElev = 0
        grid.rain[i] = clampByte(params.baseRain)
        continue
      }

      const climb = Math.max(0, grid.elev[i] - previousElev)
      let rainHere

      if (climb > 0) {
        const bonus = Math.min(moisture, climb * params.upliftRainFactor)
        rainHere = params.baseRain + bonus
        moisture -= bonus
      } else {
        rainHere = params.baseRain * (moisture / params.maxMoisture)
        moisture = Math.max(0, moisture - params.travelLossPerCell)
      }

      grid.rain[i] = clampByte(rainHere)
      previousElev = grid.elev[i]
    }
  }
}
