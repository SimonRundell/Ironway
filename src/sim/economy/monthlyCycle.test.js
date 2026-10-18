import { describe, expect, it } from 'vitest'
import { applyIndustryProduction, computeFarmOutput, computeIndustryUtilisation } from './production.js'
import { computePopulationDemand } from './demand.js'
import { decayStock } from './decay.js'

/**
 * T1.16's "Done when" integration fixture (PHASES.md): a single
 * settlement with one hinterland and one co-located industry, run for
 * 120 months, checking the whole thing never produces NaN/Infinity and
 * settles into a predictable steady state. Labour and grain supply to
 * the industry are both held at "ample" throughout, since there is no
 * employment model (T1.20) or inter-node flow (T1.18) yet to produce
 * them realistically — this fixture is only exercising T1.16's own
 * formulas (farm output, industry utilisation, decay), not the whole
 * economy.
 *
 * The calendar year is held constant at 1830 throughout, isolating the
 * fixture from `eras.json`'s slow agricultural-productivity drift
 * (T1.15's clock, not this module, owns real calendar advancement);
 * this keeps every cargo's steady state an exact, hand-checkable
 * closed form rather than a slowly-moving target.
 */

const ECONOMY_RULES = {
  yields: {
    grainPerArableCellPerMonth: 0.5,
    pastoralOutputPerCellPerMonth: 0.15,
    timberPerForestCellPerMonth: 0.3,
    mixedCellYieldFactor: 0.5,
    mixedCellBothFactor: 0.6,
  },
  seasonal: {
    grainHarvestPeakMonths: [7, 8, 9],
    woolSpringPeakMonths: [2, 3, 4],
    seasonalPeakFactor: 1.3,
    seasonalOffPeakFactor: 0.9,
    coalDemandFactorByMonth: [1.6, 1.5, 1.3, 1.0, 0.8, 0.6, 0.6, 0.6, 0.8, 1.0, 1.3, 1.5],
  },
  demandPerThousandPerMonth: {
    food: { working: 30, middle: 34, upper: 40 },
    coal: { working: 15, middle: 20, upper: 25 },
  },
  confidenceSpendingFactor: { atConfidence0: 0.7, atConfidence50: 1.0, atConfidence100: 1.2 },
}

const ERAS_RULES = { agriProductivityMultiplier: [{ year: 1830, value: 1.00 }, { year: 1930, value: 1.85 }] }

const CARGO_CATALOGUE = [
  { id: 'grain', decayPerMonth: 0.01 },
  { id: 'livestock', decayPerMonth: 0.02 },
  { id: 'wool', decayPerMonth: 0.003 },
  { id: 'milk', decayPerMonth: 0.30 },
  { id: 'flour', decayPerMonth: 0.02 },
]

const HINTERLAND_SUMS = { arableSuit: 20, mixedArableSuit: 0, pastoralSuit: 10, mixedPastoralSuit: 0, forestCount: 0 }

const MILL_DEF = {
  jobs: { working: 12, middle: 3, upper: 1 }, // workersNeeded = 16
  inputs: [{ cargo: 'grain', qty: 600 }],
  outputs: { flour: 540 },
  storageMonths: 2, // outputCap = 1080
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0
}

