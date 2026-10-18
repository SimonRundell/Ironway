import { describe, expect, it } from 'vitest'
import {
  applyIndustryProduction,
  computeFarmOutput,
  computeHinterlandSums,
  computeIndustryUtilisation,
} from './production.js'

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
  },
}

const ERAS_RULES = {
  agriProductivityMultiplier: [
    { year: 1830, value: 1.00 },
    { year: 1900, value: 1.55 },
  ],
}

describe('computeHinterlandSums', () => {
  it('sums suitability scores per settlement, split by landuse class, from a hand-built grid', () => {
    // 2x2 grid. Index = y*width + x. terrain.json's real landuse order:
    // sea=0, lake=1, arable=2, mixed=3, pastoral=4, forest=5, moor=6, marsh=7, rock=8.
    const terrainRules = { landuseEnum: ['sea', 'lake', 'arable', 'mixed', 'pastoral', 'forest', 'moor', 'marsh', 'rock'] }
    const grid = {
      width: 2,
      height: 2,
      region: [1, 1, 2, 2],
      landuse: [2, 3, 4, 5], // arable, mixed, pastoral, forest
      arable: [255, 128, 0, 0],
      pastoral: [0, 64, 255, 0],
    }

    const sums = computeHinterlandSums(grid, [1, 2], terrainRules)

    expect(sums.get(1)).toEqual({
      arableSuit: 255 / 255,
      mixedArableSuit: 128 / 255,
      pastoralSuit: 0,
      mixedPastoralSuit: 64 / 255,
      forestCount: 0,
    })
    expect(sums.get(2)).toEqual({
      arableSuit: 0,
      mixedArableSuit: 0,
      pastoralSuit: 255 / 255,
      mixedPastoralSuit: 0,
      forestCount: 1,
    })
  })

  it('ignores cells whose region does not match any given settlement id (sea, or outside every hinterland)', () => {
    const terrainRules = { landuseEnum: ['sea', 'lake', 'arable', 'mixed', 'pastoral', 'forest', 'moor', 'marsh', 'rock'] }
    const grid = {
      width: 1,
      height: 1,
      region: [0], // no settlement claims this cell.
      landuse: [2],
      arable: [255],
      pastoral: [0],
    }

    const sums = computeHinterlandSums(grid, [1], terrainRules)
    expect(sums.get(1)).toEqual({ arableSuit: 0, mixedArableSuit: 0, pastoralSuit: 0, mixedPastoralSuit: 0, forestCount: 0 })
  })
})

describe('computeFarmOutput', () => {
  const hinterlandSums = { arableSuit: 10, mixedArableSuit: 4, pastoralSuit: 6, mixedPastoralSuit: 2, forestCount: 5 }

  it('matches a hand-computed value in an off-peak month at game start (agriProd 1.0, economy level Normal)', () => {
    // grainBase = (10 + 4*0.3) * 0.5 = 5.6; pastoralBase = (6 + 2*0.3) * 0.15 = 0.99; timberBase = 5*0.3 = 1.5.
    // January (monthIndex 0) is off-peak for both grain and wool: factor 0.9. scale = 1.0 * 1.0 = 1.0.
    const output = computeFarmOutput(hinterlandSums, ECONOMY_RULES, ERAS_RULES, 1830, 0, 1.0)

    expect(output.grain).toBeCloseTo(5.6 * 0.9)
    expect(output.livestock).toBeCloseTo(0.99)
    expect(output.wool).toBeCloseTo(0.99 * 0.9)
    expect(output.milk).toBeCloseTo(0.99)
    expect(output.timber).toBeCloseTo(1.5)
  })

  it('applies the grain seasonal peak factor in a harvest month', () => {
    const output = computeFarmOutput(hinterlandSums, ECONOMY_RULES, ERAS_RULES, 1830, 8, 1.0) // September, in [7,8,9].
    expect(output.grain).toBeCloseTo(5.6 * 1.3)
  })

  it('applies the wool seasonal peak factor in a spring month, independent of grain', () => {
    const output = computeFarmOutput(hinterlandSums, ECONOMY_RULES, ERAS_RULES, 1830, 3, 1.0) // April, in [2,3,4].
    expect(output.wool).toBeCloseTo(0.99 * 1.3)
    expect(output.grain).toBeCloseTo(5.6 * 0.9) // Not a grain peak month.
  })

  it('multiplies by era agricultural productivity and the economy level production multiplier', () => {
    // At year 1900, agriProductivityMultiplier is 1.55 (exact table entry). Economy level multiplier 1.2 (Boom).
    const output = computeFarmOutput(hinterlandSums, ECONOMY_RULES, ERAS_RULES, 1900, 0, 1.2)
    const scale = 1.55 * 1.2
    expect(output.grain).toBeCloseTo(5.6 * 0.9 * scale)
    expect(output.timber).toBeCloseTo(1.5 * scale)
  })

  it('produces nothing from a settlement with no hinterland land at all', () => {
    const empty = { arableSuit: 0, mixedArableSuit: 0, pastoralSuit: 0, mixedPastoralSuit: 0, forestCount: 0 }
    const output = computeFarmOutput(empty, ECONOMY_RULES, ERAS_RULES, 1830, 0, 1.0)
    expect(output).toEqual({ grain: 0, livestock: 0, wool: 0, milk: 0, timber: 0 })
  })
})

