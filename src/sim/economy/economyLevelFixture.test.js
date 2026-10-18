import { describe, expect, it } from 'vitest'
import { computeEconomyScore, computeShock, evaluateEconomyLevelCheck } from './economyLevel.js'

/**
 * T1.23's own "Done when" fixture (PHASES.md): over 10 years in the
 * harness, a deliberately starved economy trends down while a healthy
 * one trends up. Checks happen every March (day 60 of a year) and
 * September (day 240), DESIGN 4.1/7.10's own calendar — 20 checks over
 * 10 years.
 */

const RULES = {
  weights: { employmentMean: 0.25, outputGrowth: 0.20, tradeBalanceIndex: 0.15, confidenceMean: 0.20, playerActivity: 0.15, shock: 0.05 },
  momentumBonus: 0.05,
  neutralPlayerActivity: 0.5,
  outputGrowthScale: 2,
  upThresholdByLevel: [0.45, 0.60, 0.75, 0.90, null],
  downThresholdByLevel: [null, 0.35, 0.45, 0.55, 0.70],
}

const STARTING_LEVEL = 2 // Normal (economy.json's startingEconomyLevel).

/** @returns {number[]} The gameDay of every March/September check over 10 years. */
function tenYearsOfCheckDays() {
  const days = []
  for (let year = 0; year < 10; year++) {
    days.push(year * 360 + 60) // March.
    days.push(year * 360 + 240) // September.
  }
  return days
}

function runHarness(seed, indicators) {
  let level = STARTING_LEVEL
  let changeDir = 0
  const levelHistory = [level]

  for (const gameDay of tenYearsOfCheckDays()) {
    const shock = computeShock(seed, gameDay)
    const score = computeEconomyScore({ ...indicators, shock }, changeDir, RULES)
    const result = evaluateEconomyLevelCheck(level, score, RULES)
    level = result.nextLevel
    changeDir = result.changeDir
    levelHistory.push(level)
  }

  return { finalLevel: level, levelHistory }
}

describe('T1.23 fixture: a deliberately starved economy trends down over 10 years', () => {
  it('ends at a lower level than it started, and never once rises', () => {
    const starvedIndicators = { employmentMean: 0.3, outputGrowth: 0.1, tradeBalanceIndex: 0.1, confidenceMean: 0.2, playerActivity: 0.5 }
    const { finalLevel, levelHistory } = runHarness('ironway-starved', starvedIndicators)

    expect(finalLevel).toBeLessThan(STARTING_LEVEL)
    for (let i = 1; i < levelHistory.length; i++) {
      expect(levelHistory[i]).toBeLessThanOrEqual(levelHistory[i - 1]) // Monotonically non-increasing throughout.
    }
    expect(finalLevel).toBe(0) // Comfortably bad enough to bottom out at Depression within 10 years.
  })
})

describe('T1.23 fixture: a healthy economy trends up over 10 years', () => {
  it('ends at a higher level than it started, and never once falls', () => {
    const healthyIndicators = { employmentMean: 0.98, outputGrowth: 0.95, tradeBalanceIndex: 0.95, confidenceMean: 0.95, playerActivity: 0.5 }
    const { finalLevel, levelHistory } = runHarness('ironway-healthy', healthyIndicators)

    expect(finalLevel).toBeGreaterThan(STARTING_LEVEL)
    for (let i = 1; i < levelHistory.length; i++) {
      expect(levelHistory[i]).toBeGreaterThanOrEqual(levelHistory[i - 1]) // Monotonically non-decreasing throughout.
    }
  })
})

describe('T1.23 fixture: a neutral economy holds steady', () => {
  it('stays at the starting level when the five non-shock indicators sit mid-band, with margin to spare against shock noise', () => {
    // The five non-shock weights sum to 0.95 (shock's own 0.05 is excluded, since shock is random, not
    // part of these "neutral" indicators). Setting every indicator to 0.63 gives a non-shock contribution
    // of 0.63*0.95 = 0.5985, comfortably centred in level 2's [0.45, 0.75] hysteresis band -- even with
    // shock's full ±0.05 swing and a ±0.05 momentum swing once a change starts, the score stays inside
    // [0.50, 0.70], never touching either threshold.
    const neutralIndicators = { employmentMean: 0.63, outputGrowth: 0.63, tradeBalanceIndex: 0.63, confidenceMean: 0.63, playerActivity: 0.63 }
    const { finalLevel } = runHarness('ironway-neutral', neutralIndicators)
    expect(finalLevel).toBe(STARTING_LEVEL)
  })
})