describe('T1.16 single-settlement fixture: 120 months, no NaN, reaches a steady state', () => {
  it('runs 120 months without ever producing NaN, Infinity or a negative stock value', () => {
    let settlementStock = {}
    let millStock = { grain: 100000 } // Ample pre-stocked grain: this fixture isolates production/decay, not flows (T1.18).
    const classRows = [{ classId: 'working', pop: 2000, confidence: 50 }]

    for (let month = 1; month <= 120; month++) {
      const monthIndex = (month - 1) % 12
      const year = 1830 // Held constant; see file header comment.

      const farmOutput = computeFarmOutput(HINTERLAND_SUMS, ECONOMY_RULES, ERAS_RULES, year, monthIndex, 1.0)
      for (const [cargo, qty] of Object.entries(farmOutput)) {
        expect(Number.isFinite(qty)).toBe(true)
        settlementStock[cargo] = (settlementStock[cargo] || 0) + qty
      }

      millStock.grain += 600 // Top up grain every month, standing in for an unmodelled flow/import.
      const millResult = computeIndustryUtilisation(MILL_DEF, millStock, 16, 1.0)
      expect(Number.isFinite(millResult.u)).toBe(true)
      millStock = applyIndustryProduction(millStock, millResult.u, MILL_DEF, millResult.resolvedInputs)

      settlementStock = decayStock(settlementStock, CARGO_CATALOGUE)
      millStock = decayStock(millStock, CARGO_CATALOGUE)

      const demand = computePopulationDemand(classRows, 'town', 'complex', ECONOMY_RULES, 1.0, monthIndex, year)

      for (const stock of [settlementStock, millStock]) {
        for (const qty of Object.values(stock)) {
          expect(isFiniteNonNegative(qty)).toBe(true)
        }
      }
      for (const qty of Object.values(demand)) {
        expect(isFiniteNonNegative(qty)).toBe(true)
      }
    }
  })

  it('the mill (a decaying, capacity-limited output) converges to an exact, hand-derivable steady state', () => {
    // u = 1 every month (ample grain and labour throughout), so flour's
    // recurrence is exactly S(n+1) = (1-decay) * (S(n) + min(540, 1080-S(n))).
    // Once S(n) > 540 this simplifies to (1-decay)*1080 every subsequent
    // month -- an exact fixed point, not merely an approached limit.
    let millStock = { grain: 100000 }

    for (let month = 1; month <= 120; month++) {
      millStock.grain += 600
      const result = computeIndustryUtilisation(MILL_DEF, millStock, 16, 1.0)
      millStock = applyIndustryProduction(millStock, result.u, MILL_DEF, result.resolvedInputs)
      millStock = decayStock(millStock, CARGO_CATALOGUE)
    }

    expect(millStock.flour).toBeCloseTo(0.98 * 1080, 6) // = 1058.4, reached by month 4 and exactly held from then on.
  })

  it('a non-seasonal decaying farm cargo (livestock) matches its exact closed-form trajectory after 120 months', () => {
    // livestock production is constant every month at this fixed
    // hinterland/year (no seasonal factor applies to livestock). Decay
    // (DESIGN 7.1 step 5) runs *after* that month's output is added, so
    // the freshly-produced tonnes decay too in the same month: the
    // recurrence is S(n+1) = (1-decay)*(S(n) + production), whose closed
    // form is S(n) = asymptote * (1 - (1-decay)^n), where
    // asymptote = (1-decay)*production/decay.
    let settlementStock = {}
    const monthlyProduction = computeFarmOutput(HINTERLAND_SUMS, ECONOMY_RULES, ERAS_RULES, 1830, 0, 1.0).livestock
    const decay = CARGO_CATALOGUE.find((c) => c.id === 'livestock').decayPerMonth
    const asymptote = ((1 - decay) * monthlyProduction) / decay

    for (let month = 1; month <= 120; month++) {
      settlementStock.livestock = (settlementStock.livestock || 0) + monthlyProduction
      settlementStock = decayStock(settlementStock, CARGO_CATALOGUE)
    }

    const expected = asymptote * (1 - (1 - decay) ** 120)
    expect(settlementStock.livestock).toBeCloseTo(expected, 6)
    // And it has genuinely settled near its asymptote (~73.5), not drifted off to it.
    expect(settlementStock.livestock).toBeGreaterThan(asymptote * 0.8)
    expect(settlementStock.livestock).toBeLessThan(asymptote)
  })

  it('a fast-decaying perishable (milk) reaches its steady state almost immediately', () => {
    let settlementStock = {}
    const monthlyProduction = computeFarmOutput(HINTERLAND_SUMS, ECONOMY_RULES, ERAS_RULES, 1830, 0, 1.0).milk
    const decay = CARGO_CATALOGUE.find((c) => c.id === 'milk').decayPerMonth
    const asymptote = ((1 - decay) * monthlyProduction) / decay

    for (let month = 1; month <= 120; month++) {
      settlementStock.milk = (settlementStock.milk || 0) + monthlyProduction
      settlementStock = decayStock(settlementStock, CARGO_CATALOGUE)
    }

    expect(settlementStock.milk).toBeCloseTo(asymptote, 6) // = 3.5, converged to machine precision given 0.70^120 is negligible.
  })
})
