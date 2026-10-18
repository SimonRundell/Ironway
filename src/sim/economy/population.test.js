import { describe, expect, it } from 'vitest'
import {
  applyClassDrift,
  computeAttractiveness,
  computeBirthsAndDeaths,
  computeFoodFactor,
  computeHousingFactor,
  computeMigrationFromSettlement,
  computeShortagePenalty,
} from './population.js'

const POP_RULES = {
  birthRateFoodFactorFloor: 0.5,
  birthRateHousingFactorFloor: 0.5,
  foodCoverageThreshold: 0.8,
  overcrowdingDeathThreshold: 1.10,
  migrationOutflowCapPerMonth: 0.03,
  migrationDistanceScaleMiles: 20,
  classDriftTowardJobSharePerYear: 0.10,
  rentierUpperFloor: 0.03,
}

const ERAS_RULES = {
  birthRatePer1000PerYear: [{ year: 1830, value: 33 }],
  deathRatePer1000PerYear: [{ year: 1830, value: 22 }],
}

describe('computeFoodFactor', () => {
  it('is 1 at or above the coverage threshold', () => {
    expect(computeFoodFactor(0.8, POP_RULES)).toBe(1)
    expect(computeFoodFactor(2, POP_RULES)).toBe(1)
  })

  it('is the floor at zero coverage', () => {
    expect(computeFoodFactor(0, POP_RULES)).toBe(0.5)
  })

  it('interpolates linearly between the floor and 1', () => {
    // Half the threshold (0.4/0.8): 0.5 + 0.5*0.5 = 0.75.
    expect(computeFoodFactor(0.4, POP_RULES)).toBeCloseTo(0.75)
  })
})

describe('computeHousingFactor', () => {
  it('is 1 at or under full capacity', () => {
    expect(computeHousingFactor(1, POP_RULES)).toBe(1)
    expect(computeHousingFactor(0.5, POP_RULES)).toBe(1)
  })

  it('is the floor at or beyond overcrowdingDeathThreshold', () => {
    expect(computeHousingFactor(1.10, POP_RULES)).toBeCloseTo(0.5)
    expect(computeHousingFactor(2, POP_RULES)).toBeCloseTo(0.5)
  })

  it('interpolates linearly between 1 and the floor', () => {
    // Halfway through the 1.0-1.10 band: 1 - 0.5*0.5 = 0.75.
    expect(computeHousingFactor(1.05, POP_RULES)).toBeCloseTo(0.75)
  })
})

describe('computeShortagePenalty', () => {
  it('is zero for a healthy settlement (full foodFactor, no overcrowding)', () => {
    expect(computeShortagePenalty(1, 1, POP_RULES)).toBe(0)
  })

  it('mirrors the food shortfall', () => {
    expect(computeShortagePenalty(0.75, 1, POP_RULES)).toBeCloseTo(0.25)
  })

  it('adds an overcrowding component above the death threshold', () => {
    expect(computeShortagePenalty(1, 1.3, POP_RULES)).toBeCloseTo(0.2) // 1.3 - 1.10.
  })

  it('combines both components', () => {
    expect(computeShortagePenalty(0.75, 1.3, POP_RULES)).toBeCloseTo(0.45)
  })
})

describe('computeBirthsAndDeaths', () => {
  it('matches a hand-computed value for a healthy settlement', () => {
    // birthRate = 33/1000/yr = 0.033; monthly = pop*0.033/12. deathRate = 22/1000/yr similarly.
    const { births, deaths } = computeBirthsAndDeaths(1200, 1830, 1.0, 0.5, ERAS_RULES, POP_RULES)
    expect(births).toBeCloseTo(1200 * (0.033 / 12))
    expect(deaths).toBeCloseTo(1200 * (0.022 / 12))
  })

  it('a settlement with a food shortage has reduced births and increased deaths (PHASES.md Done-when: declines)', () => {
    const healthy = computeBirthsAndDeaths(1200, 1830, 1.0, 0.5, ERAS_RULES, POP_RULES)
    const shortage = computeBirthsAndDeaths(1200, 1830, 0.2, 0.5, ERAS_RULES, POP_RULES) // Severe food shortage.
    expect(shortage.births).toBeLessThan(healthy.births)
    expect(shortage.deaths).toBeGreaterThan(healthy.deaths)
    // Net change: a food-shortage settlement should net-decline (deaths exceed births), a healthy one need not.
    expect(shortage.births - shortage.deaths).toBeLessThan(healthy.births - healthy.deaths)
  })
})

describe('computeAttractiveness', () => {
  const WEIGHTS = { jobAvailability: 0.35, realWageIndex: 0.20, needsCoverage: 0.20, housingRoom: 0.15, serviceIndex: 0.10 }

  it('is 1 when every input is 1 (weights sum to 1)', () => {
    const inputs = { jobAvailability: 1, realWageIndex: 1, needsCoverage: 1, housingRoom: 1, serviceIndex: 1 }
    expect(computeAttractiveness(inputs, WEIGHTS)).toBeCloseTo(1)
  })

  it('is 0 when every input is 0', () => {
    const inputs = { jobAvailability: 0, realWageIndex: 0, needsCoverage: 0, housingRoom: 0, serviceIndex: 0 }
    expect(computeAttractiveness(inputs, WEIGHTS)).toBe(0)
  })

  it('weights jobAvailability most heavily', () => {
    const inputs = { jobAvailability: 1, realWageIndex: 0, needsCoverage: 0, housingRoom: 0, serviceIndex: 0 }
    expect(computeAttractiveness(inputs, WEIGHTS)).toBeCloseTo(0.35)
  })
})

