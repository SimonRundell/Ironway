import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createNameGenerator } from '../names.js'
import { createWorldGrid, indexOf } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { generateCoast } from './coast.js'
import { generateSoil } from './soil.js'
import { generateResources } from './resources.js'
import { generateSettlements } from './settlements.js'
import { generateLinks, findPath } from './links.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules
let settlementsRules
let terrainRules
let classesRules
let namesRules
let rockIndex
const cache = new Map()

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
  settlementsRules = rules.settlements
  terrainRules = rules.terrain
  classesRules = rules.classes
  namesRules = rules.names
  rockIndex = terrainRules.landuseEnum.indexOf('rock')
})

/**
 * A tiny union-find used only by these tests, to check connectivity
 * over the generated link list.
 *
 * @param {number} n Node count.
 * @returns {{find: (x: number) => number, union: (a: number, b: number) => void}}
 */
function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i)
  function find(x) {
    while (parent[x] !== x) x = parent[x]
    return x
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  return { find, union }
}

/**
 * Runs the full pipeline through link generation for a seed. Memoised
 * per seed since several `it.each` blocks check different properties
 * of the same 20 generated islands.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object, settlements: import('../state.js').Settlement[], links: import('../state.js').Link[]}}
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
  const links = generateLinks(grid, seed, mapgenRules, terrainRules, settlements)

  const result = { grid, settlements, links }
  cache.set(seed, result)
  return result
}

describe('generateLinks property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: every settlement is reachable from the capital by road', (seed) => {
    const { settlements, links } = generate(seed)
    const idToIndex = new Map(settlements.map((s, i) => [s.id, i]))
    const uf = unionFind(settlements.length)

    for (const l of links) {
      if (l.mode === 'road') uf.union(idToIndex.get(l.aId), idToIndex.get(l.bId))
    }

    const capital = settlements.find((s) => s.kind === 'capital')
    const capitalRoot = uf.find(idToIndex.get(capital.id))
    for (const s of settlements) {
      expect(uf.find(idToIndex.get(s.id))).toBe(capitalRoot)
    }
  })

  it.each(SEEDS)('%s: every port is reachable from every other port by sea', (seed) => {
    const { settlements, links } = generate(seed)
    const ports = settlements.filter((s) => s.portTier > 0)
    if (ports.length < 2) return

    const idToIndex = new Map(settlements.map((s, i) => [s.id, i]))
    const uf = unionFind(settlements.length)
    for (const l of links) {
      if (l.mode === 'sea' && l.bType === 's') uf.union(idToIndex.get(l.aId), idToIndex.get(l.bId))
    }

    const firstRoot = uf.find(idToIndex.get(ports[0].id))
    for (const p of ports) {
      expect(uf.find(idToIndex.get(p.id))).toBe(firstRoot)
    }
  })

  it.each(SEEDS)('%s: no road path point sits on a rock cell', (seed) => {
    const { grid, links } = generate(seed)

    for (const l of links) {
      if (l.mode !== 'road') continue
      for (const [x, y] of l.path) {
        const i = indexOf(grid, Math.round(x / grid.cellMiles), Math.round(y / grid.cellMiles))
        expect(grid.landuse[i]).not.toBe(rockIndex)
      }
    }
  })

  it.each(SEEDS)('%s: rail mileage is at most 15% of road mileage', (seed) => {
    const { links } = generate(seed)
    const roadTotal = links.filter((l) => l.mode === 'road').reduce((sum, l) => sum + l.lengthMi, 0)
    const railTotal = links.filter((l) => l.mode === 'rail').reduce((sum, l) => sum + l.lengthMi, 0)
    if (roadTotal === 0) return
    expect(railTotal / roadTotal).toBeLessThanOrEqual(mapgenRules.links.maxRailShareOfRoadMiles + 1e-9)
  })

  it.each(SEEDS)('%s: average path JSON size is under 4 KB', (seed) => {
    const { links } = generate(seed)
    const avgBytes = links.reduce((sum, l) => sum + JSON.stringify(l.path).length, 0) / links.length
    expect(avgBytes).toBeLessThan(4096)
  })

  it.each(SEEDS)('%s: every port has exactly one world link, matching its port tier', (seed) => {
    const { settlements, links } = generate(seed)
    const ports = settlements.filter((s) => s.portTier > 0)
    const worldLinks = links.filter((l) => l.bType === 'w')
    expect(worldLinks).toHaveLength(ports.length)

    for (const p of ports) {
      const link = worldLinks.find((l) => l.aId === p.id)
      expect(link).toBeDefined()
      expect(link.tier).toBe(p.portTier)
    }
  })

  it.each(SEEDS)('%s: every link has a unique id and a valid mode/tier', (seed) => {
    const { links } = generate(seed)
    const ids = new Set(links.map((l) => l.id))
    expect(ids.size).toBe(links.length)

    for (const l of links) {
      expect(['road', 'rail', 'sea']).toContain(l.mode)
      expect(l.tier).toBeGreaterThanOrEqual(0)
      expect(l.lengthMi).toBeGreaterThanOrEqual(0)
    }
  })

  it.each(SEEDS)('%s: the same seed produces the same link network', (seed) => {
    const first = generate(seed)
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
    const second = generateLinks(grid, seed, mapgenRules, terrainRules, settlements)

    expect(second).toEqual(first.links)
  })
})

describe('findPath', () => {
  it('finds a straight path across an open grid', () => {
    const grid = createWorldGrid(5, 1, 2)
    const result = findPath(grid, 0, 4, () => true, (_f, _t, d) => d)
    expect(result).not.toBeNull()
    expect(result.cells[0]).toBe(0)
    expect(result.cells[result.cells.length - 1]).toBe(4)
  })

  it('returns null when the goal is unreachable', () => {
    const grid = createWorldGrid(5, 1, 2)
    const result = findPath(grid, 0, 4, (i) => i !== 2, (_f, _t, d) => d)
    expect(result).toBeNull()
  })

  it('routes around an impassable cell rather than through it', () => {
    const grid = createWorldGrid(3, 3, 2)
    const blocked = new Set([4]) // centre cell
    const result = findPath(grid, 0, 8, (i) => !blocked.has(i), (_f, _t, d) => d)
    expect(result).not.toBeNull()
    expect(result.cells).not.toContain(4)
  })
})
