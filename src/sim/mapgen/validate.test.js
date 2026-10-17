import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createNameGenerator } from '../names.js'
import { createWorldGrid } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { generateCoast } from './coast.js'
import { generateSoil } from './soil.js'
import { generateResources } from './resources.js'
import { generateSettlements } from './settlements.js'
import { generateLinks } from './links.js'
import { generateIndustries } from './industries.js'
import { validateWorld } from './validate.js'

let mapgenRules
let terrainRules
let settlementsRules
let classesRules
let namesRules
let industriesCatalogue
let baseline

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
  terrainRules = rules.terrain
  settlementsRules = rules.settlements
  classesRules = rules.classes
  namesRules = rules.names
  industriesCatalogue = rules.industries

  const seed = 'ironway-001'
  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  generateIsland(grid, seed, mapgenRules)
  generateRain(grid, mapgenRules.climate)
  const { flowTo } = generateHydrology(grid, mapgenRules.hydrology)
  generateSlope(grid, mapgenRules.slope)
  const { harbourCandidates } = generateCoast(grid, mapgenRules)
  generateSoil(grid, seed, mapgenRules, terrainRules)
  const deposits = generateResources(grid, seed, mapgenRules)
  const nameGen = createNameGenerator(seed, namesRules)
  const settlements = generateSettlements(grid, seed, mapgenRules, settlementsRules, terrainRules, classesRules, nameGen)
  const mainLinks = generateLinks(grid, seed, mapgenRules, terrainRules, settlements)
  const { industries, tramwayLinks } = generateIndustries(grid, seed, mapgenRules, industriesCatalogue, terrainRules, settlements, deposits, 1830, mainLinks)
  const links = [...mainLinks, ...tramwayLinks]

  baseline = {
    grid, flowTo, harbourCandidates, settlements, links, deposits,
    generationTimeMs: 200, mapgenRules, terrainRules, settlementsRules,
  }
})

describe('validateWorld', () => {
  it('passes on a real, freshly generated world', () => {
    const { valid, errors } = validateWorld(baseline)
    expect(valid).toBe(true)
    expect(errors).toEqual([])
  })

  it('fails on land fraction when almost everything is forced to sea', () => {
    const water = baseline.grid.water.slice()
    for (let i = 0; i < water.length; i++) if (i % 20 !== 0) water[i] = 1
    const ctx = { ...baseline, grid: { ...baseline.grid, water } }

    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('land fraction'))).toBe(true)
  })

  it('fails on rivers when the river layer is wiped', () => {
    const river = new Uint8Array(baseline.grid.river.length)
    const ctx = { ...baseline, grid: { ...baseline.grid, river } }

    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('rivers over'))).toBe(true)
  })

  it('fails on rock cells when the landuse layer has none', () => {
    const rockIndex = terrainRules.landuseEnum.indexOf('rock')
    const forestIndex = terrainRules.landuseEnum.indexOf('forest')
    const landuse = baseline.grid.landuse.slice()
    for (let i = 0; i < landuse.length; i++) if (landuse[i] === rockIndex) landuse[i] = forestIndex
    const ctx = { ...baseline, grid: { ...baseline.grid, landuse } }

    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('rock cells'))).toBe(true)
  })

  it('fails on harbours when there are none', () => {
    const ctx = { ...baseline, harbourCandidates: [] }
    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('harbour candidates'))).toBe(true)
  })

  it('fails on land-use shares when arable is reclassified away', () => {
    const arableIndex = terrainRules.landuseEnum.indexOf('arable')
    const moorIndex = terrainRules.landuseEnum.indexOf('moor')
    const landuse = baseline.grid.landuse.slice()
    for (let i = 0; i < landuse.length; i++) if (landuse[i] === arableIndex) landuse[i] = moorIndex
    const ctx = { ...baseline, grid: { ...baseline.grid, landuse } }

    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('arable'))).toBe(true)
  })

  it('fails on settlement counts and capital presence when there are none', () => {
    const ctx = { ...baseline, settlements: [] }
    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('no capital was placed'))).toBe(true)
  })

  it('fails on connectivity when there are no road links at all', () => {
    const ctx = { ...baseline, links: baseline.links.filter((l) => l.mode !== 'road') }
    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('not reachable from the capital by road'))).toBe(true)
  })

  it('fails on resource guarantees when deposits are empty', () => {
    const ctx = { ...baseline, deposits: { coal: [], iron: [], stone: [], clay: [] } }
    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('coal deposits'))).toBe(true)
    expect(errors.some((e) => e.includes('coal-iron pairs'))).toBe(true)
  })

  it('fails on generation time when it is over the limit', () => {
    const ctx = { ...baseline, generationTimeMs: mapgenRules.validation.generationTimeLimitSeconds * 1000 + 1 }
    const { valid, errors } = validateWorld(ctx)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('generation took'))).toBe(true)
  })
})
