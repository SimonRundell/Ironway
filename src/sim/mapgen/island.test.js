import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createWorldGrid } from './grid.js'
import { floodFillLandmasses, generateIsland } from './island.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
})

const cache = new Map()

/**
 * Generates an island for a seed and returns it with the cell counts
 * the property tests need. Memoised per seed: several `it.each` blocks
 * below check different properties of the same 20 generated islands,
 * and generation is the expensive part, not the checks.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object, elapsedMs: number, components: number[][], marginCells: number}}
 */
function generate(seed) {
  if (cache.has(seed)) {
    return cache.get(seed)
  }

  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  const start = Date.now()
  generateIsland(grid, seed, mapgenRules)
  const elapsedMs = Date.now() - start
  const components = floodFillLandmasses(grid)
  components.sort((a, b) => b.length - a.length)
  const marginCells = Math.floor(mapgenRules.islandMask.marginMiles / mapgenRules.grid.cellMiles)

  const result = { grid, elapsedMs, components, marginCells }
  cache.set(seed, result)
  return result
}

describe('generateIsland invariants (20 seeds)', () => {
  it.each(SEEDS)('%s: elev sign always agrees with water classification', (seed) => {
    const { grid } = generate(seed)
    for (let i = 0; i < grid.water.length; i++) {
      if (grid.water[i] === 0) {
        expect(grid.elev[i]).toBeGreaterThanOrEqual(1)
      } else {
        expect(grid.elev[i]).toBeLessThanOrEqual(-1)
      }
    }
  })
})

describe('generateIsland property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: land fraction is between 35%% and 50%%', (seed) => {
    const { grid } = generate(seed)
    let land = 0
    for (let i = 0; i < grid.water.length; i++) {
      if (grid.water[i] === 0) land++
    }
    const fraction = land / grid.water.length
    expect(fraction).toBeGreaterThanOrEqual(0.35)
    expect(fraction).toBeLessThanOrEqual(0.50)
  })

  it.each(SEEDS)('%s: exactly one major landmass, any others are small islets', (seed) => {
    const { components } = generate(seed)
    expect(components.length).toBeGreaterThanOrEqual(1)
    expect(components.length).toBeLessThanOrEqual(1 + mapgenRules.seaLevel.maxIslets)

    for (const component of components.slice(1)) {
      expect(component.length).toBeLessThan(mapgenRules.seaLevel.maxIsletCells)
    }
  })

  it.each(SEEDS)('%s: at least one range reaches 40+ cells above the rock line', (seed) => {
    const { grid } = generate(seed)
    let rockCells = 0
    for (let i = 0; i < grid.elev.length; i++) {
      if (grid.elev[i] >= mapgenRules.soil.mountainLineMetres) rockCells++
    }
    expect(rockCells).toBeGreaterThanOrEqual(40)
  })

  it.each(SEEDS)('%s: no land within the edge margin', (seed) => {
    const { grid, marginCells } = generate(seed)
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (x < marginCells || x >= grid.width - marginCells || y < marginCells || y >= grid.height - marginCells) {
          expect(grid.water[y * grid.width + x]).toBe(1)
        }
      }
    }
  })

  it.each(SEEDS)('%s: generates in under 2 seconds', (seed) => {
    const { elapsedMs } = generate(seed)
    expect(elapsedMs).toBeLessThan(2000)
  })
})

/**
 * Generates a fresh, uncached island, for tests that must prove two
 * independent runs agree (reusing the memoised generate() here would
 * just compare an object to itself).
 *
 * @param {string} seed The save seed.
 * @returns {object} The generated grid.
 */
function generateFresh(seed) {
  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  generateIsland(grid, seed, mapgenRules)
  return grid
}

describe('generateIsland determinism', () => {
  it('produces byte-identical elev and water layers for the same seed', () => {
    const a = generateFresh('ironway-determinism')
    const b = generateFresh('ironway-determinism')
    expect([...a.elev]).toEqual([...b.elev])
    expect([...a.water]).toEqual([...b.water])
  })

  it('produces different islands for different seeds', () => {
    const a = generate('ironway-seed-a').grid
    const b = generate('ironway-seed-b').grid
    expect([...a.elev]).not.toEqual([...b.elev])
  })
})

describe('floodFillLandmasses', () => {
  it('finds two separate components on a synthetic grid', () => {
    // 5x3 grid: two separate 2-cell blobs of land (water=0), rest sea (water=1).
    // . . . . .
    // X X . X X
    // . . . . .
    const width = 5
    const height = 3
    const water = new Uint8Array(width * height).fill(1)
    water[1 * width + 0] = 0 // (0,1)
    water[1 * width + 1] = 0 // (1,1)
    water[1 * width + 3] = 0 // (3,1)
    water[1 * width + 4] = 0 // (4,1)

    const components = floodFillLandmasses({ width, height, water })
    components.sort((a, b) => b.length - a.length)

    expect(components).toHaveLength(2)
    expect(components[0]).toHaveLength(2)
    expect(components[1]).toHaveLength(2)
  })

  it('returns one component for a single connected blob, ignoring diagonal-only touches', () => {
    // 3x3 grid, land only at opposite corners (0,0) and (2,2): these
    // touch diagonally but not orthogonally, so 4-connectivity must
    // treat them as two separate single-cell components.
    const width = 3
    const height = 3
    const water = new Uint8Array(width * height).fill(1)
    water[0] = 0 // (0,0)
    water[8] = 0 // (2,2)

    const components = floodFillLandmasses({ width, height, water })
    expect(components).toHaveLength(2)
    expect(components[0]).toHaveLength(1)
    expect(components[1]).toHaveLength(1)
  })

  it('returns no components when there is no land', () => {
    const width = 4
    const height = 4
    const water = new Uint8Array(width * height).fill(1)
    expect(floodFillLandmasses({ width, height, water })).toHaveLength(0)
  })
})
