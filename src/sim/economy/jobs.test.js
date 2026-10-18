import { describe, expect, it } from 'vitest'
import {
  allocateLabour,
  computeConstructionJobsOffered,
  computeEmploymentRate,
  computeFarmJobsOffered,
  computeIndustryJobsOffered,
  computeJobAvailability,
  computeLabourForce,
  computePlannedUtilisation,
  computeServiceJobsOffered,
} from './jobs.js'

const ERAS_RULES = {
  agriProductivityMultiplier: [{ year: 1830, value: 1.00 }, { year: 1900, value: 1.55 }],
}

const JOBS_RULES = {
  farmLabourShareOfWorking: 0.35,
  serviceJobsPerThousandPopPerWageUnit: 10,
  constructionJobsPerHomeUnit: 0.05,
}

describe('computeLabourForce', () => {
  it('multiplies population by the participation rate', () => {
    expect(computeLabourForce(1000, 0.85)).toBe(850)
  })
})

describe('computePlannedUtilisation', () => {
  it('matches u_planned: the utilisation ignoring labour entirely', () => {
    const industryDef = { jobs: { working: 100, middle: 10, upper: 0 }, inputs: [{ cargo: 'coal', qty: 50 }], outputs: { steel: 80 }, storageMonths: 2 }
    const u = computePlannedUtilisation(industryDef, { coal: 10, steel: 0 }, 1.0)
    expect(u).toBeCloseTo(0.2) // inputsRatio = 10/50 = 0.2; labour is never the constraint here.
  })
})

describe('computeIndustryJobsOffered', () => {
  it('scales jobs by planned utilisation', () => {
    const industryDef = { jobs: { working: 100, middle: 10, upper: 0 } }
    expect(computeIndustryJobsOffered(industryDef, 0.2)).toEqual({ working: 20, middle: 2, upper: 0 })
  })
})

describe('computeFarmJobsOffered', () => {
  it('offers Working-class jobs in a village', () => {
    expect(computeFarmJobsOffered(1000, 'village', 1830, ERAS_RULES, JOBS_RULES)).toBeCloseTo(350)
  })

  it('offers Working-class jobs in a hamlet too', () => {
    expect(computeFarmJobsOffered(1000, 'hamlet', 1830, ERAS_RULES, JOBS_RULES)).toBeCloseTo(350)
  })

  it('offers none in a town, city or capital', () => {
    expect(computeFarmJobsOffered(1000, 'town', 1830, ERAS_RULES, JOBS_RULES)).toBe(0)
    expect(computeFarmJobsOffered(1000, 'city', 1830, ERAS_RULES, JOBS_RULES)).toBe(0)
    expect(computeFarmJobsOffered(1000, 'capital', 1830, ERAS_RULES, JOBS_RULES)).toBe(0)
  })

  it('falls as agricultural productivity rises', () => {
    const early = computeFarmJobsOffered(1000, 'village', 1830, ERAS_RULES, JOBS_RULES)
    const late = computeFarmJobsOffered(1000, 'village', 1900, ERAS_RULES, JOBS_RULES)
    expect(late).toBeLessThan(early)
    expect(late).toBeCloseTo(1000 * (0.35 / 1.55))
  })
})