describe('computeIndustryUtilisation / applyIndustryProduction', () => {
  const industryDef = {
    jobs: { working: 100, middle: 10, upper: 0 }, // workersNeeded = 110
    inputs: [{ cargo: 'coal', qty: 50 }],
    outputs: { steel: 80 },
    storageMonths: 2, // outputCap = 160
  }

  it('reaches full utilisation when labour, inputs and output room are all abundant', () => {
    const result = computeIndustryUtilisation(industryDef, { coal: 100, steel: 0 }, 110, 1.0)
    expect(result.labour).toBe(1)
    expect(result.inputsRatio).toBe(1)
    expect(result.outputRoom).toBe(1)
    expect(result.u).toBe(1)
    expect(result.resolvedInputs).toEqual([{ cargo: 'coal', qtyAtFullOutput: 50 }])
  })

  it('responds correctly to missing labour: utilisation halves when only half the workers are available', () => {
    const result = computeIndustryUtilisation(industryDef, { coal: 100, steel: 0 }, 55, 1.0)
    expect(result.labour).toBeCloseTo(0.5)
    expect(result.u).toBeCloseTo(0.5)
  })

  it('responds correctly to missing inputs: utilisation is capped by the scarcest input', () => {
    const result = computeIndustryUtilisation(industryDef, { coal: 10, steel: 0 }, 110, 1.0)
    expect(result.inputsRatio).toBeCloseTo(0.2) // 10 / 50
    expect(result.u).toBeCloseTo(0.2)
  })

  it('responds correctly to a full output store: utilisation stalls at zero even with ample labour and inputs', () => {
    const result = computeIndustryUtilisation(industryDef, { coal: 1000, steel: 160 }, 110, 1.0) // steel at its storage cap.
    expect(result.outputRoom).toBe(0)
    expect(result.u).toBe(0)
  })

  it('treats a zero-job industry (no jobs defined) as never labour-constrained', () => {
    const noJobsIndustry = { ...industryDef, jobs: { working: 0, middle: 0, upper: 0 } }
    const result = computeIndustryUtilisation(noJobsIndustry, { coal: 100, steel: 0 }, 0, 1.0)
    expect(result.labour).toBe(1)
  })

  it('treats an industry with no inputs (a primary/extractive industry) as never input-constrained', () => {
    const primaryIndustry = { jobs: { working: 10 }, inputs: [], outputs: { coal: 3000 }, storageMonths: 2 }
    const result = computeIndustryUtilisation(primaryIndustry, {}, 10, 1.0)
    expect(result.inputsRatio).toBe(1)
    expect(result.resolvedInputs).toEqual([])
  })

  it('caps utilisation at 1.3 even when the economy production multiplier would push it higher', () => {
    const result = computeIndustryUtilisation(industryDef, { coal: 1000, steel: 0 }, 110, 2.0)
    expect(result.u).toBe(1.3)
  })

  it('resolves an {any} substitution slot to whichever option has the best stock coverage, not a fixed preference order', () => {
    const substitutable = { jobs: { working: 10 }, inputs: [{ any: { wool: 100, cotton: 100 } }], outputs: { cloth: 90 }, storageMonths: 1 }
    const result = computeIndustryUtilisation(substitutable, { wool: 30, cotton: 80 }, 10, 1.0)
    expect(result.resolvedInputs).toEqual([{ cargo: 'cotton', qtyAtFullOutput: 100 }])
    expect(result.inputsRatio).toBeCloseTo(0.8)
  })

  it('applyIndustryProduction adds u*outputs and removes u*inputs, never driving stock negative', () => {
    const result = computeIndustryUtilisation(industryDef, { coal: 10, steel: 0 }, 110, 1.0) // u = 0.2
    const next = applyIndustryProduction({ coal: 10, steel: 0 }, result.u, industryDef, result.resolvedInputs)
    expect(next.coal).toBeCloseTo(0) // 10 - 0.2*50 = 0 exactly.
    expect(next.steel).toBeCloseTo(16) // 0 + 0.2*80.
  })

  it('applyIndustryProduction draws only from the resolved substitute, leaving the other option untouched', () => {
    const substitutable = { jobs: { working: 10 }, inputs: [{ any: { wool: 100, cotton: 100 } }], outputs: { cloth: 90 }, storageMonths: 1 }
    const result = computeIndustryUtilisation(substitutable, { wool: 30, cotton: 80 }, 10, 1.0)
    const next = applyIndustryProduction({ wool: 30, cotton: 80 }, result.u, substitutable, result.resolvedInputs)
    expect(next.cotton).toBeCloseTo(80 - result.u * 100)
    expect(next.wool).toBe(30) // Untouched: the facility drew from cotton, not wool.
  })
})
