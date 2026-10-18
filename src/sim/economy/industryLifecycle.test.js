import { describe, expect, it } from 'vitest'
import {
  computeOpeningProbability,
  computeRichnessDepletion,
  evaluateIndustryLifecycle,
  getEligibleSuccessor,
  scaleIndustryDef,
  updateOpeningStreak,
} from './industryLifecycle.js'

const LIFECYCLE_RULES = {
  openThreshold: 1.5,
  openRequiredMonths: 6,
  openBaseProbability: 0.3,
  openInputSearchRadiusMiles: 40,
  expansionRequiredMonths: 12,
  expansionUtilisationThreshold: 0.9,
  expansionCapacityGain: 0.2,
  maxCapacityMultiplier: 2.0,
  unmetPriceSignalThreshold: 1.0,
  contractionRequiredMonths: 12,
  contractionUtilisationThreshold: 0.3,
  contractionCapacityFactor: 0.5,
  closureRequiredMonths: 24,
  closureUtilisationThreshold: 0.15,
  depositLifetimeMonthsAtFullOutput: 600,
}

describe('scaleIndustryDef', () => {
  it('scales jobs, plain input quantities and outputs by the capacity multiplier', () => {
    const industryDef = { jobs: { working: 120, middle: 6, upper: 1 }, inputs: [{ cargo: 'coal', qty: 160 }], outputs: { bricks: 700 }, storageMonths: 2 }
    const scaled = scaleIndustryDef(industryDef, 1.2)
    expect(scaled.jobs.working).toBeCloseTo(144)
    expect(scaled.jobs.middle).toBeCloseTo(7.2)
    expect(scaled.jobs.upper).toBeCloseTo(1.2)
    expect(scaled.inputs[0].cargo).toBe('coal')
    expect(scaled.inputs[0].qty).toBeCloseTo(192)
    expect(scaled.outputs.bricks).toBeCloseTo(840)
    expect(scaled.storageMonths).toBe(2) // Unchanged: a time constant, not a capacity.
  })

  it('scales every option inside an {any} substitution slot', () => {
    const industryDef = { jobs: { working: 10 }, inputs: [{ any: { wool: 100, cotton: 100 } }], outputs: { cloth: 90 }, storageMonths: 2 }
    const scaled = scaleIndustryDef(industryDef, 0.5)
    expect(scaled.inputs).toEqual([{ any: { wool: 50, cotton: 50 } }])
  })

  it('leaves an unmodified copy at multiplier 1.0', () => {
    const industryDef = { jobs: { working: 10, middle: 0, upper: 0 }, inputs: [], outputs: { coal: 100 }, storageMonths: 2 }
    expect(scaleIndustryDef(industryDef, 1.0)).toEqual(industryDef)
  })
})

describe('updateOpeningStreak', () => {
  it('increments while the mean stays above the threshold', () => {
    expect(updateOpeningStreak(3, 1.6, LIFECYCLE_RULES)).toBe(4)
  })

  it('resets to zero the moment the mean drops to or below the threshold', () => {
    expect(updateOpeningStreak(5, 1.5, LIFECYCLE_RULES)).toBe(0) // Exactly at the threshold: not "above".
    expect(updateOpeningStreak(5, 1.4, LIFECYCLE_RULES)).toBe(0)
  })
})

describe('computeOpeningProbability', () => {
  const baseSignal = { monthsAboveThreshold: 6, siteAvailable: true, inputsPlausible: true, eraAllows: true, upperConfidence: 80, economyLevel: 2 }

  it('matches a hand-computed value', () => {
    // confidenceFactor = 0.8, economyLevelFactor = (2+1)/5 = 0.6.
    expect(computeOpeningProbability(baseSignal, LIFECYCLE_RULES)).toBeCloseTo(0.3 * 0.8 * 0.6)
  })

  it('is zero before the required streak completes', () => {
    expect(computeOpeningProbability({ ...baseSignal, monthsAboveThreshold: 5 }, LIFECYCLE_RULES)).toBe(0)
  })

  it('is zero without a suitable site', () => {
    expect(computeOpeningProbability({ ...baseSignal, siteAvailable: false }, LIFECYCLE_RULES)).toBe(0)
  })

  it('is zero without plausible inputs', () => {
    expect(computeOpeningProbability({ ...baseSignal, inputsPlausible: false }, LIFECYCLE_RULES)).toBe(0)
  })

  it('is zero outside the cargo\'s era', () => {
    expect(computeOpeningProbability({ ...baseSignal, eraAllows: false }, LIFECYCLE_RULES)).toBe(0)
  })

  it('reaches its maximum at full Upper confidence and Boom economy level', () => {
    expect(computeOpeningProbability({ ...baseSignal, upperConfidence: 100, economyLevel: 4 }, LIFECYCLE_RULES)).toBeCloseTo(0.3)
  })

  it('is lowest (but still possible) at zero confidence and Depression', () => {
    const result = computeOpeningProbability({ ...baseSignal, upperConfidence: 0, economyLevel: 0 }, LIFECYCLE_RULES)
    expect(result).toBeCloseTo(0.3 * 0 * 0.2)
    expect(result).toBe(0)
  })
})

