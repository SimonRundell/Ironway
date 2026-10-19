#!/usr/bin/env node
/**
 * Headless balance harness (T1.25, DESIGN 11): runs the real monthly
 * tick pipeline for N years with no player action on one or more
 * seeds, prints a CSV of population by class, employment, economy
 * level, price-multiplier health, closures and openings, and checks
 * every number against the Phase 1 gate in DESIGN 11:
 *
 *   - no NaN anywhere in the resulting state
 *   - final island population between 0.5x and 6x the starting population
 *   - mean employment rate between 60 and 98 percent across the whole run
 *   - at least 90 percent of price-multiplier samples strictly inside
 *     (pMin, pMax), with no more than 25 percent sitting exactly on a bound
 *   - under 60 seconds per 50-year run
 *
 * Usage:
 *   node scripts/balance.mjs [--seeds ironway-001,ironway-002] [--years 50] [--difficulty normal] [--csv path/to/out.csv]
 *
 * With no arguments, runs the Phase 1 gate exactly as DESIGN 11 states
 * it: 50 years on the five golden seeds. The CSV goes to stdout unless
 * `--csv` names a file; the pass/fail report always goes to stderr, so
 * `node scripts/balance.mjs > out.csv` captures a clean CSV.
 */

import { writeFileSync } from 'node:fs'
import { loadRulesNode } from '../src/sim/rules.js'
import { generateWorld } from '../src/sim/mapgen/world.js'
import { createGameState } from '../src/sim/state.js'
import { createTickCaches, runMonth, runYearEnd } from '../src/sim/tick.js'
import { advanceDays, DAYS_PER_YEAR } from '../src/sim/clock.js'

const DEFAULT_SEEDS = ['ironway-001', 'ironway-002', 'ironway-003', 'ironway-004', 'ironway-005']
const DEFAULT_YEARS = 50
const DEFAULT_DIFFICULTY = 'normal'
const MAX_SECONDS_PER_RUN = 60
const POP_RATIO_MIN = 0.5
const POP_RATIO_MAX = 6
const EMPLOYMENT_MIN = 0.60
const EMPLOYMENT_MAX = 0.98
const PRICE_INSIDE_MIN = 0.90
const PRICE_AT_BOUND_MAX = 0.25

const CSV_COLUMNS = [
  'seed', 'month', 'gameDay', 'year',
  'popWorking', 'popMiddle', 'popUpper', 'popTotal',
  'employment', 'confidence', 'level', 'tradeValue',
  'industriesOpen', 'opened', 'closed',
  'priceAtBoundFraction',
]

/** @returns {{seeds: string[], years: number, difficulty: string, csvPath: string|null}} Parsed CLI options. */
function parseArgs(argv) {
  const options = { seeds: DEFAULT_SEEDS, years: DEFAULT_YEARS, difficulty: DEFAULT_DIFFICULTY, csvPath: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seeds') options.seeds = argv[++i].split(',').map((s) => s.trim())
    else if (arg === '--years') options.years = Number(argv[++i])
    else if (arg === '--difficulty') options.difficulty = argv[++i]
    else if (arg === '--csv') options.csvPath = argv[++i]
  }
  return options
}

/** @param {*} value @returns {boolean} Whether `value` contains any non-finite number anywhere, recursively. */
function hasNonFinite(value) {
  if (typeof value === 'number') return !Number.isFinite(value)
  if (Array.isArray(value)) return value.some((item) => hasNonFinite(item))
  if (value && typeof value === 'object') return Object.values(value).some((item) => hasNonFinite(item))
  return false
}

/**
 * Runs one seed's full balance scenario: generates a world, runs
 * `years` of monthly ticks with no player action, and returns both the
 * per-month CSV rows and the gate verdicts.
 *
 * @param {string} seed
 * @param {number} years
 * @param {string} difficulty
 * @param {object} rules
 * @returns {{rows: object[], gate: object, elapsedMs: number}}
 */
