import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createWorldGrid } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { generateCoast } from './coast.js'
import { generateSoil } from './soil.js'
import { generateResources, RESOURCE } from './resources.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules
let terrainRules
const cache = new Map()

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
  terrainRules = rules.terrain
})

/**
 * Runs the full pipeline through resource generation for a seed.
 * Memoised per seed since several `it.each` blocks check different
 * properties of the same 20 generated islands.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object, deposits: {coal: object[], iron: object[], stone: object[], clay: object[]}}}
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
  const deposits = generateResources(grid, seed, mapgenRules)

  const result = { grid, deposits }
  cache.set(seed, result)
  return result
}

/**
 * Counts (coal, iron) deposit pairs within `coalIronProximityMiles` of
 * each other.
 *
 * @param {object} grid The world grid.
 * @param {object[]} coal Coal deposits.
 * @param {object[]} iron Iron deposits.
 * @param {number} proximityMiles The chain distance, in miles.
 * @returns {number} The number of qualifying pairs.
 */
function countProximatePairs(grid, coal, iron, proximityMiles) {
  let count = 0
  for (const c of coal) {
    for (const i of iron) {
      const dx = (c.x - i.x) * grid.cellMiles
      const dy = (c.y - i.y) * grid.cellMiles
      if (Math.sqrt(dx * dx + dy * dy) <= proximityMiles) count++
    }
  }
  return count
}

describe('generateResources property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: meets the minimum deposit count for every resource', (seed) => {
    const { deposits } = generate(seed)
    const p = mapgenRules.resources
    expect(deposits.coal.length).toBeGreaterThanOrEqual(p.minCoalDeposits)
    expect(deposits.iron.length).toBeGreaterThanOrEqual(p.minIronDeposits)
    expect(deposits.stone.length).toBeGreaterThanOrEqual(p.minStoneDeposits)
    expect(deposits.clay.length).toBeGreaterThanOrEqual(p.minClayDeposits)
  })

  it.each(SEEDS)('%s: has enough coal-iron pairs within chain distance', (seed) => {
    const { grid, deposits } = generate(seed)
    const p = mapgenRules.resources
    const pairs = countProximatePairs(grid, deposits.coal, deposits.iron, p.coalIronProximityMiles)
    expect(pairs).toBeGreaterThanOrEqual(p.minCoalIronPairsWithinProximity)
  })

  it.each(SEEDS)('%s: every deposit cell is stamped with its type and a richness in range', (seed) => {
    const { grid, deposits } = generate(seed)
    const p = mapgenRules.resources
    const enumByType = { coal: RESOURCE.COAL, iron: RESOURCE.IRON, stone: RESOURCE.STONE, clay: RESOURCE.CLAY }

    for (const [type, list] of Object.entries(deposits)) {
      for (const deposit of list) {
        expect(deposit.richness).toBeGreaterThanOrEqual(p.richnessMin)
        expect(deposit.richness).toBeLessThanOrEqual(p.richnessMax)
        for (const cell of deposit.cells) {
          expect(grid.resource[cell]).toBe(enumByType[type])
          expect(grid.richness[cell]).toBe(deposit.richness)
        }
      }
    }
  })

  it.each(SEEDS)('%s: no deposit cell is claimed by more than one deposit', (seed) => {
    const { deposits } = generate(seed)
    const seen = new Set()
    for (const list of Object.values(deposits)) {
      for (const deposit of list) {
        for (const cell of deposit.cells) {
          expect(seen.has(cell)).toBe(false)
          seen.add(cell)
        }
      }
    }
  })

  it.each(SEEDS)('%s: every deposit cell is on land', (seed) => {
    const { grid, deposits } = generate(seed)
    for (const list of Object.values(deposits)) {
      for (const deposit of list) {
        for (const cell of deposit.cells) {
          expect(grid.water[cell]).toBe(0)
        }
      }
    }
  })

  it.each(SEEDS)('%s: cells with no deposit are resource NONE with 0 richness', (seed) => {
    const { grid, deposits } = generate(seed)
    const claimed = new Set()
    for (const list of Object.values(deposits)) {
      for (const deposit of list) {
        for (const cell of deposit.cells) claimed.add(cell)
      }
    }
    for (let i = 0; i < grid.resource.length; i++) {
      if (!claimed.has(i)) {
        expect(grid.resource[i]).toBe(RESOURCE.NONE)
        expect(grid.richness[i]).toBe(0)
      }
    }
  })
})
