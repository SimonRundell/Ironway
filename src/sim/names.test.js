import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from './rules.js'
import { createNameGenerator } from './names.js'

let namesRules

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  namesRules = rules.names
})

/**
 * Draws a mix of 500 names from one generator: 379 settlements (half
 * coastal, half inland), 40 rivers, 40 bays, 40 ranges and 1 island.
 * Comfortably inside every category's combinatorial capacity so the
 * uniqueness retry never has to work hard.
 *
 * @param {ReturnType<typeof createNameGenerator>} gen A name generator.
 * @returns {{all: string[], coastalSettlements: string[]}}
 */
function drawFiveHundred(gen) {
  const all = []
  const coastalSettlements = []

  for (let i = 0; i < 379; i++) {
    const isCoastal = i % 2 === 0
    const name = gen.settlementName(isCoastal)
    all.push(name)
    if (isCoastal) coastalSettlements.push(name)
  }
  for (let i = 0; i < 40; i++) all.push(gen.riverName())
  for (let i = 0; i < 40; i++) all.push(gen.bayName())
  for (let i = 0; i < 40; i++) all.push(gen.rangeName())
  all.push(gen.islandName())

  return { all, coastalSettlements }
}

describe('createNameGenerator property tests', () => {
  it('500 names for one seed are all unique (case-insensitive)', () => {
    const gen = createNameGenerator('ironway-001', namesRules)
    const { all } = drawFiveHundred(gen)
    expect(all).toHaveLength(500)

    const unique = new Set(all.map((name) => name.toLowerCase()))
    expect(unique.size).toBe(500)
  })

  it('none of 500 names are on the blocklist', () => {
    const gen = createNameGenerator('ironway-002', namesRules)
    const { all } = drawFiveHundred(gen)
    const blocklist = new Set(namesRules.blocklist.map((name) => name.toLowerCase()))

    for (const name of all) {
      expect(blocklist.has(name.toLowerCase())).toBe(false)
    }
  })

  it('coastal settlements show a coastal ending in at least 60% of cases', () => {
    const gen = createNameGenerator('ironway-003', namesRules)
    const { coastalSettlements } = drawFiveHundred(gen)
    const coastalEndings = namesRules.coastalEndings.map((ending) => ending.toLowerCase())

    const matches = coastalSettlements.filter((name) => {
      const bare = name.replace(/^.+ /, '') // drop a leading prefix word, if any
      return coastalEndings.some((ending) => bare.toLowerCase().endsWith(ending))
    })

    expect(matches.length / coastalSettlements.length).toBeGreaterThanOrEqual(0.6)
  })

  it('the same seed gives the same names, in the same call order', () => {
    const a = createNameGenerator('ironway-004', namesRules)
    const b = createNameGenerator('ironway-004', namesRules)

    const seqA = [a.settlementName(true), a.settlementName(false), a.riverName(), a.bayName(), a.rangeName(), a.islandName()]
    const seqB = [b.settlementName(true), b.settlementName(false), b.riverName(), b.bayName(), b.rangeName(), b.islandName()]

    expect(seqA).toEqual(seqB)
  })

  it('different seeds give different name sequences', () => {
    const a = createNameGenerator('ironway-005', namesRules)
    const b = createNameGenerator('ironway-006', namesRules)
    expect(a.islandName()).not.toBe(b.islandName())
  })

  it('a settlement name only ever carries a coastal ending when asked for one', () => {
    const gen = createNameGenerator('ironway-007', namesRules)
    const coastalEndings = namesRules.coastalEndings.map((ending) => ending.toLowerCase())

    for (let i = 0; i < 100; i++) {
      const name = gen.settlementName(false)
      const bare = name.replace(/^.+ /, '')
      const hasCoastalEnding = coastalEndings.some((ending) => bare.toLowerCase().endsWith(ending))
      expect(hasCoastalEnding).toBe(false)
    }
  })

  it('river names with an empty suffix are the bare stem', () => {
    const fixture = { ...namesRules, riverStems: ['Otter'], riverSuffixes: [''] }
    const gen = createNameGenerator('ironway-008', fixture)
    expect(gen.riverName()).toBe('Otter')
  })

  it('retries past a blocklisted candidate to find an allowed name', () => {
    const fixture = {
      ...namesRules,
      islandNameStems: ['York', 'Aver'],
      islandNameSuffixes: [''],
      blocklist: ['York'],
    }
    const gen = createNameGenerator('ironway-009', fixture)
    expect(gen.islandName()).toBe('Aver')
  })

  it('throws once a category runs out of unique, non-blocklisted names', () => {
    const fixture = { ...namesRules, islandNameStems: ['Aver'], islandNameSuffixes: [''], maxAttempts: 5 }
    const gen = createNameGenerator('ironway-010', fixture)
    gen.islandName()
    expect(() => gen.islandName()).toThrow(/could not draw/)
  })
})
