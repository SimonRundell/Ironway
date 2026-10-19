#!/usr/bin/env node
/**
 * Scratch debug script (not part of the test suite): runs a handful of
 * months of the real tick.js pipeline against a freshly generated
 * world, printing progress and failing loudly on the first thrown
 * error, so bugs show up with a clean stack trace instead of buried in
 * a vitest fixture.
 *
 * Usage: node scripts/tick-smoke-test.mjs [months]
 */

import { loadRulesNode } from '../src/sim/rules.js'
import { generateWorld } from '../src/sim/mapgen/world.js'
import { createGameState } from '../src/sim/state.js'
import { createTickCaches, runMonth } from '../src/sim/tick.js'

const months = Number(process.argv[2] ?? 12)

const rules = await loadRulesNode('public/data')
const difficultyId = 'normal'
const { world } = generateWorld('ironway-001', difficultyId, rules)
const difficultyDef = rules.difficulty.find((d) => d.id === difficultyId)

const gameState = createGameState(
  world.settlements,
  world.industries,
  world.links,
  { level: rules.economy.startingEconomyLevel, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
  { name: 'Test Co', cash: difficultyDef.startingCash, loans: 0, rankKey: 'novice', stats: {} },
  [],
  [],
)

const caches = createTickCaches(world, gameState, rules)

let gameDay = 0
for (let month = 1; month <= months; month++) {
  gameDay += 30
  runMonth({ world, gameState, rules, seed: 'ironway-001', gameDay, caches })
  const openIndustries = gameState.industries.filter((i) => i.closedDay === null).length
  console.log(`month ${month} (day ${gameDay}) OK - industries open: ${openIndustries}, history rows: ${gameState.historyMonthly.length}, events: ${gameState.eventsLog.length}`)
}

console.log(`All ${months} months completed without throwing.`)
