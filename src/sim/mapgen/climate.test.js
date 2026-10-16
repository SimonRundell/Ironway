import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createWorldGrid, indexOf } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
})

describe('generateRain unit behaviour', () => {
  it('keeps every value within the Uint8 range', () => {
    const grid = createWorldGrid(20, 10, 2)
    generateIsland(grid, 'climate-range-check', mapgenRules)
    generateRain(grid, mapgenRules.climate)

    for (const value of grid.rain) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(255)
    }
  })

  it('gives a climbing cell more rain than base, drawn from moisture', () => {
    // A tiny synthetic strip: sea, then land stepping steadily uphill.
    const width = 6
    const height = 1
    const grid = createWorldGrid(width, height, 2)
    const params = { windDirection: 'west', baseRain: 50, maxMoisture: 255, upliftRainFactor: 0.5, travelLossPerCell: 0 }

    grid.water[0] = 1 // sea
    grid.elev[0] = -10
    for (let x = 1; x < width; x++) {
      grid.water[x] = 0
      grid.elev[x] = x * 100 // climbs steadily: 100, 200, 300, 400, 500
    }

    generateRain(grid, params)

    // Each climbing step should earn a rain bonus above baseRain.
    for (let x = 1; x < width; x++) {
      expect(grid.rain[x]).toBeGreaterThan(params.baseRain)
    }
  })

  it('depletes moisture on the descending (lee) side after a climb', () => {
    const width = 7
    const height = 1
    const grid = createWorldGrid(width, height, 2)
    const params = { windDirection: 'west', baseRain: 50, maxMoisture: 60, upliftRainFactor: 2, travelLossPerCell: 0 }

    grid.water[0] = 1
    grid.elev[0] = -10
    // Climb steeply to exhaust moisture, then descend.
    const profile = [0, 400, 800, 1200, 800, 400, 0]
    for (let x = 1; x < width; x++) {
      grid.water[x] = 0
      grid.elev[x] = profile[x]
    }

    generateRain(grid, params)

    const windwardRain = grid.rain[2] // still climbing, gets an uplift bonus
    const leeRain = grid.rain[5] // descending after the peak, no bonus, depleted moisture
    expect(leeRain).toBeLessThan(windwardRain)
  })

  it('resets moisture when the line crosses open sea', () => {
    const width = 5
    const height = 1
    const grid = createWorldGrid(width, height, 2)
    const params = { windDirection: 'west', baseRain: 50, maxMoisture: 100, upliftRainFactor: 1, travelLossPerCell: 20 }

    // sea, land, land, SEA (bay), land - all land held flat (elev 0) so
    // the only thing depleting or replenishing moisture here is travel
    // loss and the sea crossing, not any climb bonus.
    grid.water[0] = 1; grid.elev[0] = -5
    grid.water[1] = 0; grid.elev[1] = 0
    grid.water[2] = 0; grid.elev[2] = 0
    grid.water[3] = 1; grid.elev[3] = -5
    grid.water[4] = 0; grid.elev[4] = 0

    generateRain(grid, params)

    // The land cell right after the bay should get full baseRain again
    // (moisture replenished), not the depleted level cell 2 would have reached.
    expect(grid.rain[4]).toBe(params.baseRain)
  })
})

describe('rain shadow property (20 seeds)', () => {
  it.each(SEEDS)('%s: mean rain west of the highest peak exceeds mean rain east of it', (seed) => {
    const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
    generateIsland(grid, seed, mapgenRules)
    generateRain(grid, mapgenRules.climate)

    let peakX = 0
    let peakElev = -Infinity
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const i = indexOf(grid, x, y)
        if (grid.water[i] === 0 && grid.elev[i] > peakElev) {
          peakElev = grid.elev[i]
          peakX = x
        }
      }
    }

    let windwardSum = 0
    let windwardCount = 0
    let leeSum = 0
    let leeCount = 0

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const i = indexOf(grid, x, y)
        if (grid.water[i] !== 0) continue
        if (x < peakX) {
          windwardSum += grid.rain[i]
          windwardCount++
        } else if (x > peakX) {
          leeSum += grid.rain[i]
          leeCount++
        }
      }
    }

    const windwardMean = windwardSum / windwardCount
    const leeMean = leeSum / leeCount

    // A visible margin, not just "technically lower": most seeds show
    // a difference of 20-55 rain units (out of 255); 5 is a real,
    // consistently reproducible signal that still tolerates the rare
    // seed whose island shape makes an east/west split a poorer proxy
    // for "windward of the main range" (e.g. a peak near the margin).
    expect(windwardMean - leeMean).toBeGreaterThan(5)
  })
})
