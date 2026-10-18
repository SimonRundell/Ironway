/**
 * Wages, needs coverage and confidence (DESIGN 7.7). Confidence feeds
 * demand (7.3, T1.16), migration (7.6, T1.19) and the island economy
 * score (7.10, T1.23) — this module only computes it.
 *
 * @module sim/economy/confidence
 */

/**
 * @param {number} value
 * @returns {number} `value` clamped to [0, 1].
 */
function clamp01(value) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * A class's wage this month (DESIGN 7.7: "`wage(c)` base per class...
 * scaled by local tightness (low unemployment lifts it a little)").
 * Tightness is taken directly as `employmentRate` (a tight market —
 * few unemployed — is exactly a high employment rate), so no separate
 * "tightness" indicator needs computing; see DECISIONS.md.
 *
 * @param {number} baseWage `classes.json`'s `baseWagePerMonth` for this class.
 * @param {number} employmentRate From `jobs.js`'s `computeEmploymentRate()`.
 * @param {object} wageRules `economy.json`'s `wages` block.
 * @returns {number} This month's wage.
 */
export function computeWage(baseWage, employmentRate, wageRules) {
  return baseWage * (1 + wageRules.tightnessSensitivity * employmentRate)
}

/**
 * DESIGN 7.7: `realWageIndex = clamp(wage * employmentRate /
 * costOfLiving, 0, 1.5) / 1.5`.
 *
 * @param {number} wage From `computeWage()`.
 * @param {number} employmentRate
 * @param {number} costOfLiving From `prices.js`'s `computeCostOfLiving()`.
 * @returns {number} In [0, 1].
 */
export function computeRealWageIndex(wage, employmentRate, costOfLiving) {
  if (costOfLiving <= 0) return 0
  const raw = (wage * employmentRate) / costOfLiving
  const clamped = raw < 0 ? 0 : raw > 1.5 ? 1.5 : raw
  return clamped / 1.5
}

/** @type {readonly string[]} The cargoes DESIGN 7.7's needs coverage averages. */
const NEEDS_COVERAGE_CARGOES = Object.freeze(['food', 'coal', 'clothing'])

/**
 * DESIGN 7.7: "weighted average coverage (capped 1) of food, coal,
 * clothing for the settlement." No weights are actually given, so this
 * is an equal (1/3 each) average — a neutral default where DESIGN
 * names a concept without a formula; see DECISIONS.md.
 *
 * @param {Record<string, number>} coverageByCargo Coverage (`prices.js`'s `computeCoverage()`) for each cargo, keyed by cargo id.
 * @returns {number} Needs coverage, in [0, 1].
 */
export function computeNeedsCoverage(coverageByCargo) {
  const total = NEEDS_COVERAGE_CARGOES.reduce((sum, cargo) => {
    const coverage = coverageByCargo[cargo] ?? 0
    return sum + clamp01(coverage)
  }, 0)
  return total / NEEDS_COVERAGE_CARGOES.length
}

/**
 * @typedef {object} ConfidenceInputs
 * @property {number} employmentRate
 * @property {number} realWageIndex
 * @property {number} needsCoverage
 * @property {number} occupancy `population / housingCapacity`. Overcrowding is `max(0, occupancy - 1)`, zero for any settlement at or under capacity — see DECISIONS.md.
 */

/**
 * Computes one month's raw (unsmoothed) confidence for one class
 * (DESIGN 7.7): `C(s,c) = 100 * (0.40*employmentRate +
 * 0.25*realWageIndex + 0.20*needsCoverage + 0.15*(1-overcrowding))`.
 *
 * @param {ConfidenceInputs} inputs
 * @param {object} confidenceRules `economy.json`'s `confidence` block.
 * @returns {number} Raw confidence, in [0, 100].
 */
export function computeRawConfidence(inputs, confidenceRules) {
  const overcrowding = Math.max(0, inputs.occupancy - 1)
  const { weights } = confidenceRules

  const raw = 100 * (
    weights.employmentRate * clamp01(inputs.employmentRate)
    + weights.realWageIndex * clamp01(inputs.realWageIndex)
    + weights.needsCoverage * clamp01(inputs.needsCoverage)
    + weights.overcrowding * (1 - overcrowding)
  )

  // PHASES.md's own Done-when: confidence bounded 0 to 100, even though
  // an extreme overcrowding term could otherwise push the raw sum negative.
  if (raw < 0) return 0
  if (raw > 100) return 100
  return raw
}

/**
 * Smooths this month's raw confidence against last month's value
 * (DESIGN 7.7: "0.7 old, 0.3 new... so one bad month does not swing
 * everything").
 *
 * @param {number} previousConfidence Last month's (already smoothed) confidence.
 * @param {number} rawConfidence This month's raw confidence (`computeRawConfidence()`).
 * @param {object} confidenceRules `economy.json`'s `confidence` block.
 * @returns {number} The new smoothed confidence, in [0, 100].
 */
export function smoothConfidence(previousConfidence, rawConfidence, confidenceRules) {
  return previousConfidence * confidenceRules.smoothingOldWeight + rawConfidence * confidenceRules.smoothingNewWeight
}
