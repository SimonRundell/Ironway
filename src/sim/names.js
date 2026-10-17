/**
 * Deterministic name generation for settlements, rivers, bays, ranges
 * and the island itself. DESIGN.md 5.7: syllable and morpheme tables
 * from names.json, unique per save, never on the blocklist, same seed
 * gives the same names.
 *
 * @module sim/names
 */

import { pick, rngFor } from './rng.js'

/**
 * Builds a settlement name: a stem plus an ending, with a coastal
 * ending favoured (not forced) for coastal settlements, and an
 * occasional prefix like "Upper" or "Saint".
 *
 * @param {() => number} rng A stream from rngFor().
 * @param {object} namesRules The validated names.json rules.
 * @param {boolean} isCoastal Whether the settlement sits on the coast.
 * @returns {string} A settlement name.
 */
function buildSettlementName(rng, namesRules, isCoastal) {
  const stem = pick(rng, namesRules.settlementStems)
  const useCoastalEnding = isCoastal && rng() < namesRules.coastalEndingChance
  const ending = pick(rng, useCoastalEnding ? namesRules.coastalEndings : namesRules.settlementEndings)
  let name = stem + ending

  if (rng() < namesRules.prefixChance) {
    name = `${pick(rng, namesRules.prefixes)} ${name}`
  }

  return name
}

/**
 * Builds a river name: a stem, optionally followed by a suffix word.
 * An empty suffix in the table gives a bare name (e.g. "Otter").
 *
 * @param {() => number} rng A stream from rngFor().
 * @param {object} namesRules The validated names.json rules.
 * @returns {string} A river name.
 */
function buildRiverName(rng, namesRules) {
  const stem = pick(rng, namesRules.riverStems)
  const suffix = pick(rng, namesRules.riverSuffixes)
  return suffix ? `${stem} ${suffix}` : stem
}

/**
 * Builds a bay name: a stem plus a suffix word.
 *
 * @param {() => number} rng A stream from rngFor().
 * @param {object} namesRules The validated names.json rules.
 * @returns {string} A bay name.
 */
function buildBayName(rng, namesRules) {
  return `${pick(rng, namesRules.bayStems)} ${pick(rng, namesRules.baySuffixes)}`
}

/**
 * Builds a mountain range name: a stem plus a suffix word.
 *
 * @param {() => number} rng A stream from rngFor().
 * @param {object} namesRules The validated names.json rules.
 * @returns {string} A range name.
 */
function buildRangeName(rng, namesRules) {
  return `${pick(rng, namesRules.rangeStems)} ${pick(rng, namesRules.rangeSuffixes)}`
}

/**
 * Builds an island name: a fused stem and suffix, fantasy-place style
 * (e.g. "Avermere").
 *
 * @param {() => number} rng A stream from rngFor().
 * @param {object} namesRules The validated names.json rules.
 * @returns {string} An island name.
 */
function buildIslandName(rng, namesRules) {
  return pick(rng, namesRules.islandNameStems) + pick(rng, namesRules.islandNameSuffixes)
}

/**
 * Creates a name generator for one save. Every name it returns is
 * unique (case-insensitive) within the generator's lifetime and never
 * matches names.json's blocklist; each category draws from its own
 * counter, so the n-th settlement name depends only on how many
 * settlement names were drawn before it, not on interleaved river,
 * bay, range or island draws. Fully determined by the seed and the
 * order names are requested in.
 *
 * @param {string} seed The save's seed.
 * @param {object} namesRules The validated names.json rules.
 * @returns {{
 *   settlementName: (isCoastal: boolean) => string,
 *   riverName: () => string,
 *   bayName: () => string,
 *   rangeName: () => string,
 *   islandName: () => string,
 * }}
 */
export function createNameGenerator(seed, namesRules) {
  const used = new Set()
  const blocklist = new Set(namesRules.blocklist.map((name) => name.toLowerCase()))
  const counters = {}

  /**
   * Draws a unique, non-blocklisted name for one category, retrying
   * with a fresh rng draw on any collision.
   *
   * @param {string} category A label for this draw's rng key (e.g. 'settlement').
   * @param {(rng: () => number) => string} build Builds one candidate name from a stream.
   * @returns {string} A unique, non-blocklisted name.
   */
  function draw(category, build) {
    const index = counters[category] ?? 0
    counters[category] = index + 1

    for (let attempt = 0; attempt < namesRules.maxAttempts; attempt++) {
      const rng = rngFor(seed, 'names', category, index, attempt)
      const name = build(rng)
      const key = name.toLowerCase()

      if (!used.has(key) && !blocklist.has(key)) {
        used.add(key)
        return name
      }
    }

    throw new Error(`names: could not draw a unique, non-blocklisted ${category} name after ${namesRules.maxAttempts} attempts`)
  }

  return {
    settlementName: (isCoastal) => draw('settlement', (rng) => buildSettlementName(rng, namesRules, isCoastal)),
    riverName: () => draw('river', (rng) => buildRiverName(rng, namesRules)),
    bayName: () => draw('bay', (rng) => buildBayName(rng, namesRules)),
    rangeName: () => draw('range', (rng) => buildRangeName(rng, namesRules)),
    islandName: () => draw('island', (rng) => buildIslandName(rng, namesRules)),
  }
}