describe('computeServiceJobsOffered', () => {
  const baseWageByClass = { working: 3.5, middle: 9, upper: 28 }

  it('matches a hand-computed value, split between Working and Middle only', () => {
    const classPop = { working: 6000, middle: 3000, upper: 1000 }
    const result = computeServiceJobsOffered(classPop, baseWageByClass, JOBS_RULES)
    // weightedWage = (6000*3.5+3000*9+1000*28)/10000 = 7.6; total = 10*(10000/1000)*7.6 = 760.
    expect(result.working).toBeCloseTo(760 * (6000 / 9000))
    expect(result.middle).toBeCloseTo(760 * (3000 / 9000))
    expect(result.upper).toBe(0)
  })

  it('offers nothing for a settlement with zero population', () => {
    expect(computeServiceJobsOffered({ working: 0, middle: 0, upper: 0 }, baseWageByClass, JOBS_RULES)).toEqual({ working: 0, middle: 0, upper: 0 })
  })

  it('a wealthier class mix (more Middle/Upper) offers more service jobs for the same total population', () => {
    const poorer = computeServiceJobsOffered({ working: 9000, middle: 900, upper: 100 }, baseWageByClass, JOBS_RULES)
    const wealthier = computeServiceJobsOffered({ working: 5000, middle: 4000, upper: 1000 }, baseWageByClass, JOBS_RULES)
    const poorerTotal = poorer.working + poorer.middle
    const wealthierTotal = wealthier.working + wealthier.middle
    expect(wealthierTotal).toBeGreaterThan(poorerTotal)
  })
})

describe('computeConstructionJobsOffered', () => {
  it('scales Working-class jobs with homes built', () => {
    expect(computeConstructionJobsOffered(50, JOBS_RULES)).toEqual({ working: 2.5, middle: 0, upper: 0 })
  })

  it('offers nothing when no homes are built', () => {
    expect(computeConstructionJobsOffered(0, JOBS_RULES)).toEqual({ working: 0, middle: 0, upper: 0 })
  })
})

describe('allocateLabour', () => {
  it('fills from the home settlement first, then the nearest neighbour if short', () => {
    const jobsOffered = { working: 100, middle: 20, upper: 5 }
    const ownUnemployed = { working: 60, middle: 25, upper: 2 }
    const neighbours = [{ settlementId: 2, unemployed: { working: 30, middle: 0, upper: 10 } }]

    const result = allocateLabour(jobsOffered, ownUnemployed, neighbours)
    expect(result.employed).toEqual({ working: 90, middle: 20, upper: 5 })
    expect(result.vacancies).toEqual({ working: 10, middle: 0, upper: 0 })
  })

  it('leaves vacancies when no neighbour has enough surplus either', () => {
    const result = allocateLabour({ working: 100 }, { working: 60 }, [{ settlementId: 2, unemployed: { working: 5 } }])
    expect(result.employed.working).toBeCloseTo(65)
    expect(result.vacancies.working).toBeCloseTo(35)
  })

  it('draws from a second neighbour once the first is exhausted', () => {
    const neighbours = [
      { settlementId: 2, unemployed: { working: 10 } },
      { settlementId: 3, unemployed: { working: 50 } },
    ]
    const result = allocateLabour({ working: 100 }, { working: 60 }, neighbours)
    expect(result.employed.working).toBeCloseTo(100) // 60 own + 10 + 30 of the 50 available.
    expect(result.vacancies.working).toBe(0)
  })

  it('needs no neighbours at all when the home settlement has enough', () => {
    const result = allocateLabour({ working: 50 }, { working: 100 }, [{ settlementId: 2, unemployed: { working: 1000 } }])
    expect(result.employed.working).toBe(50)
    expect(result.vacancies.working).toBe(0)
  })
})

describe('computeEmploymentRate', () => {
  it('divides employed by labour force', () => {
    expect(computeEmploymentRate(90, 100)).toBeCloseTo(0.9)
  })

  it('is zero for a zero labour force', () => {
    expect(computeEmploymentRate(0, 0)).toBe(0)
  })
})

describe('computeJobAvailability', () => {
  it('matches DESIGN\'s formula directly', () => {
    expect(computeJobAvailability(10, 100)).toBeCloseTo(0.5) // (10/100)*5.
  })

  it('clamps to 1 for abundant vacancies', () => {
    expect(computeJobAvailability(30, 100)).toBe(1) // (30/100)*5 = 1.5, clamped.
  })

  it('is zero for a zero labour force', () => {
    expect(computeJobAvailability(5, 0)).toBe(0)
  })
})
