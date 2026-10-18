#!/usr/bin/env node
/**
 * Generates src/sim/economy/priceTables.generated.js: baked
 * coverage^(-elasticity) lookup tables for every distinct elasticity
 * value in cargo.json (DESIGN 4.5, 7.4). This script is the only place
 * in the project allowed to call Math.pow with a fractional exponent
 * for this purpose — it runs once, at author time, and its output is a
 * static data file of plain numbers. Runtime code (sim/economy/prices.js)
 * only ever binary-searches and linearly interpolates between baked
 * points, which is exact arithmetic and therefore bit-identical on
 * every JavaScript engine (DESIGN 4.5's "generator and simulation
 * maths" rule).
 *
 * Coverage points are log-spaced, not linear: x^(-e) is steep near
 * x=0 and flat for large x, so a log grid keeps points dense exactly
 * where linear interpolation would otherwise need them most, with no
 * runtime Math.log required (the lookup is a binary search over the
 * baked coverage array, not an index computed from log2(coverage)).
 *
 * Re-run this whenever cargo.json's set of elasticity values changes
 * (e.g. during T1.25's balance pass).
 *
 * Usage:
 *   node scripts/build-price-tables.mjs
 */

import { writeFileSync } from 'node:fs'
import cargoData from '../public/data/cargo.json' with { type: 'json' }

const LOG2_COVERAGE_MIN = -16 // coverage ~= 1.5e-5
const LOG2_COVERAGE_MAX = 8 // coverage = 256
const STEPS = 400 // ~4.25% ratio between consecutive points; see DECISIONS.md for the resulting worst-case error bound.

const elasticities = [...new Set(cargoData.cargo.map((c) => c.elasticity))].sort((a, b) => a - b)

const coverageTable = new Array(STEPS + 1)
for (let i = 0; i <= STEPS; i++) {
  const log2Coverage = LOG2_COVERAGE_MIN + (i * (LOG2_COVERAGE_MAX - LOG2_COVERAGE_MIN)) / STEPS
  coverageTable[i] = Math.pow(2, log2Coverage)
}

const powerTables = {}
for (const elasticity of elasticities) {
  powerTables[elasticity] = coverageTable.map((coverage) => Math.pow(coverage, -elasticity))
}

const lines = []
lines.push('/**')
lines.push(' * GENERATED FILE. Do not hand-edit — run scripts/build-price-tables.mjs.')
lines.push(' *')
lines.push(' * Baked coverage^(-elasticity) lookup tables (DESIGN 4.5, 7.4), one per')
lines.push(' * distinct elasticity value in cargo.json at generation time. COVERAGE_TABLE')
lines.push(' * is log-spaced (dense near zero, where the curve is steepest); POWER_TABLES')
lines.push(' * holds the matching coverage^(-elasticity) value at each of those points.')
lines.push(' * sim/economy/prices.js binary-searches COVERAGE_TABLE and linearly')
lines.push(' * interpolates at runtime, using only comparisons and +, -, *, /.')
lines.push(' *')
lines.push(' * @module sim/economy/priceTables.generated')
lines.push(' */')
lines.push('')
lines.push(`export const COVERAGE_TABLE = [${coverageTable.map((v) => v.toPrecision(17)).join(',')}]`)
lines.push('')
lines.push('/** @type {Record<string, number[]>} Keyed by elasticity, stringified. Same length and coverage points as COVERAGE_TABLE. */')
lines.push('export const POWER_TABLES = {')
for (const elasticity of elasticities) {
  lines.push(`  "${elasticity}": [${powerTables[elasticity].map((v) => v.toPrecision(17)).join(',')}],`)
}
lines.push('}')
lines.push('')

writeFileSync(new URL('../src/sim/economy/priceTables.generated.js', import.meta.url), lines.join('\n'))

console.log(`Wrote src/sim/economy/priceTables.generated.js: ${elasticities.length} tables (elasticities: ${elasticities.join(', ')}), ${STEPS + 1} points each, coverage ${coverageTable[0].toExponential(2)} to ${coverageTable[STEPS]}.`)
