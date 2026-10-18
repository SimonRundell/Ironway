import { rngFor } from '../rng.js'

/**
 * The island economy level (DESIGN 7.10): the score that drives it,
 * hysteresis, momentum and the seeded shock term. Checked each March
 * and September (DESIGN's own words) — `sim/clock.js`'s `onLevelCheck`
 * hook already fires exactly then; this module just answers "given
 * these indicators, what's the new level", whenever it's called.
 *
 * Every weight, threshold and the momentum bonus already live in
 * `economy.json`'s `economyLevelScore` block (authored in T1.01) —
 * this task needed no new game-balance constants at all, the first
 * economy task since T1.16 that didn't.
 *
 * @module sim/economy/economyLevel
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
 * Normalises raw output growth into the score's [0, 1] scale (DESIGN
 * 7.10 names `outputGrowth` as a score input but gives no formula for
 * turning a growth rate into one): zero growth sits at the neutral
 * midpoint 0.5, scaled so growth and shrinkage push symmetrically
 * toward 1 and 0.
 *
 * @param {number} previousOutput Some total island output measure (e.g. trade value, tonnes produced) from the last check.
 * @param {number} currentOutput The same measure now.
 * @param {object} economyLevelScoreRules `economy.json`'s `economyLevelScore` block.
 * @returns {number} In [0, 1]; 0.5 if there's no prior baseline to compare against.
 */
export function computeOutputGrowthIndex(previousOutput, currentOutput, economyLevelScoreRules) {
  if (previousOutput <= 0) return 0.5
  const growthRate = (currentOutput - previousOutput) / previousOutput
  return clamp01(0.5 + growthRate * economyLevelScoreRules.outputGrowthScale)
}

/**
 * Normalises the trade balance into the score's [0, 1] scale. Unlike
 * output growth, this needs no invented scale constant: a trade
 * balance can never exceed the total value traded, so
 * `balance / totalTradeValue` already falls naturally in [-1, 1].
 *
 * @param {number} tradeBalance From `trade.js`'s `computeTradeBalance()` (export value minus import value).
 * @param {number} totalTradeValue Total trade value (imports plus exports) over the same period.
 * @returns {number} In [0, 1]; 0.5 (neutral) if there was no trade at all.
 */
export function computeTradeBalanceIndex(tradeBalance, totalTradeValue) {
  if (totalTradeValue <= 0) return 0.5
  const ratio = tradeBalance / totalTradeValue
  return clamp01(0.5 + ratio * 0.5)
}

/**
 * DESIGN 7.10's seeded shock term: "a seeded random draw from -1 to
 * +1". Deterministic for a given seed and `gameDay` (PHASES.md's own
 * "Done when": "deterministic shock per seed and date") — the same
 * save checked twice on the same day always gets the same shock.
 *
 * @param {string} seed The save's seed.
 * @param {number} gameDay The `gameDay` this check falls on.
 * @returns {number} In [-1, 1].
 */
export function computeShock(seed, gameDay) {
  const draw = rngFor(seed, 'tick', gameDay, 'economyShock')()
  return draw * 2 - 1
}

/**
 * @typedef {object} EconomyIndicators
 * @property {number} employmentMean Island-wide mean employment rate, 0-1.
 * @property {number} outputGrowth From `computeOutputGrowthIndex()`, 0-1.
 * @property {number} tradeBalanceIndex From `computeTradeBalanceIndex()`, 0-1.
 * @property {number} confidenceMean Island-wide mean confidence, 0-1 (caller divides T1.20's 0-100 confidence by 100).
 * @property {number} playerActivity 0-1; DESIGN 7.10's stubbed 0.5 neutral value in Phase 1.
 * @property {number} shock From `computeShock()`, -1 to 1.
 */

/**
 * Computes this check's economy score (DESIGN 7.10's weighted sum,
 * plus momentum: "+0.05 to the score" if the previous change was
 * upward, "-0.05" if downward, nothing if the level was unchanged last
 * time).
 *
 * @param {EconomyIndicators} indicators
 * @param {-1|0|1} previousChangeDir The direction of the *previous* level check's change (`sim/state.js`'s `EconomyState.lastChangeDir`).
 * @param {object} economyLevelScoreRules `economy.json`'s `economyLevelScore` block.
 * @returns {number} The score (not clamped — thresholds are compared against it directly).
 */
export function computeEconomyScore(indicators, previousChangeDir, economyLevelScoreRules) {
  const { weights, momentumBonus } = economyLevelScoreRules

  const raw = (
    weights.employmentMean * indicators.employmentMean
    + weights.outputGrowth * indicators.outputGrowth
    + weights.tradeBalanceIndex * indicators.tradeBalanceIndex
    + weights.confidenceMean * indicators.confidenceMean
    + weights.playerActivity * indicators.playerActivity
    + weights.shock * indicators.shock
  )

  const momentum = previousChangeDir > 0 ? momentumBonus : previousChangeDir < 0 ? -momentumBonus : 0
  return raw + momentum
}

/**
 * @typedef {object} EconomyLevelCheckResult
 * @property {number} nextLevel The level after this check, 0-4.
 * @property {-1|0|1} changeDir This check's own change direction — feed into next check's `computeEconomyScore()` as `previousChangeDir`.
 */

/**
 * Evaluates one economy level check (DESIGN 7.10): moves at most one
 * step, up if the score clears this level's `upThreshold`, down if it
 * falls below this level's `downThreshold` — thresholds that sit at
 * different values specifically to create hysteresis, so the level
 * doesn't flicker back and forth right at one boundary. Depression (0)
 * has no `downThreshold` and Boom (4) has no `upThreshold`, by
 * `economy.json`'s own design (both are `null`).
 *
 * @param {number} currentLevel 0-4.
 * @param {number} score From `computeEconomyScore()`.
 * @param {object} economyLevelScoreRules `economy.json`'s `economyLevelScore` block.
 * @returns {EconomyLevelCheckResult}
 */
export function evaluateEconomyLevelCheck(currentLevel, score, economyLevelScoreRules) {
  const upThreshold = economyLevelScoreRules.upThresholdByLevel[currentLevel]
  const downThreshold = economyLevelScoreRules.downThresholdByLevel[currentLevel]

  if (upThreshold !== null && score > upThreshold && currentLevel < 4) {
    return { nextLevel: currentLevel + 1, changeDir: 1 }
  }
  if (downThreshold !== null && score < downThreshold && currentLevel > 0) {
    return { nextLevel: currentLevel - 1, changeDir: -1 }
  }
  return { nextLevel: currentLevel, changeDir: 0 }
}
