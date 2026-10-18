import { describe, expect, it } from 'vitest'
import { allocateLabour, computeEmploymentRate, computeLabourForce } from './jobs.js'
import { computeRawConfidence, computeWage, computeRealWageIndex, smoothConfidence } from './confidence.js'

/**
 * T1.20's own "Done when" fixture (PHASES.md): a mine closure must
 * raise local unemployment and lower confidence in the home settlement
 * within 3 months.
 */

const WAGE_RULES = { tightnessSensitivity: 0.2 }
const CONFIDENCE_RULES = {
  weights: { employmentRate: 0.40, realWageIndex: 0.25, needsCoverage: 0.20, overcrowding: 0.15 },
  smoothingOldWeight: 0.7,
  smoothingNewWeight: 0.3,
}

describe('T1.20 fixture: a mine closure raises unemployment and lowers confidence within 3 months', () => {
  const labourForce = computeLabourForce(1000, 0.85) // 850 working-class labour force (a mine town).
  const baseWage = 3.5 // Working class.
  const costOfLiving = 20 // Held fixed: isolates the employment -> confidence channel this fixture is about.
  const needsCoverage = 0.8 // Held fixed, for the same reason.
  const occupancy = 0.8 // No overcrowding either way.

  function employmentAndConfidence(jobsOffered) {
    const { employed } = allocateLabour({ working: jobsOffered }, { working: labourForce }, [])
    const employmentRate = computeEmploymentRate(employed.working, labourForce)
    const wage = computeWage(baseWage, employmentRate, WAGE_RULES)
    const realWageIndex = computeRealWageIndex(wage, employmentRate, costOfLiving)
    const rawConfidence = computeRawConfidence({ employmentRate, realWageIndex, needsCoverage, occupancy }, CONFIDENCE_RULES)
    return { employmentRate, rawConfidence }
  }

  it('demonstrates the full before/after/smoothed sequence', () => {
    // Coal mine (industries.json: jobs.working = 120) plus a steady 100 working-class service jobs.
    const before = employmentAndConfidence(120 + 100)
    const after = employmentAndConfidence(100) // The mine closes: its 120 jobs vanish.

    // Unemployment rises: employment rate measurably drops.
    expect(after.employmentRate).toBeLessThan(before.employmentRate)
    const unemploymentBefore = labourForce - labourForce * before.employmentRate
    const unemploymentAfter = labourForce - labourForce * after.employmentRate
    expect(unemploymentAfter).toBeGreaterThan(unemploymentBefore)

    // Confidence, smoothed month by month starting from the pre-closure steady state, is measurably lower within 3 months.
    let confidence = before.rawConfidence // Assume the settlement had settled at its pre-closure raw confidence.
    for (let month = 0; month < 3; month++) {
      confidence = smoothConfidence(confidence, after.rawConfidence, CONFIDENCE_RULES)
    }

    expect(confidence).toBeLessThan(before.rawConfidence)
    // Still converging, not fully there (DESIGN 7.7: "so one bad month does not swing everything").
    expect(confidence).toBeGreaterThan(after.rawConfidence)
  })
})
