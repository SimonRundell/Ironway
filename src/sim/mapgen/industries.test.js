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
import { generateSettlements, computeBuildableMask } from './settlements.js'
import { generateLinks } from './links.js'
import { generateIndustries, evaluateSiteRule, buildSitingContext } from './industries.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)
const START_YEAR = 1830

let mapgenRules
let settlementsRules
let terrainRules
let classesRules
let namesRules
let industriesCatalogue
const cache = new Map()

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
  settlementsRules = rules.settlements
  terrainRules = rules.terrain
  classesRules = rules.classes
  namesRules = rules.names
  industriesCatalogue = rules.industries
})

/**
 * Collects every cargo id an industry's `inputs` reference, across
 * both plain `{cargo, qty}` requirements and `{any: {...}}` groups.
 *
 * @param {object[]} inputs An industry's `inputs` array.
 * @returns {Set<string>} Referenced cargo ids.
 */
function inputCargoIds(inputs) {
  const ids = new Set()
  for (const req of inputs) {
    if (req.cargo) ids.add(req.cargo)
    if (req.any) Object.keys(req.any).forEach((id) => ids.add(id))
  }
  return ids
}

/**
 * Runs the full pipeline through industry generation for a seed.
 * Memoised per seed since several `it.each` blocks check different
 * properties of the same 20 generated islands.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object, settlements: import('../state.js').Settlement[], industries: import('../state.js').Industry[], tramwayLinks: import('../state.js').Link[]}}
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
  const nameGen = createNameGenerator(seed, namesRules)
  const settlements = generateSettlements(grid, seed, mapgenRules, settlementsRules, terrainRules, classesRules, nameGen)
  const mainLinks = generateLinks(grid, seed, mapgenRules, terrainRules, settlements)
  const { industries, tramwayLinks } = generateIndustries(grid, seed, mapgenRules, industriesCatalogue, terrainRules, settlements, deposits, START_YEAR, mainLinks)

  const result = { grid, settlements, industries, tramwayLinks, mainLinks }
  cache.set(seed, result)
  return result
}

describe('generateIndustries property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: every industry satisfies at least one of its own siting rules', (seed) => {
    const { grid, settlements, industries } = generate(seed)
    const ctx = buildSitingContext(grid, mapgenRules, terrainRules, industriesCatalogue, settlements)
    const defById = new Map(industriesCatalogue.map((d) => [d.id, d]))

    for (const ind of industries) {
      const def = defById.get(ind.typeId)
      const i = indexOf(grid, Math.round(ind.x / grid.cellMiles), Math.round(ind.y / grid.cellMiles))
      const satisfied = def.siteRules.some((rule) => evaluateSiteRule(rule, i, ctx))
      expect(satisfied).toBe(true)
    }
  })

  it.each(SEEDS)('%s: no industry is placed before its eraFrom or after its eraTo', (seed) => {
    const { industries } = generate(seed)
    const defById = new Map(industriesCatalogue.map((d) => [d.id, d]))

    for (const ind of industries) {
      const def = defById.get(ind.typeId)
      expect(def.eraFrom).toBeLessThanOrEqual(START_YEAR)
      if (def.eraTo != null) expect(START_YEAR).toBeLessThanOrEqual(def.eraTo)
    }
  })

  it.each(SEEDS)('%s: every industry has a home settlement within 10 miles', (seed) => {
    const { settlements, industries } = generate(seed)
    const settlementById = new Map(settlements.map((s) => [s.id, s]))

    for (const ind of industries) {
      expect(ind.homeSettlementId).not.toBe(0)
      const home = settlementById.get(ind.homeSettlementId)
      expect(home).toBeDefined()
      const d = Math.sqrt((ind.x - home.x) ** 2 + (ind.y - home.y) ** 2)
      expect(d).toBeLessThanOrEqual(mapgenRules.industries.homeSettlementRadiusMiles + 0.01)
    }
  })

  it.each(SEEDS)('%s: no two industries sit on the same cell', (seed) => {
    const { grid, industries } = generate(seed)
    const cells = new Set()
    for (const ind of industries) {
      const i = indexOf(grid, Math.round(ind.x / grid.cellMiles), Math.round(ind.y / grid.cellMiles))
      expect(cells.has(i)).toBe(false)
      cells.add(i)
    }
  })

  it.each(SEEDS)('%s: every industry has a unique id', (seed) => {
    const { industries } = generate(seed)
    const ids = new Set(industries.map((ind) => ind.id))
    expect(ids.size).toBe(industries.length)
  })

  it.each(SEEDS)('%s: each primary cargo has at least 2 plausible downstream sites', (seed) => {
    const { grid, settlements, industries } = generate(seed)
    const ctx = buildSitingContext(grid, mapgenRules, terrainRules, industriesCatalogue, settlements)
    const buildable = computeBuildableMask(grid, terrainRules)

    const primaryCargoes = new Set()
    for (const def of industriesCatalogue) {
      if (def.tier === 'primary') Object.keys(def.outputs).forEach((c) => primaryCargoes.add(c))
    }

    for (const cargo of primaryCargoes) {
      const consumers = industriesCatalogue.filter((def) => inputCargoIds(def.inputs).has(cargo))
      if (consumers.length === 0) continue // nothing in the catalogue consumes this cargo; not this test's concern

      let plausibleSites = 0
      for (const consumer of consumers) {
        for (let i = 0; i < buildable.length && plausibleSites < 2; i++) {
          if (!buildable[i]) continue
          if (consumer.siteRules.some((rule) => evaluateSiteRule(rule, i, ctx))) plausibleSites++
        }
        if (plausibleSites >= 2) break
      }

      expect(plausibleSites).toBeGreaterThanOrEqual(2)
    }

    // Sanity check the industries placed this run exist, so this test
    // isn't vacuously exercising an empty island.
    expect(industries.length).toBeGreaterThan(0)
  })

  it.each(SEEDS)('%s: every colliery tramway connects a real mine to a real settlement', (seed) => {
    const { settlements, industries, tramwayLinks } = generate(seed)
    const industryIds = new Set(industries.map((ind) => ind.id))
    const settlementIds = new Set(settlements.map((s) => s.id))

    for (const link of tramwayLinks) {
      expect(link.mode).toBe('rail')
      expect(link.tier).toBe(0)
      expect(link.aType).toBe('i')
      expect(industryIds.has(link.aId)).toBe(true)
      expect(link.bType).toBe('s')
      expect(settlementIds.has(link.bId)).toBe(true)
    }
  })

  it.each(SEEDS)('%s: main rail plus tramway mileage together is still at most 15% of road mileage', (seed) => {
    const { mainLinks, tramwayLinks } = generate(seed)
    const roadTotal = mainLinks.filter((l) => l.mode === 'road').reduce((sum, l) => sum + l.lengthMi, 0)
    const railTotal = mainLinks.filter((l) => l.mode === 'rail').reduce((sum, l) => sum + l.lengthMi, 0)
      + tramwayLinks.reduce((sum, l) => sum + l.lengthMi, 0)
    if (roadTotal === 0) return
    expect(railTotal / roadTotal).toBeLessThanOrEqual(mapgenRules.links.maxRailShareOfRoadMiles + 1e-9)
  })

  it.each(SEEDS)('%s: the same seed produces the same industries and tramways', (seed) => {
    const first = generate(seed)
    const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
    generateIsland(grid, seed, mapgenRules)
    generateRain(grid, mapgenRules.climate)
    generateHydrology(grid, mapgenRules.hydrology)
    generateSlope(grid, mapgenRules.slope)
    generateCoast(grid, mapgenRules)
    generateSoil(grid, seed, mapgenRules, terrainRules)
    const deposits = generateResources(grid, seed, mapgenRules)
    const nameGen = createNameGenerator(seed, namesRules)
    const settlements = generateSettlements(grid, seed, mapgenRules, settlementsRules, terrainRules, classesRules, nameGen)
    const mainLinks = generateLinks(grid, seed, mapgenRules, terrainRules, settlements)
    const second = generateIndustries(grid, seed, mapgenRules, industriesCatalogue, terrainRules, settlements, deposits, START_YEAR, mainLinks)

    expect(second.industries).toEqual(first.industries)
    expect(second.tramwayLinks).toEqual(first.tramwayLinks)
  })
})

describe('evaluateSiteRule', () => {
  it('resource:<id> matches only the deposit cell of that type', () => {
    const grid = createWorldGrid(3, 1, 2)
    grid.resource[0] = 1 // RESOURCE.COAL
    const ctx = { grid }
    expect(evaluateSiteRule('resource:coal', 0, ctx)).toBe(true)
    expect(evaluateSiteRule('resource:coal', 1, ctx)).toBe(false)
    expect(evaluateSiteRule('resource:iron', 0, ctx)).toBe(false)
  })

  it('coast matches only cells with the COASTAL flag', () => {
    const grid = createWorldGrid(2, 1, 2)
    grid.coast[0] = 1 // COAST_FLAG.COASTAL
    const ctx = { grid }
    expect(evaluateSiteRule('coast', 0, ctx)).toBe(true)
    expect(evaluateSiteRule('coast', 1, ctx)).toBe(false)
  })

  it('{any: [...]} matches if any sub-rule matches', () => {
    const grid = createWorldGrid(2, 1, 2)
    grid.coast[1] = 1
    const ctx = { grid }
    expect(evaluateSiteRule({ any: ['coast', 'resource:coal'] }, 1, ctx)).toBe(true)
    expect(evaluateSiteRule({ any: ['coast', 'resource:coal'] }, 0, ctx)).toBe(false)
  })

  it('near:<cargo> is a soft rule that always passes', () => {
    const grid = createWorldGrid(1, 1, 2)
    expect(evaluateSiteRule('near:clay', 0, { grid })).toBe(true)
  })
})