describe('computeRichnessDepletion', () => {
  it('depletes in proportion to utilisation', () => {
    expect(computeRichnessDepletion(1.0, 1.0, LIFECYCLE_RULES)).toBeCloseTo(1 - 1 / 600)
  })

  it('depletes half as fast at half utilisation', () => {
    expect(computeRichnessDepletion(1.0, 0.5, LIFECYCLE_RULES)).toBeCloseTo(1 - 0.5 / 600)
  })

  it('does not deplete at zero utilisation', () => {
    expect(computeRichnessDepletion(0.5, 0, LIFECYCLE_RULES)).toBe(0.5)
  })

  it('floors at zero rather than going negative', () => {
    expect(computeRichnessDepletion(0.0005, 1.0, LIFECYCLE_RULES)).toBe(0)
  })
})

describe('getEligibleSuccessor', () => {
  const industriesById = new Map([['diesel_mine', { id: 'diesel_mine', eraFrom: 1950 }]])

  it('returns null when no successor is set', () => {
    expect(getEligibleSuccessor({ successorId: null }, 1960, industriesById)).toBeNull()
  })

  it('returns null before the successor\'s own era arrives', () => {
    expect(getEligibleSuccessor({ successorId: 'diesel_mine' }, 1945, industriesById)).toBeNull()
  })

  it('returns the successor once its era arrives', () => {
    const successor = getEligibleSuccessor({ successorId: 'diesel_mine' }, 1955, industriesById)
    expect(successor.id).toBe('diesel_mine')
  })

  it('returns null if the successor id is unknown (defensive)', () => {
    expect(getEligibleSuccessor({ successorId: 'nonexistent' }, 1999, industriesById)).toBeNull()
  })
})

