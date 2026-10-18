import { describe, expect, it } from 'vitest'
import {
  computeEconomyScore,
  computeOutputGrowthIndex,
  computeShock,
  computeTradeBalanceIndex,
  evaluateEconomyLevelCheck,
} from './economyLevel.js'

const RULES = {
  weights: { employmentMean: 0.25, outputGrowth: 0.20, tradeBalanceIndex: 0.15, confidenceMean: 0.20, playerActivity: 0.15, shock: 0.05 },
  momentumBonus: 0.05,
  neutralPlayerActivity: 0.5,
  outputGrowthScale: 2,
  upThresholdByLevel: [0.45, 0.60, 0.75, 0.90, null],
  downThresholdByLevel: [null, 0.35, 0.45, 0.55, 0.70],
}

describe('computeOutputGrowthIndex', () => {
  it('sits at the neutral 0.5 midpoint for zero growth', () => {
    expect(computeOutputGrowthIndex(100, 100, RULES)).toBe(0.5)
  })

  it('matches a hand-computed value for positive growth', () => {
    // growthRate = 0.10; 0.5 + 0.10*2 = 0.7.
    expect(computeOutputGrowthIndex(100, 110, RULES)).toBeCloseTo(0.7)
  })

  it('matches a hand-computed value for negative growth (shrinkage)', () => {
    expect(computeOutputGrowthIndex(100, 90, RULES)).toBeCloseTo(0.3)
  })

  it('is neutral with no prior baseline to compare against', () => {
    expect(computeOutputGrowthIndex(0, 50, RULES)).toBe(0.5)
  })

  it('clamps extreme growth to 1', () => {
    expect(computeOutputGrowthIndex(100, 1000, RULES)).toBe(1)
  })

  it('clamps extreme shrinkage to 0', () => {
    expect(computeOutputGrowthIndex(100, 0, RULES)).toBe(0)
  })
})

describe('computeTradeBalanceIndex', () => {
  it('matches a hand-computed value for a partial surplus', () => {
    expect(computeTradeBalanceIndex(50, 200)).toBeCloseTo(0.625) // ratio 0.25.
  })

  it('matches a hand-computed value for a partial deficit', () => {
    expect(computeTradeBalanceIndex(-100, 200)).toBeCloseTo(0.25) // ratio -0.5.
  })

  it('is 1 for trade that is entirely exports', () => {
    expect(computeTradeBalanceIndex(200, 200)).toBe(1)
  })

  it('is 0 for trade that is entirely imports', () => {
    expect(computeTradeBalanceIndex(-200, 200)).toBe(0)
  })

  it('is neutral with no trade at all', () => {
    expect(computeTradeBalanceIndex(0, 0)).toBe(0.5)
  })
})

describe('computeShock', () => {
  it('is deterministic for the same seed and gameDay (PHASES.md Done-when)', () => {
    expect(computeShock('ironway-001', 1080)).toBe(computeShock('ironway-001', 1080))
  })

  it('differs across different game days (in general)', () => {
    const values = [0, 1, 2, 3, 4, 5].map((d) => computeShock('ironway-001', d * 180))
    expect(new Set(values).size).toBeGreaterThan(1)
  })

  it('differs across different seeds for the same day (in general)', () => {
    expect(computeShock('seed-a', 1080)).not.toBe(computeShock('seed-b', 1080))
  })

  it('always falls within [-1, 1]', () => {
    for (let day = 0; day < 50; day++) {
      const shock = computeShock('ironway-001', day * 180)
      expect(shock).toBeGreaterThanOrEqual(-1)
      expect(shock).toBeLessThanOrEqual(1)
    }
  })
})

describe('computeEconomyScore', () => {
  const indicators = { employmentMean: 0.8, outputGrowth: 0.6, tradeBalanceIndex: 0.5, confidenceMean: 0.7, playerActivity: 0.5, shock: 0.2 }

  it('matches a hand-computed value with no momentum', () => {
    expect(computeEconomyScore(indicators, 0, RULES)).toBeCloseTo(0.62)
  })

  it('adds the momentum bonus after an upward change', () => {
    expect(computeEconomyScore(indicators, 1, RULES)).toBeCloseTo(0.67)
  })

  it('subtracts the momentum bonus after a downward change', () => {
    expect(computeEconomyScore(indicators, -1, RULES)).toBeCloseTo(0.57)
  })
})

describe('evaluateEconomyLevelCheck', () => {
  it('moves up exactly one level when the score clears the up threshold', () => {
    const result = evaluateEconomyLevelCheck(2, 0.76, RULES)
    expect(result.nextLevel).toBe(3)
    expect(result.changeDir).toBe(1)
  })

  it('does not move up when the score exactly equals the threshold (strictly greater required)', () => {
    const result = evaluateEconomyLevelCheck(2, 0.75, RULES)
    expect(result.nextLevel).toBe(2)
    expect(result.changeDir).toBe(0)
  })

  it('moves down exactly one level when the score falls below the down threshold', () => {
    const result = evaluateEconomyLevelCheck(2, 0.40, RULES)
    expect(result.nextLevel).toBe(1)
    expect(result.changeDir).toBe(-1)
  })

  it('stays put between the two thresholds (the hysteresis band)', () => {
    const result = evaluateEconomyLevelCheck(2, 0.5, RULES)
    expect(result.nextLevel).toBe(2)
    expect(result.changeDir).toBe(0)
  })

  it('never moves more than one level in a single check, even for an extreme score', () => {
    const result = evaluateEconomyLevelCheck(0, 1.0, RULES)
    expect(result.nextLevel).toBe(1) // Not jumping straight to 4.
  })

  it('Boom (level 4) can never rise further, regardless of score', () => {
    const result = evaluateEconomyLevelCheck(4, 1.0, RULES)
    expect(result.nextLevel).toBe(4)
    expect(result.changeDir).toBe(0)
  })

  it('Depression (level 0) can never fall further, regardless of score', () => {
    const result = evaluateEconomyLevelCheck(0, -1.0, RULES)
    expect(result.nextLevel).toBe(0)
    expect(result.changeDir).toBe(0)
  })

  it('Depression can still rise when its own up threshold is cleared', () => {
    const result = evaluateEconomyLevelCheck(0, 0.5, RULES)
    expect(result.nextLevel).toBe(1)
    expect(result.changeDir).toBe(1)
  })
})
