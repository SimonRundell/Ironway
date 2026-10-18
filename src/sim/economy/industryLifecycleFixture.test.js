import { describe, expect, it } from 'vitest'
import { computeOpeningProbability, evaluateIndustryLifecycle, updateOpeningStreak } from './industryLifecycle.js'
import { allocateLabour, computeEmploymentRate, computeLabourForce } from './jobs.js'

/**
 * T1.22's own "Done when" fixtures (PHASES.md): a sustained coal
 * shortage opens a new mine after the delay; a starved industry halves
 * then closes on schedule; closure sends workers to the unemployed
 * pool; events are logged throughout.
 */

const LIFECYCLE_RULES = {
  openThreshold: 1.5,
  openRequiredMonths: 6,
  openBaseProbability: 0.3,
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

describe('T1.22 fixture: a sustained coal shortage opens a new mine on a valid site after the delay', () => {
  it('the opening probability stays at zero until the sixth consecutive month above openThreshold, then becomes positive', () => {
    const coalPriceMultByMonth = [1.8, 1.7, 1.9, 1.6, 2.0, 1.7, 1.9] // 7 months, all above 1.5.
    let monthsAboveThreshold = 0
    const probabilities = []

    for (const priceMult of coalPriceMultByMonth) {
      monthsAboveThreshold = updateOpeningStreak(monthsAboveThreshold, priceMult, LIFECYCLE_RULES)
      const probability = computeOpeningProbability(
        { monthsAboveThreshold, siteAvailable: true, inputsPlausible: true, eraAllows: true, upperConfidence: 70, economyLevel: 2 },
        LIFECYCLE_RULES,
      )
      probabilities.push(probability)
    }

    // Months 1-5: still waiting out the delay.
    expect(probabilities.slice(0, 5).every((p) => p === 0)).toBe(true)
    // Month 6 onward: the delay has passed, and opening becomes genuinely possible.
    expect(probabilities[5]).toBeGreaterThan(0)
    expect(probabilities[6]).toBeGreaterThan(0)
  })

  it('a dip back to a healthy price resets the delay, so a single good month cancels a near-complete streak', () => {
    let monthsAboveThreshold = 0
    for (const priceMult of [1.8, 1.8, 1.8, 1.8, 1.8]) {
      monthsAboveThreshold = updateOpeningStreak(monthsAboveThreshold, priceMult, LIFECYCLE_RULES)
    }
    expect(monthsAboveThreshold).toBe(5)

    monthsAboveThreshold = updateOpeningStreak(monthsAboveThreshold, 1.2, LIFECYCLE_RULES) // A healthy month.
    expect(monthsAboveThreshold).toBe(0)

    const probability = computeOpeningProbability(
      { monthsAboveThreshold, siteAvailable: true, inputsPlausible: true, eraAllows: true, upperConfidence: 70, economyLevel: 2 },
      LIFECYCLE_RULES,
    )
    expect(probability).toBe(0)
  })

  it('never opens without a valid site, no matter how long the shortage persists', () => {
    let monthsAboveThreshold = 0
    for (let i = 0; i < 12; i++) monthsAboveThreshold = updateOpeningStreak(monthsAboveThreshold, 2.0, LIFECYCLE_RULES)

    const probability = computeOpeningProbability(
      { monthsAboveThreshold, siteAvailable: false, inputsPlausible: true, eraAllows: true, upperConfidence: 70, economyLevel: 2 },
      LIFECYCLE_RULES,
    )
    expect(probability).toBe(0)
  })
})

describe('T1.22 fixture: a starved industry halves then closes on schedule', () => {
  it('runs the full month-by-month progression: no change for 11 months, halves at month 12, no change until month 36, closes at month 36', () => {
    const industryDef = { eraTo: null }
    let monthsLow = 0
    let capacityMultiplier = 1.0
    const events = []

    for (let month = 1; month <= 36; month++) {
      const result = evaluateIndustryLifecycle(
        { utilisation: 0.05, monthsLow, capacityMultiplier, richnessLeft: 1, year: 1830, priceMult: 0.4, industryDef },
        LIFECYCLE_RULES,
      )
      monthsLow = result.monthsLow
      capacityMultiplier = result.capacityMultiplier
      if (result.event) events.push({ month, ...result.event })

      if (month < 12) {
        expect(capacityMultiplier).toBe(1.0)
      } else if (month === 12) {
        expect(capacityMultiplier).toBeCloseTo(0.5) // Halved, on schedule, not a month early or late.
      } else if (month < 36) {
        expect(capacityMultiplier).toBeCloseTo(0.5) // Holding at half capacity while the closure streak builds.
        expect(result.closed).toBe(false)
      } else if (month === 36) {
        expect(result.closed).toBe(true) // 12 months to halve, then a fresh 24 to close: exactly month 36.
      }
    }

    // Events logged throughout (PHASES.md's own wording).
    expect(events).toEqual([
      { month: 12, kind: 'industry_contracted', reason: 'sustained low utilisation' },
      { month: 36, kind: 'industry_closed', reason: 'sustained low utilisation after contraction' },
    ])
  })
})

describe('T1.22 fixture: closure sends workers to the unemployed pool', () => {
  it('removing a closed industry\'s jobs from the settlement\'s total offer measurably raises unemployment', () => {
    const labourForce = computeLabourForce(1000, 0.85) // 850.
    const serviceJobs = 100 // The settlement's other job sources, unaffected by this closure.
    const mineJobs = 120 // industries.json's coal_mine: jobs.working.

    const beforeClosure = allocateLabour({ working: mineJobs + serviceJobs }, { working: labourForce }, [])
    const afterClosure = allocateLabour({ working: serviceJobs }, { working: labourForce }, []) // evaluateIndustryLifecycle returned closed: true; the caller excludes this industry's jobs.

    const employmentRateBefore = computeEmploymentRate(beforeClosure.employed.working, labourForce)
    const employmentRateAfter = computeEmploymentRate(afterClosure.employed.working, labourForce)

    expect(employmentRateAfter).toBeLessThan(employmentRateBefore)

    const unemployedBefore = labourForce - beforeClosure.employed.working
    const unemployedAfter = labourForce - afterClosure.employed.working
    expect(unemployedAfter).toBeGreaterThan(unemployedBefore)
    expect(unemployedAfter - unemployedBefore).toBeCloseTo(mineJobs) // Exactly the closed mine's workforce, not more or less.
  })
})
