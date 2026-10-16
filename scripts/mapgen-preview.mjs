#!/usr/bin/env node
/**
 * Debug tool for T1.03/T1.04: generates an island for one or more
 * seeds and writes an ASCII preview of each into scripts/out/, for a
 * human to eyeball the island mask, mountains, coastline, lakes and
 * rivers.
 *
 * Usage:
 *   node scripts/mapgen-preview.mjs [seed ...]
 *
 * With no arguments, previews the five golden seeds (ironway-001 to
 * ironway-005).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { loadRulesNode } from '../src/sim/rules.js'
import { createWorldGrid } from '../src/sim/mapgen/grid.js'
import { generateIsland } from '../src/sim/mapgen/island.js'
import { generateRain } from '../src/sim/mapgen/climate.js'
import { generateHydrology } from '../src/sim/mapgen/hydrology.js'
import { generateSlope } from '../src/sim/mapgen/slope.js'

const DEFAULT_SEEDS = ['ironway-001', 'ironway-002', 'ironway-003', 'ironway-004', 'ironway-005']

/** @type {readonly string[]} Sea (deep to shallow) and land (low to high) ramp. */
const SEA_RAMP = [' ', '.', ':']
const LAND_RAMP = [',', '-', '+', '*', '^', '#', '@']
const LAKE_CHAR = '~'

/**
 * Renders a grid's water/elev/river layers as a plain-text ASCII map.
 * Rivers are drawn as their width class digit (1-5) over whatever
 * terrain character they cross, so both are visible at once.
 *
 * @param {object} grid A generated world grid.
 * @param {number} mountainLineMetres Elevation at which land is drawn as the highest ramp character.
 * @returns {string} The rendered map, one line per row.
 */
function renderAscii(grid, mountainLineMetres) {
  const lines = []

  for (let y = 0; y < grid.height; y++) {
    let line = ''
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x

      if (grid.water[i] === 1) {
        const depthStep = Math.min(SEA_RAMP.length - 1, Math.floor(-grid.elev[i] / 70))
        line += SEA_RAMP[depthStep]
      } else if (grid.water[i] === 2) {
        line += LAKE_CHAR
      } else if (grid.river[i] > 0) {
        line += String(grid.river[i])
      } else {
        const step = Math.min(LAND_RAMP.length - 1, Math.floor((grid.elev[i] / mountainLineMetres) * (LAND_RAMP.length - 2)))
        line += LAND_RAMP[Math.max(0, step)]
      }
    }
    lines.push(line)
  }

  return lines.join('\n') + '\n'
}

async function main() {
  const seeds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SEEDS
  const rules = await loadRulesNode('public/data')

  mkdirSync('scripts/out', { recursive: true })

  for (const seed of seeds) {
    const grid = createWorldGrid(rules.mapgen.grid.width, rules.mapgen.grid.height, rules.mapgen.grid.cellMiles)
    const start = Date.now()
    generateIsland(grid, seed, rules.mapgen)
    generateRain(grid, rules.mapgen.climate)
    generateHydrology(grid, rules.mapgen.hydrology)
    generateSlope(grid, rules.mapgen.slope)
    const elapsedMs = Date.now() - start

    let land = 0
    let lake = 0
    let river = 0
    let rockCells = 0
    for (let i = 0; i < grid.water.length; i++) {
      if (grid.water[i] === 0) land++
      if (grid.water[i] === 2) lake++
      if (grid.river[i] > 0) river++
      if (grid.elev[i] >= rules.mapgen.soil.mountainLineMetres) rockCells++
    }

    const ascii = renderAscii(grid, rules.mapgen.soil.mountainLineMetres)
    const outPath = `scripts/out/${seed}.txt`
    writeFileSync(outPath, ascii)

    const landFraction = (land / grid.water.length * 100).toFixed(1)
    console.log(
      `${seed}: ${elapsedMs}ms, land ${landFraction}%, rock cells ${rockCells}, ` +
      `lake cells ${lake}, river cells ${river} -> ${outPath}`,
    )
  }
}

main()