describe('computeMigrationFromSettlement', () => {
  it('matches a hand-computed value for one candidate', () => {
    // decay = 1/(1+20/20) = 0.5. moved = 1000*0.02*(0.6-0.3)*1*0.5 = 3.
    const result = computeMigrationFromSettlement(1000, 0.02, 0.3, [{ toId: 2, toAttractiveness: 0.6, condition: 1, distanceMiles: 20 }], 0.03, 20)
    expect(result).toEqual([{ toId: 2, moved: 3 }])
  })

  it('never moves people toward a less attractive settlement', () => {
    const result = computeMigrationFromSettlement(1000, 0.02, 0.6, [{ toId: 2, toAttractiveness: 0.3, condition: 1, distanceMiles: 0 }], 0.03, 20)
    expect(result[0].moved).toBe(0)
  })

  it('a worse road (lower condition) eases less migration', () => {
    const good = computeMigrationFromSettlement(1000, 0.02, 0.3, [{ toId: 2, toAttractiveness: 0.6, condition: 1.0, distanceMiles: 0 }], 0.03, 20)
    const poor = computeMigrationFromSettlement(1000, 0.02, 0.3, [{ toId: 2, toAttractiveness: 0.6, condition: 0.2, distanceMiles: 0 }], 0.03, 20)
    expect(poor[0].moved).toBeLessThan(good[0].moved)
  })

  it('a farther destination eases less migration', () => {
    const near = computeMigrationFromSettlement(1000, 0.02, 0.3, [{ toId: 2, toAttractiveness: 0.6, condition: 1, distanceMiles: 5 }], 0.03, 20)
    const far = computeMigrationFromSettlement(1000, 0.02, 0.3, [{ toId: 2, toAttractiveness: 0.6, condition: 1, distanceMiles: 100 }], 0.03, 20)
    expect(far[0].moved).toBeLessThan(near[0].moved)
  })

  it('scales every candidate proportionally when combined desire exceeds the outflow cap', () => {
    const candidates = [2, 3, 4].map((toId) => ({ toId, toAttractiveness: 1, condition: 1, distanceMiles: 0 }))
    // Each alone would desire 1000*0.02*1*1*1 = 20; three of them total 60, cap = 1000*0.03 = 30.
    const result = computeMigrationFromSettlement(1000, 0.02, 0, candidates, 0.03, 20)
    for (const r of result) expect(r.moved).toBeCloseTo(10)
    expect(result.reduce((sum, r) => sum + r.moved, 0)).toBeCloseTo(30)
  })

  it('returns an empty array for a settlement with no road-linked neighbours', () => {
    expect(computeMigrationFromSettlement(1000, 0.02, 0.3, [], 0.03, 20)).toEqual([])
  })
})

describe('applyClassDrift', () => {
  it('moves shares 10% of the way toward job-implied shares in one year', () => {
    const current = { working: 0.85, middle: 0.12, upper: 0.03 }
    const jobImplied = { working: 0.70, middle: 0.25, upper: 0.05 } // Already sums to 1, upper above the floor.
    const next = applyClassDrift(current, jobImplied, POP_RULES)
    expect(next.working).toBeCloseTo(0.835)
    expect(next.middle).toBeCloseTo(0.133)
    expect(next.upper).toBeCloseTo(0.032)
    expect(next.working + next.middle + next.upper).toBeCloseTo(1)
  })

  it('class shares converge toward job-implied shares over many years (PHASES.md Done-when)', () => {
    let shares = { working: 0.85, middle: 0.12, upper: 0.03 }
    const jobImplied = { working: 0.60, middle: 0.32, upper: 0.08 }
    for (let year = 0; year < 50; year++) {
      shares = applyClassDrift(shares, jobImplied, POP_RULES)
    }
    expect(shares.working).toBeCloseTo(jobImplied.working, 2)
    expect(shares.middle).toBeCloseTo(jobImplied.middle, 2)
    expect(shares.upper).toBeCloseTo(jobImplied.upper, 2)
  })

  it('never lets the Upper share fall below the rentier floor, even when job-implied Upper share is lower, and still sums to 1', () => {
    const current = { working: 0.90, middle: 0.09, upper: 0.01 }
    const jobImplied = { working: 0.90, middle: 0.09, upper: 0.01 } // Upper below the 0.03 floor.
    let shares = current
    for (let year = 0; year < 100; year++) {
      shares = applyClassDrift(shares, jobImplied, POP_RULES)
    }
    expect(shares.upper).toBeCloseTo(0.03 / 1.02, 3) // Renormalised floor target, not the raw 0.01.
    expect(shares.working + shares.middle + shares.upper).toBeCloseTo(1)
  })
})