function runSeed(seed, years, difficulty, rules) {
  const startedAt = performance.now()

  const { world } = generateWorld(seed, difficulty, rules)
  const difficultyDef = rules.difficulty.find((d) => d.id === difficulty)
  const gameState = createGameState(
    world.settlements,
    world.industries,
    world.links,
    { level: rules.economy.startingEconomyLevel, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
    { name: 'Balance harness', cash: difficultyDef.startingCash, loans: 0, rankKey: 'novice', stats: {} },
    [],
    [],
  )
  const caches = createTickCaches(world, gameState, rules)
  const { classIdByIndex } = caches

  const startPop = gameState.settlements.reduce((sum, s) => (
    sum + [...classIdByIndex.keys()].reduce((inner, index) => inner + (s.pop[index]?.pop || 0), 0)
  ), 0)

  const rows = []
  let lastEventsCount = 0

  advanceDays(0, years * DAYS_PER_YEAR, {
    onMonth: (gameDay) => {
      runMonth({ world, gameState, rules, seed, gameDay, caches })

      const row = gameState.historyMonthly[gameState.historyMonthly.length - 1]
      const monthsSinceEvents = gameState.eventsLog.slice(lastEventsCount)
      lastEventsCount = gameState.eventsLog.length

      const popByClass = { working: 0, middle: 0, upper: 0 }
      for (const settlement of gameState.settlements) {
        for (const [index, classId] of classIdByIndex) popByClass[classId] += settlement.pop[index]?.pop || 0
      }

      rows.push({
        seed,
        month: rows.length + 1,
        gameDay,
        year: world.meta.startYear + Math.floor(gameDay / DAYS_PER_YEAR),
        popWorking: popByClass.working,
        popMiddle: popByClass.middle,
        popUpper: popByClass.upper,
        popTotal: row.popTotal,
        employment: row.employment,
        confidence: row.confidence,
        level: row.level,
        tradeValue: row.tradeValue,
        industriesOpen: gameState.industries.filter((i) => i.closedDay === null).length,
        opened: monthsSinceEvents.filter((e) => e.kind === 'industry_opened').length,
        closed: monthsSinceEvents.filter((e) => e.kind === 'industry_closed').length,
        priceAtBoundFraction: row.extra.priceMultiplierSamples > 0 ? row.extra.priceMultiplierAtBound / row.extra.priceMultiplierSamples : 0,
      })
    },
    onYearEnd: () => runYearEnd(gameState, caches, rules),
  })

  const elapsedMs = performance.now() - startedAt

  const finalPop = rows[rows.length - 1].popTotal
  const popRatio = startPop > 0 ? finalPop / startPop : 0
  const meanEmployment = rows.reduce((sum, r) => sum + r.employment, 0) / rows.length
  const totalPriceSamples = gameState.historyMonthly.reduce((sum, r) => sum + (r.extra.priceMultiplierSamples || 0), 0)
  const totalPriceAtBound = gameState.historyMonthly.reduce((sum, r) => sum + (r.extra.priceMultiplierAtBound || 0), 0)
  const priceAtBoundFraction = totalPriceSamples > 0 ? totalPriceAtBound / totalPriceSamples : 0
  const priceInsideFraction = 1 - priceAtBoundFraction

  const gate = {
    noNaN: !hasNonFinite(gameState),
    popRatio,
    popRatioOk: popRatio >= POP_RATIO_MIN && popRatio <= POP_RATIO_MAX,
    meanEmployment,
    meanEmploymentOk: meanEmployment >= EMPLOYMENT_MIN && meanEmployment <= EMPLOYMENT_MAX,
    priceInsideFraction,
    priceInsideOk: priceInsideFraction >= PRICE_INSIDE_MIN,
    priceAtBoundFraction,
    priceAtBoundOk: priceAtBoundFraction <= PRICE_AT_BOUND_MAX,
    elapsedMs,
    elapsedOk: elapsedMs <= MAX_SECONDS_PER_RUN * 1000,
  }
  gate.pass = gate.noNaN && gate.popRatioOk && gate.meanEmploymentOk && gate.priceInsideOk && gate.priceAtBoundOk && gate.elapsedOk

  return { rows, gate, elapsedMs }
}

async function main() {
  const { seeds, years, difficulty, csvPath } = parseArgs(process.argv.slice(2))
  const rules = await loadRulesNode('public/data')

  const csvLines = [CSV_COLUMNS.join(',')]
  let allPass = true

  for (const seed of seeds) {
    const { rows, gate } = runSeed(seed, years, difficulty, rules)
    for (const row of rows) csvLines.push(CSV_COLUMNS.map((c) => row[c]).join(','))

    allPass &&= gate.pass
    console.error(`${seed}: ${gate.pass ? 'PASS' : 'FAIL'} (${(gate.elapsedMs / 1000).toFixed(1)}s)`)
    console.error(`  no NaN: ${gate.noNaN}`)
    console.error(`  population ratio: ${gate.popRatio.toFixed(2)}x (need 0.5-6x) ${gate.popRatioOk ? 'ok' : 'FAIL'}`)
    console.error(`  mean employment: ${(gate.meanEmployment * 100).toFixed(1)}% (need 60-98%) ${gate.meanEmploymentOk ? 'ok' : 'FAIL'}`)
    console.error(`  price multipliers strictly inside bounds: ${(gate.priceInsideFraction * 100).toFixed(1)}% (need >=90%) ${gate.priceInsideOk ? 'ok' : 'FAIL'}`)
    console.error(`  price multipliers at a bound: ${(gate.priceAtBoundFraction * 100).toFixed(1)}% (need <=25%) ${gate.priceAtBoundOk ? 'ok' : 'FAIL'}`)
    console.error(`  time per run: ${(gate.elapsedMs / 1000).toFixed(1)}s (need <=${MAX_SECONDS_PER_RUN}s) ${gate.elapsedOk ? 'ok' : 'FAIL'}`)
  }

  console.error(allPass ? 'PHASE 1 GATE: PASS on every seed' : 'PHASE 1 GATE: FAIL on at least one seed')

  const csv = csvLines.join('\n') + '\n'
  if (csvPath) writeFileSync(csvPath, csv)
  else process.stdout.write(csv)

  process.exit(allPass ? 0 : 1)
}

main()
