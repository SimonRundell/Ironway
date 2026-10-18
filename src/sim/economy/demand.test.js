import { describe, expect, it } from 'vitest'
import { computeIndustryDemand, computePopulationDemand, confidenceSpendingFactor, mergeDemand } from './demand.js'

const SPENDING_FACTORS = { atConfidence0: 0.7, atConfidence50: 1.0, atConfidence100: 1.2 }

describe('confidenceSpendingFactor', () => {
  it('matches the three named breakpoints exactly', () => {
    expect(confidenceSpendingFactor(0, SPENDING_FACTORS)).toBe(0.7)
    expect(confidenceSpendingFactor(50, SPENDING_FACTORS)).toBe(1.0)
    expect(confidenceSpendingFactor(100, SPENDING_FACTORS)).toBe(1.2)
  })

  it('interpolates linearly in the lower half (0 to 50)', () => {
    // Halfway: 0.7 + (1.0-0.7) * 0.5 = 0.85.
    expect(confidenceSpendingFactor(25, SPENDING_FACTORS)).toBeCloseTo(0.85)
  })

  it('interpolates linearly in the upper half (50 to 100)', () => {
    // Halfway: 1.0 + (1.2-1.0) * 0.5 = 1.1.
    expect(confidenceSpendingFactor(75, SPENDING_FACTORS)).toBeCloseTo(1.1)
  })

  it('clamps confidence outside [0, 100]', () => {
    expect(confidenceSpendingFactor(-10, SPENDING_FACTORS)).toBe(0.7)
    expect(confidenceSpendingFactor(150, SPENDING_FACTORS)).toBe(1.2)
  })
})

const ECONOMY_RULES = {
  demandPerThousandPerMonth: {
    food: { working: 30, middle: 34, upper: 40 },
    coal: { working: 15, middle: 20, upper: 25 },
    cars: { working: 0, middle: 0.05, upper: 0.3, eraFrom: 1900 },
  },
  confidenceSpendingFactor: SPENDING_FACTORS,
  seasonal: { coalDemandFactorByMonth: [1.6, 1.5, 1.3, 1.0, 0.8, 0.6, 0.6, 0.6, 0.8, 1.0, 1.3, 1.5] },
}

describe('computePopulationDemand (complex mode)', () => {
  it('matches a hand-computed value for a mixed-class village, including the January coal seasonal factor', () => {
    const classRows = [
      { classId: 'working', pop: 1000, confidence: 50 },
      { classId: 'middle', pop: 200, confidence: 50 },
      { classId: 'upper', pop: 0, confidence: 50 },
    ]
    const demand = computePopulationDemand(classRows, 'village', 'complex', ECONOMY_RULES, 1.0, 0, 1830)

    // food: (1000/1000)*30 + (200/1000)*34 + 0 = 30 + 6.8 = 36.8.
    expect(demand.food).toBeCloseTo(36.8)
    // coal: ((1000/1000)*15 + (200/1000)*20) * 1.6 (January) = 19 * 1.6 = 30.4.
    expect(demand.coal).toBeCloseTo(30.4)
  })

  it('gates a cargo out entirely before its eraFrom year, regardless of class rates', () => {
    const classRows = [{ classId: 'middle', pop: 1000, confidence: 50 }]
    const demand = computePopulationDemand(classRows, 'village', 'complex', ECONOMY_RULES, 1.0, 0, 1830)
    expect(demand.cars).toBe(0)
  })

  it('demands a cargo once its eraFrom year has arrived', () => {
    const classRows = [{ classId: 'middle', pop: 1000, confidence: 50 }]
    const demand = computePopulationDemand(classRows, 'village', 'complex', ECONOMY_RULES, 1.0, 0, 1905)
    expect(demand.cars).toBeCloseTo((1000 / 1000) * 0.05)
  })

  it('a class with zero population contributes zero demand for cargoes it alone would buy', () => {
    const classRows = [
      { classId: 'working', pop: 1000, confidence: 50 },
      { classId: 'upper', pop: 0, confidence: 50 },
    ]
    const demand = computePopulationDemand(classRows, 'town', 'complex', ECONOMY_RULES, 1.0, 0, 1830)
    // Only the working rate contributes: (1000/1000)*30 = 30, nothing from the absent upper class.
    expect(demand.food).toBeCloseTo(30)
  })

  it('scales with the economy level demand multiplier', () => {
    const classRows = [{ classId: 'working', pop: 1000, confidence: 50 }]
    const demand = computePopulationDemand(classRows, 'village', 'complex', ECONOMY_RULES, 1.08, 0, 1830)
    expect(demand.food).toBeCloseTo(30 * 1.08)
  })
})

describe('computePopulationDemand (basic mode)', () => {
  it('a town-or-larger settlement demands every consumer cargo regardless of population mix', () => {
    // Entirely Working-class population: in complex mode this would demand zero luxury-rate cargo.
    const classRows = [
      { classId: 'working', pop: 1000, confidence: 50 },
      { classId: 'middle', pop: 0, confidence: 50 },
      { classId: 'upper', pop: 0, confidence: 50 },
    ]
    const demand = computePopulationDemand(classRows, 'town', 'basic', ECONOMY_RULES, 1.0, 0, 1830)

    // food: (1000/1000) * (30+34+40) = 104 -- the combined rate, not just the working rate (30).
    expect(demand.food).toBeCloseTo(104)
    // coal: (1000/1000) * (15+20+25) * 1.6 (January) = 60 * 1.6 = 96.
    expect(demand.coal).toBeCloseTo(96)
  })

  it('still gates by eraFrom in basic mode', () => {
    const classRows = [{ classId: 'working', pop: 1000, confidence: 50 }]
    const demand = computePopulationDemand(classRows, 'city', 'basic', ECONOMY_RULES, 1.0, 0, 1830)
    expect(demand.cars).toBe(0)
  })

  it('does not blend a village or hamlet even in basic mode', () => {
    const classRows = [{ classId: 'working', pop: 1000, confidence: 50 }]
    const demand = computePopulationDemand(classRows, 'village', 'basic', ECONOMY_RULES, 1.0, 0, 1830)
    // Normal per-class calculation: only the working rate (30), not the combined rate (104).
    expect(demand.food).toBeCloseTo(30)
  })
})

describe('computeIndustryDemand', () => {
  it('demands each plain input slot at its full-output quantity', () => {
    const industryDef = { inputs: [{ cargo: 'coal', qty: 60 }] }
    expect(computeIndustryDemand(industryDef)).toEqual({ coal: 60 })
  })

  it('demands every option of an {any} substitution slot at its own full quantity', () => {
    const industryDef = { inputs: [{ any: { iron: 200, steel: 200 } }, { cargo: 'coal', qty: 60 }] }
    expect(computeIndustryDemand(industryDef)).toEqual({ iron: 200, steel: 200, coal: 60 })
  })

  it('demands nothing for a primary industry with no inputs', () => {
    expect(computeIndustryDemand({ inputs: [] })).toEqual({})
  })
})

describe('mergeDemand', () => {
  it('sums overlapping cargoes across any number of demand objects', () => {
    expect(mergeDemand({ food: 10, coal: 5 }, { coal: 3, iron: 7 })).toEqual({ food: 10, coal: 8, iron: 7 })
  })

  it('returns an empty object when given no demand sources', () => {
    expect(mergeDemand()).toEqual({})
  })
})
