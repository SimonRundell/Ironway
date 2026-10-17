import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createNameGenerator } from '../names.js'
import { createWorldGrid, indexOf } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { generateCoast, COAST_FLAG } from './coast.js'
import { generateSoil } from './soil.js'
import { generateResources } from './resources.js'
import { generateSettlements } from './settlements.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules
let settlementsRules
let terrainRules
let classesRules
let namesRules
const cache = new Map()

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
  settlementsRules = rules.settlements
  terrainRules = rules.terrain
  classesRules = rules.classes
  namesRules = rules.names
})

/**
 * Runs the full pipeline through settlement generation for a seed.
 * Memoised per seed since several `it.each` blocks check different
 * properties of the same 20 generated islands.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object, settlements: import('../state.js').Settlement[]}}
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
  generateResources(grid, seed, mapgenRules)
  const nameGen = createNameGenerator(seed, namesRules)
  const settlements = generateSettlements(grid, seed, mapgenRules, settlementsRules, terrainRules, classesRules, nameGen)

  const result = { grid, settlements }
  cache.set(seed, result)
  return result
}

/**
 * Groups settlements by kind.
 *
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @returns {Record<string, import('../state.js').Settlement[]>}
 */
function groupByKind(settlements) {
  const byKind = {}
  for (const s of settlements) {
    (byKind[s.kind] ??= []).push(s)
  }
  return byKind
}

/**
 * Straight-line distance in miles between two settlements.
 *
 * @param {{x: number, y: number}} a First settlement.
 * @param {{x: number, y: number}} b Second settlement.
 * @returns {number} Distance in miles.
 */
function milesBetween(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

describe('generateSettlements property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: every kind count is within its DESIGN 5.4 range', (seed) => {
    const { settlements } = generate(seed)
    const byKind = groupByKind(settlements)

    for (const kind of settlementsRules.kinds) {
      const count = (byKind[kind.id] ?? []).length
      expect(count).toBeGreaterThanOrEqual(kind.count.min)
      expect(count).toBeLessThanOrEqual(kind.count.max)
    }
  })

  it.each(SEEDS)('%s: every pair of same-kind settlements respects that kind\'s minimum spacing', (seed) => {
    const { settlements } = generate(seed)
    const byKind = groupByKind(settlements)

    for (const kind of settlementsRules.kinds) {
      if (kind.minSpacingMiles == null) continue
      const list = byKind[kind.id] ?? []

      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          expect(milesBetween(list[a], list[b])).toBeGreaterThanOrEqual(kind.minSpacingMiles - 0.01)
        }
      }
    }
  })

  it.each(SEEDS)('%s: the capital is within 12 miles of a harbour candidate or estuary', (seed) => {
    const { grid, settlements } = generate(seed)
    const capital = settlements.find((s) => s.kind === 'capital')
    expect(capital).toBeDefined()

    let nearestMiles = Infinity
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const i = indexOf(grid, x, y)
        if ((grid.coast[i] & (COAST_FLAG.HARBOUR_CANDIDATE | COAST_FLAG.ESTUARY)) === 0) continue
        const dx = x * grid.cellMiles - capital.x
        const dy = y * grid.cellMiles - capital.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < nearestMiles) nearestMiles = d
      }
    }

    expect(nearestMiles).toBeLessThanOrEqual(12.01)
  })

  it.each(SEEDS)('%s: total initial population (default difficulty) is 2 to 3 million', (seed) => {
    const { settlements } = generate(seed)
    const total = settlements.reduce(
      (sum, s) => sum + Object.values(s.pop).reduce((a, c) => a + c.pop, 0),
      0,
    )
    expect(total).toBeGreaterThanOrEqual(2000000)
    expect(total).toBeLessThanOrEqual(3000000)
  })

  it.each(SEEDS)('%s: every port sits on a harbour candidate or estuary cell', (seed) => {
    const { grid, settlements } = generate(seed)

    for (const s of settlements) {
      if (s.portTier === 0) continue
      const i = indexOf(grid, Math.round(s.x / grid.cellMiles), Math.round(s.y / grid.cellMiles))
      expect(grid.coast[i] & (COAST_FLAG.HARBOUR_CANDIDATE | COAST_FLAG.ESTUARY)).toBeTruthy()
    }
  })

  it.each(SEEDS)('%s: no land cell within some settlement\'s hinterland radius is left without a region', (seed) => {
    const { grid, settlements } = generate(seed)
    const kindById = {}
    settlementsRules.kinds.forEach((k) => { kindById[k.id] = k })

    let gapIndex = -1

    for (let y = 0; y < grid.height && gapIndex === -1; y++) {
      for (let x = 0; x < grid.width; x++) {
        const i = indexOf(grid, x, y)
        if (grid.water[i] !== 0 || grid.region[i] !== 0) continue

        const inSomeRadius = settlements.some((s) => {
          const dx = x * grid.cellMiles - s.x
          const dy = y * grid.cellMiles - s.y
          const radius = kindById[s.kind].hinterlandRadiusMiles
          return Math.sqrt(dx * dx + dy * dy) <= radius - 0.01
        })

        if (inSomeRadius) {
          gapIndex = i
          break
        }
      }
    }

    expect(gapIndex).toBe(-1)
  }, 20000)

  it.each(SEEDS)('%s: every settlement has a unique id, and region cells reference a real settlement', (seed) => {
    const { grid, settlements } = generate(seed)
    const ids = new Set(settlements.map((s) => s.id))
    expect(ids.size).toBe(settlements.length)

    for (let i = 0; i < grid.region.length; i++) {
      if (grid.region[i] !== 0) expect(ids.has(grid.region[i])).toBe(true)
    }
  })

  it.each(SEEDS)('%s: each settlement\'s class populations sum exactly to its total population', (seed) => {
    const { settlements } = generate(seed)
    for (const s of settlements) {
      const sum = Object.values(s.pop).reduce((a, c) => a + c.pop, 0)
      expect(s.housing).toBe(Math.round(sum * settlementsRules.initialHousingCapacityFactor))
    }
  })

  it.each(SEEDS)('%s: settlement names are non-empty and unique', (seed) => {
    const { settlements } = generate(seed)
    const names = settlements.map((s) => s.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    for (const s of settlements) expect(s.name.length).toBeGreaterThan(0)
  })
})
