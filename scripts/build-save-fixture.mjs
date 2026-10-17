#!/usr/bin/env node
/**
 * Builds a realistic saves/create.php request body from a freshly
 * generated world, for api/tests/saves_test.php to POST against the
 * live API. Mirrors what the real client (T1.14) will eventually do:
 * generateWorld() -> build a fresh GameState around it -> toRows() ->
 * packWorld() -> base64.
 *
 * Usage:
 *   node scripts/build-save-fixture.mjs <seed> <outputPath>
 */

import { writeFileSync } from 'node:fs'
import { loadRulesNode } from '../src/sim/rules.js'
import { generateWorld } from '../src/sim/mapgen/world.js'
import { packWorld } from '../src/sim/mapgen/pack.js'
import { createGameState, toRows } from '../src/sim/state.js'

const seed = process.argv[2] ?? 'ironway-001'
const outputPath = process.argv[3]

if (!outputPath) {
  console.error('Usage: node scripts/build-save-fixture.mjs <seed> <outputPath>')
  process.exit(1)
}

const rules = await loadRulesNode('public/data')
const difficultyId = 'normal'
const { world } = generateWorld(seed, difficultyId, rules)
const difficultyDef = rules.difficulty.find((d) => d.id === difficultyId)

const gameState = createGameState(
  world.settlements,
  world.industries,
  world.links,
  { level: 2, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
  { name: 'Test Transport Co', cash: difficultyDef.startingCash, loans: 0, rankKey: 'novice', stats: {} },
  [],
  [],
)
const rows = toRows(gameState)
const blob = packWorld(world.grid)

const payload = {
  meta: {
    name: 'Test Save',
    seed: world.meta.seed,
    attempt: world.meta.attempt,
    generatorVersion: world.meta.generatorVersion,
    startYear: world.meta.startYear,
    difficulty: world.meta.difficulty,
  },
  world: rows,
  blob: Buffer.from(blob).toString('base64'),
}

writeFileSync(outputPath, JSON.stringify(payload))
console.log(`Wrote ${outputPath} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB, ${world.settlements.length} settlements)`)
