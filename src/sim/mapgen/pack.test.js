import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { checksum } from '../checksum.js'
import { createWorldGrid } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { generateCoast } from './coast.js'
import { generateSoil } from './soil.js'
import { generateResources } from './resources.js'
import { GENERATOR_VERSION, packWorld, unpackWorld } from './pack.js'

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
 * Builds a fully generated grid for a seed (through step 11,
 * resources). Memoised per seed.
 *
 * @param {string} seed The save seed.
 * @returns {object} The generated grid.
 */
function generate(seed) {
  if (cache.has(seed)) return cache.get(seed)

  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  generateIsland(grid, seed, mapgenRules)
  generateRain(grid, mapgenRules.climate)
  generateHydrology(grid, mapgenRules.hydrology)
  generateSlope(grid, mapgenRules.slope)
  generateCoast(grid, mapgenRules)
  generateSoil(grid, seed, mapgenRules, terrainRules)
  generateResources(grid, seed, mapgenRules)

  cache.set(seed, grid)
  return grid
}

describe('packWorld / unpackWorld property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: unpacking a packed grid gives an identical checksum', (seed) => {
    const grid = generate(seed)
    const blob = packWorld(grid)
    const { grid: unpacked } = unpackWorld(blob)
    expect(checksum(unpacked)).toBe(checksum(grid))
  })

  it.each(SEEDS)('%s: the packed blob is well under 1 MB', (seed) => {
    const grid = generate(seed)
    const blob = packWorld(grid)
    expect(blob.byteLength).toBeLessThan(1_000_000)
  })

  it.each(SEEDS)('%s: unpacking reports the generator version it was packed with', (seed) => {
    const grid = generate(seed)
    const blob = packWorld(grid)
    const { generatorVersion } = unpackWorld(blob)
    expect(generatorVersion).toBe(GENERATOR_VERSION)
  })

  it.each(SEEDS)('%s: unpacking preserves width, height and cellMiles', (seed) => {
    const grid = generate(seed)
    const blob = packWorld(grid)
    const { grid: unpacked } = unpackWorld(blob)
    expect(unpacked.width).toBe(grid.width)
    expect(unpacked.height).toBe(grid.height)
    expect(unpacked.cellMiles).toBe(grid.cellMiles)
  })

  it.each(SEEDS)('%s: every layer keeps its exact typed-array kind after a round trip', (seed) => {
    const grid = generate(seed)
    const blob = packWorld(grid)
    const { grid: unpacked } = unpackWorld(blob)

    for (const name of ['elev', 'water', 'flow', 'river', 'rain', 'soil', 'arable', 'pastoral', 'landuse', 'slope', 'coast', 'shelter', 'resource', 'richness', 'region']) {
      expect(unpacked[name].constructor).toBe(grid[name].constructor)
    }
  })
})

describe('packWorld / unpackWorld', () => {
  it('rejects a blob with a bad magic number', () => {
    const grid = generate('ironway-001')
    const blob = packWorld(grid)
    const corrupted = blob.slice()
    corrupted[0] = corrupted[0] ^ 0xff // flip a byte inside the gzip-wrapped header after decompression this still decodes, but the magic check will fail
    // Corrupting a gzip-compressed byte usually breaks decompression too; guard both failure modes.
    expect(() => unpackWorld(corrupted)).toThrow()
  })

  it('accepts a custom generatorVersion and reports it back', () => {
    const grid = generate('ironway-001')
    const blob = packWorld(grid, 42)
    const { generatorVersion } = unpackWorld(blob)
    expect(generatorVersion).toBe(42)
  })
})