describe('evaluateIndustryLifecycle', () => {
  const industryDef = { eraTo: null }

  it('deposit depletion closes immediately, regardless of utilisation or streak', () => {
    const result = evaluateIndustryLifecycle({ utilisation: 0.95, monthsLow: 0, capacityMultiplier: 1.0, richnessLeft: 0, year: 1830, priceMult: 1.2, industryDef }, LIFECYCLE_RULES)
    expect(result.closed).toBe(true)
    expect(result.event).toEqual({ kind: 'industry_closed', reason: 'deposit depleted' })
  })

  describe('expansion', () => {
    it('expands once the high-utilisation streak completes with an unmet price signal and room to grow', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.95, monthsLow: 11, capacityMultiplier: 1.0, richnessLeft: 1, year: 1830, priceMult: 1.2, industryDef }, LIFECYCLE_RULES)
      expect(result.capacityMultiplier).toBeCloseTo(1.2)
      expect(result.monthsLow).toBe(0)
      expect(result.event.kind).toBe('industry_expanded')
    })

    it('does not expand before the streak completes', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.95, monthsLow: 10, capacityMultiplier: 1.0, richnessLeft: 1, year: 1830, priceMult: 1.2, industryDef }, LIFECYCLE_RULES)
      expect(result.capacityMultiplier).toBe(1.0)
      expect(result.monthsLow).toBe(11)
      expect(result.event).toBeNull()
    })

    it('does not expand without an unmet price signal, even with a complete streak', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.95, monthsLow: 11, capacityMultiplier: 1.0, richnessLeft: 1, year: 1830, priceMult: 0.8, industryDef }, LIFECYCLE_RULES)
      expect(result.capacityMultiplier).toBe(1.0)
      expect(result.event).toBeNull()
    })

    it('does not expand past the capacity cap', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.95, monthsLow: 11, capacityMultiplier: 2.0, richnessLeft: 1, year: 1830, priceMult: 1.5, industryDef }, LIFECYCLE_RULES)
      expect(result.capacityMultiplier).toBe(2.0)
      expect(result.event).toBeNull()
    })
  })

  describe('contraction and closure (PHASES.md Done-when: a starved industry halves then closes on schedule)', () => {
    it('halves capacity once the low-utilisation streak completes', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.1, monthsLow: 11, capacityMultiplier: 1.0, richnessLeft: 1, year: 1830, priceMult: 0.5, industryDef }, LIFECYCLE_RULES)
      expect(result.capacityMultiplier).toBeCloseTo(0.5)
      expect(result.monthsLow).toBe(0)
      expect(result.closed).toBe(false)
      expect(result.event.kind).toBe('industry_contracted')
    })

    it('does not contract before the streak completes', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.1, monthsLow: 10, capacityMultiplier: 1.0, richnessLeft: 1, year: 1830, priceMult: 0.5, industryDef }, LIFECYCLE_RULES)
      expect(result.capacityMultiplier).toBe(1.0)
      expect(result.monthsLow).toBe(11)
    })

    it('closes an already-contracted industry once the closure streak completes', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.1, monthsLow: 23, capacityMultiplier: 0.5, richnessLeft: 1, year: 1830, priceMult: 0.5, industryDef }, LIFECYCLE_RULES)
      expect(result.closed).toBe(true)
      expect(result.event.kind).toBe('industry_closed')
    })

    it('does not close before the closure streak completes', () => {
      const result = evaluateIndustryLifecycle({ utilisation: 0.1, monthsLow: 22, capacityMultiplier: 0.5, richnessLeft: 1, year: 1830, priceMult: 0.5, industryDef }, LIFECYCLE_RULES)
      expect(result.closed).toBe(false)
      expect(result.monthsLow).toBe(23)
    })

    it('exiting the low band after contraction resets the streak (recovery)', () => {
      // 0.2 utilisation is below the pre-contraction 0.3 bar but above the post-contraction 0.15 bar.
      const result = evaluateIndustryLifecycle({ utilisation: 0.2, monthsLow: 20, capacityMultiplier: 0.5, richnessLeft: 1, year: 1830, priceMult: 0.9, industryDef }, LIFECYCLE_RULES)
      expect(result.monthsLow).toBe(0)
      expect(result.closed).toBe(false)
    })
  })

  describe('era retirement', () => {
    it('forces the low-utilisation path regardless of actual utilisation once past eraTo', () => {
      const retiredDef = { eraTo: 1930 }
      const result = evaluateIndustryLifecycle({ utilisation: 1.0, monthsLow: 11, capacityMultiplier: 1.0, richnessLeft: 1, year: 1935, priceMult: 2.0, industryDef: retiredDef }, LIFECYCLE_RULES)
      expect(result.capacityMultiplier).toBeCloseTo(0.5) // Contracted, not expanded, despite utilisation 1.0.
      expect(result.event.reason).toBe('past its era')
    })

    it('does not force retirement before eraTo', () => {
      const notYetRetiredDef = { eraTo: 1950 }
      const result = evaluateIndustryLifecycle({ utilisation: 1.0, monthsLow: 0, capacityMultiplier: 1.0, richnessLeft: 1, year: 1935, priceMult: 2.0, industryDef: notYetRetiredDef }, LIFECYCLE_RULES)
      expect(result.event).toBeNull()
      expect(result.monthsLow).toBe(1) // Counting toward expansion normally.
    })
  })

  it('resets the streak in the normal utilisation band', () => {
    const result = evaluateIndustryLifecycle({ utilisation: 0.5, monthsLow: 5, capacityMultiplier: 1.0, richnessLeft: 1, year: 1830, priceMult: 1.0, industryDef }, LIFECYCLE_RULES)
    expect(result.monthsLow).toBe(0)
    expect(result.capacityMultiplier).toBe(1.0)
    expect(result.event).toBeNull()
  })
})
