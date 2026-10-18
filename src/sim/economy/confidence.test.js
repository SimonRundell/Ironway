import { describe, expect, it } from 'vitest'
import { computeNeedsCoverage, computeRawConfidence, computeRealWageIndex, computeWage, smoothConfidence } from './confidence.js'

const WAGE_RULES = { tightnessSensitivity: 0.2 }
const CONFIDENCE_RULES = {
  weights: { employmentRate: 0.40, realWageIndex: 0.25, needsCoverage: 0.20, overcrowding: 0.15 },
  smoothingOldWeight: 0.7,
  smoothingNewWeight: 0.3,
}

describe('computeWage', () => {
  it('matches base wage at zero employment (no tightness lift)', () => {
    expect(computeWage(3.5, 0, WAGE_RULES)).toBeCloseTo(3.5)
  })

  it('lifts wage with employment tightness', () => {
    expect(computeWage(3.5, 0.9, WAGE_RULES)).toBeCloseTo(3.5 * 1.18) // 1 + 0.2*0.9.
  })

  it('lifts wage the most at full employment', () => {
    expect(computeWage(3.5, 1, WAGE_RULES)).toBeCloseTo(3.5 * 1.2)
  })
})

describe('computeRealWageIndex', () => {
  it('matches a hand-computed value', () => {
    // raw = 4.13*0.9/20 = 0.18585, well under the 1.5 cap; /1.5 = 0.1239.
    expect(computeRealWageIndex(4.13, 0.9, 20)).toBeCloseTo(0.18585 / 1.5)
  })

  it('clamps at the 1.5 ceiling before dividing (never exceeds 1)', () => {
    expect(computeRealWageIndex(100, 1, 1)).toBe(1)
  })

  it('is zero for zero or negative cost of living (never divides by zero)', () => {
    expect(computeRealWageIndex(10, 0.5, 0)).toBe(0)
  })
})

describe('computeNeedsCoverage', () => {
  it('averages food, coal and clothing coverage, each capped at 1', () => {
    // food capped from 1.2 to 1, coal 0.5, clothing 0.9: (1+0.5+0.9)/3.
    expect(computeNeedsCoverage({ food: 1.2, coal: 0.5, clothing: 0.9 })).toBeCloseTo(0.8)
  })

  it('treats a missing cargo as zero coverage', () => {
    expect(computeNeedsCoverage({ food: 1 })).toBeCloseTo(1 / 3)
  })

  it('is 1 when every basket cargo is fully covered', () => {
    expect(computeNeedsCoverage({ food: 1, coal: 1, clothing: 1 })).toBe(1)
  })
})

describe('computeRawConfidence', () => {
  it('matches a hand-computed value for a healthy settlement', () => {
    const inputs = { employmentRate: 0.9, realWageIndex: 0.1239, needsCoverage: 0.8, occupancy: 1.0 }
    const raw = computeRawConfidence(inputs, CONFIDENCE_RULES)
    expect(raw).toBeCloseTo(100 * (0.4 * 0.9 + 0.25 * 0.1239 + 0.2 * 0.8 + 0.15 * 1), 2)
  })

  it('is exactly 100 when every component is at its best', () => {
    const inputs = { employmentRate: 1, realWageIndex: 1, needsCoverage: 1, occupancy: 0 }
    expect(computeRawConfidence(inputs, CONFIDENCE_RULES)).toBe(100)
  })

  it('is bounded at 0 even under extreme overcrowding (PHASES.md Done-when: confidence bounded 0 to 100)', () => {
    const inputs = { employmentRate: 0, realWageIndex: 0, needsCoverage: 0, occupancy: 5 }
    expect(computeRawConfidence(inputs, CONFIDENCE_RULES)).toBe(0)
  })

  it('reduces the overcrowding contribution smoothly as occupancy exceeds capacity', () => {
    const notCrowded = computeRawConfidence({ employmentRate: 0.9, realWageIndex: 0.5, needsCoverage: 0.8, occupancy: 1.0 }, CONFIDENCE_RULES)
    const crowded = computeRawConfidence({ employmentRate: 0.9, realWageIndex: 0.5, needsCoverage: 0.8, occupancy: 1.3 }, CONFIDENCE_RULES)
    expect(crowded).toBeLessThan(notCrowded)
  })
})

describe('smoothConfidence', () => {
  it('weights 0.7 old, 0.3 new', () => {
    expect(smoothConfidence(50, 80, CONFIDENCE_RULES)).toBeCloseTo(59)
  })

  it('a single bad month does not swing confidence all the way to the raw value', () => {
    const smoothed = smoothConfidence(80, 20, CONFIDENCE_RULES)
    expect(smoothed).toBeGreaterThan(20)
    expect(smoothed).toBeLessThan(80)
  })
})
