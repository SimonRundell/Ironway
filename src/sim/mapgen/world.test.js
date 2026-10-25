import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { checksum } from '../checksum.js'
import { generateWorld } from './world.js'
import { packWorld, unpackWorld } from './pack.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

/** @type {Record<string, string>} Golden world checksums, committed so an accidental generator change is caught (DESIGN 11). */
const GOLDEN_CHECKSUMS = {
  // Regenerated after fixing computeBuildableMask() (src/sim/mapgen/
  // settlements.js): a cell sitting on a river channel (grid.river >=
  // riverMinWidthClass) is no longer "buildable" at all, for settlements
  // or any industry. Previously only the `river` siteRule's own
  // isNearRiver() check ever looked at grid.river — everything else
  // (settlement scoring, `town:`/`resource:`-sited industries) had no
  // river awareness whatsoever, so a town or a non-river-sited industry
  // could, and in practice often did, land directly on the river's own
  // channel. A genuine placement behaviour change, not just a schema
  // addition, so settlement and industry positions legitimately differ
  // from the previous golden run.
  'ironway-001': '756cef79db573447',
  'ironway-002': '6f93d9a0e6ce2123',
  'ironway-003': 'e64dcdea9b15ecaf',
  'ironway-004': 'e74500d443284e3a',
  'ironway-005': 'cfb1316a55734353',
}

let rules
const cache = new Map()

beforeAll(async () => {
  rules = await loadRulesNode('public/data')
})

/**
 * Runs generateWorld() for a seed. Memoised per seed since several
 * `it.each` blocks check different properties of the same 20 worlds.
 *
 * @param {string} seed The save seed.
 * @returns {{world: import('../state.js').World, attempt: number, generationTimeMs: number}}
 */
function generate(seed) {
  if (cache.has(seed)) return cache.get(seed)
  const result = generateWorld(seed, 'normal', rules)
  cache.set(seed, result)
  return result
}

describe('generateWorld property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: generates and validates within 5 seconds', (seed) => {
    const { generationTimeMs } = generate(seed)
    expect(generationTimeMs).toBeLessThan(5000)
  })

  it.each(SEEDS)('%s: pack then unpack the world grid equals the original by checksum', (seed) => {
    const { world } = generate(seed)
    const blob = packWorld(world.grid)
    const { grid: unpacked } = unpackWorld(blob)
    expect(checksum(unpacked)).toBe(checksum(world.grid))
  })

  it.each(SEEDS)('%s: the packed blob is well under 1 MB', (seed) => {
    const { world } = generate(seed)
    const blob = packWorld(world.grid)
    expect(blob.byteLength).toBeLessThan(1_000_000)
  })

  it.each(SEEDS)('%s: world.meta records the seed, attempt and generator version', (seed) => {
    const { world, attempt } = generate(seed)
    expect(world.meta.seed).toBe(seed)
    expect(world.meta.attempt).toBe(attempt)
    expect(world.meta.generatorVersion).toBeGreaterThan(0)
    expect(world.meta.difficulty).toBe('normal')
  })

  it.each(SEEDS)('%s: every link id is unique across the merged main and tramway lists', (seed) => {
    const { world } = generate(seed)
    const ids = new Set(world.links.map((l) => l.id))
    expect(ids.size).toBe(world.links.length)
  })

  it.each(SEEDS)('%s: world.names has an island name and one bay/range name per detected region', (seed) => {
    const { world } = generate(seed)
    expect(world.names.island.length).toBeGreaterThan(0)
    expect(Array.isArray(world.names.bays)).toBe(true)
    expect(Array.isArray(world.names.ranges)).toBe(true)
    for (const name of [...world.names.bays, ...world.names.ranges]) {
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it.each(SEEDS)('%s: the same seed produces the same world (by checksum)', (seed) => {
    const first = generate(seed)
    const second = generateWorld(seed, 'normal', rules)
    expect(checksum(second.world)).toBe(checksum(first.world))
  })
})

describe('generateWorld golden checksums', () => {
  it.each(Object.keys(GOLDEN_CHECKSUMS))('%s matches its committed golden checksum', (seed) => {
    const { world } = generate(seed)
    expect(checksum(world)).toBe(GOLDEN_CHECKSUMS[seed])
  })
})

describe('generateWorld', () => {
  it('throws on an unknown difficulty', () => {
    expect(() => generateWorld('ironway-001', 'nonsense', rules)).toThrow(/unknown difficulty/)
  })

  it('scales starting population by difficulty', () => {
    const { world: normalWorld } = generateWorld('ironway-001', 'normal', rules)
    const { world: easyWorld } = generateWorld('ironway-001', 'easy', rules)

    const totalPop = (world) => world.settlements.reduce(
      (sum, s) => sum + Object.values(s.pop).reduce((a, c) => a + c.pop, 0),
      0,
    )

    const normalDifficulty = rules.difficulty.find((d) => d.id === 'normal')
    const easyDifficulty = rules.difficulty.find((d) => d.id === 'easy')
    expect(easyDifficulty.startingPopulationScale).toBeGreaterThan(normalDifficulty.startingPopulationScale)
    expect(totalPop(easyWorld)).toBeGreaterThan(totalPop(normalWorld))
  })
})
