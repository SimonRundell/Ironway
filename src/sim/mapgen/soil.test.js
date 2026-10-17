import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createWorldGrid } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { generateCoast } from './coast.js'
import { generateSoil } from './soil.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules
let terrainRules
let L
const cache = new Map()

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
  terrainRules = rules.terrain
  L = {}
  terrainRules.landuseEnum.forEach((name, index) => { L[name.toUpperCase()] = index })
})

/**
 * Runs the full pipeline through soil generation for a seed. Memoised
 * per seed since several `it.each` blocks check different properties
 * of the same 20 generated islands.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object}}
 */
function generate(seed) {
  if (cache.has(seed)) {
    return cache.get(seed)
  }

  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  generateIsland(grid, seed, mapgenRules)
  generateRain(grid, mapgenRules.climate)
  generateHydrology(grid, mapgenRules.hydrology)
  generateSlope(grid, mapgenRules.slope)
  generateCoast(grid, mapgenRules)
  generateSoil(grid, seed, mapgenRules, terrainRules)

  const result = { grid }
  cache.set(seed, result)
  return result
}

/**
 * Counts land-use classes among non-water cells, and the total land
 * cell count, for a generated grid.
 *
 * @param {object} grid The world grid, after generateSoil().
 * @returns {{land: number, counts: Record<number, number>}}
 */
function countLanduse(grid) {
  let land = 0
  const counts = {}
  for (let i = 0; i < grid.landuse.length; i++) {
    const lu = grid.landuse[i]
    if (lu === L.SEA || lu === L.LAKE) continue
    land++
    counts[lu] = (counts[lu] ?? 0) + 1
  }
  return { land, counts }
}

describe('generateSoil property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: at least 5%% each of arable, pastoral, forest and 1%% marsh', (seed) => {
    const { grid } = generate(seed)
    const { land, counts } = countLanduse(grid)

    expect((counts[L.ARABLE] ?? 0) / land).toBeGreaterThanOrEqual(0.05)
    expect((counts[L.PASTORAL] ?? 0) / land).toBeGreaterThanOrEqual(0.05)
    expect((counts[L.FOREST] ?? 0) / land).toBeGreaterThanOrEqual(0.05)
    expect((counts[L.MARSH] ?? 0) / land).toBeGreaterThanOrEqual(0.01)
  })

  it.each(SEEDS)('%s: every land cell has a real land-use class, never left at 0/sea by accident', (seed) => {
    const { grid } = generate(seed)
    const validClasses = new Set(terrainRules.landuseEnum.map((_, index) => index))
    for (let i = 0; i < grid.landuse.length; i++) {
      expect(validClasses.has(grid.landuse[i])).toBe(true)
      if (grid.water[i] === 0) {
        expect(grid.landuse[i]).not.toBe(L.SEA)
        expect(grid.landuse[i]).not.toBe(L.LAKE)
      }
    }
  })

  it.each(SEEDS)('%s: sea and lake cells match the water layer exactly', (seed) => {
    const { grid } = generate(seed)
    for (let i = 0; i < grid.landuse.length; i++) {
      if (grid.water[i] === 1) expect(grid.landuse[i]).toBe(L.SEA)
      if (grid.water[i] === 2) expect(grid.landuse[i]).toBe(L.LAKE)
    }
  })

  it.each(SEEDS)('%s: soil, arable and pastoral scores are only set on land', (seed) => {
    const { grid } = generate(seed)
    for (let i = 0; i < grid.landuse.length; i++) {
      if (grid.water[i] !== 0) {
        expect(grid.soil[i]).toBe(0)
        expect(grid.arable[i]).toBe(0)
        expect(grid.pastoral[i]).toBe(0)
      }
    }
  })

  it.each(SEEDS)('%s: rock is only assigned above the mountain line or above the rock slope ratio', (seed) => {
    const { grid } = generate(seed)
    const p = mapgenRules.soil
    const rockSlopeByte = p.rockSlopeRatio * mapgenRules.slope.quantizationScale
    for (let i = 0; i < grid.landuse.length; i++) {
      if (grid.landuse[i] === L.ROCK) {
        expect(grid.elev[i] >= p.mountainLineMetres || grid.slope[i] >= rockSlopeByte).toBe(true)
      }
    }
  })
})
