import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from './rules.js'
import { generateWorld } from './mapgen/world.js'
import { createGameState } from './state.js'
import { checksum } from './checksum.js'
import { runYears } from './tick.js'

/**
 * T1.24's own "Done when" fixture (PHASES.md): a full run of 10 years
 * on a generated world completes without NaN, checksum is identical
 * across two independent runs, and history rows exist for every month.
 */

const SEED = 'ironway-001'
const DIFFICULTY_ID = 'normal'
const YEARS = 10
const EXPECTED_MONTHS = YEARS * 12

let rules

beforeAll(async () => {
  rules = await loadRulesNode('public/data')
})

/** @returns {{world: import('./state.js').World, gameState: import('./state.js').GameState}} A freshly generated world and a fresh starting GameState built from it. */
function freshGame(seed) {
  const { world } = generateWorld(seed, DIFFICULTY_ID, rules)
  const difficultyDef = rules.difficulty.find((d) => d.id === DIFFICULTY_ID)

  const gameState = createGameState(
    world.settlements,
    world.industries,
    world.links,
    { level: rules.economy.startingEconomyLevel, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
    { name: 'Test Co', cash: difficultyDef.startingCash, loans: 0, rankKey: 'novice', stats: {} },
    [],
    [],
  )

  return { world, gameState }
}

/** @param {*} value @returns {string[]} Dotted paths to every non-finite number found under `value`. */
function findNonFinite(value, path = '$') {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path]
  if (Array.isArray(value)) return value.flatMap((item, i) => findNonFinite(item, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findNonFinite(item, `${path}.${key}`))
  }
  return []
}

/** @param {import('./state.js').GameState} gameState @returns {string[]} Dotted paths to every negative stock value found (DESIGN 11's own "no negative stock" property-test requirement). */
function findNegativeStock(gameState) {
  const offenders = []
  for (const settlement of gameState.settlements) {
    for (const [cargo, qty] of Object.entries(settlement.stock)) {
      if (qty < 0) offenders.push(`settlement:${settlement.id}.stock.${cargo}`)
    }
  }
  for (const industry of gameState.industries) {
    for (const [cargo, qty] of Object.entries(industry.stock)) {
      if (qty < 0) offenders.push(`industry:${industry.id}.stock.${cargo}`)
    }
  }
  return offenders
}

describe('T1.24 fixture: a 10-year run on a generated world', () => {
  it('completes without producing any NaN or Infinity', () => {
    const { world, gameState } = freshGame(SEED)
    runYears({ world, gameState, rules, seed: SEED, gameDay: 0 }, YEARS)

    const offenders = findNonFinite(gameState)
    expect(offenders).toEqual([])
  }, 30000)

  it('never produces negative stock', () => {
    const { world, gameState } = freshGame(SEED)
    runYears({ world, gameState, rules, seed: SEED, gameDay: 0 }, YEARS)

    expect(findNegativeStock(gameState)).toEqual([])
  }, 30000)

  it('produces one history row for every month', () => {
    const { world, gameState } = freshGame(SEED)
    runYears({ world, gameState, rules, seed: SEED, gameDay: 0 }, YEARS)

    expect(gameState.historyMonthly).toHaveLength(EXPECTED_MONTHS)
    gameState.historyMonthly.forEach((row, i) => expect(row.monthIndex).toBe(i))
  }, 30000)

  it('is deterministic: two independent runs from the same seed produce an identical checksum', () => {
    const run1 = freshGame(SEED)
    runYears({ world: run1.world, gameState: run1.gameState, rules, seed: SEED, gameDay: 0 }, YEARS)

    const run2 = freshGame(SEED)
    runYears({ world: run2.world, gameState: run2.gameState, rules, seed: SEED, gameDay: 0 }, YEARS)

    expect(checksum(run1.gameState)).toBe(checksum(run2.gameState))
  }, 30000)
})
