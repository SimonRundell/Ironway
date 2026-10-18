import { describe, expect, it } from 'vitest'
import { computeCostOfLiving, computeCoverage, computeCoveragePower, computePrice, computePriceMultiplier } from './prices.js'

const PRICE_RULES = { pMin: 0.4, pMax: 3.0 }
const ELASTICITIES = [0.3, 0.4, 0.5, 0.6, 0.7] // Must match cargo.json's distinct values (see priceTables.generated.js).

describe('computeCoverage', () => {
  it('divides stock by demand', () => {
    expect(computeCoverage(100, 50)).toBe(2)
    expect(computeCoverage(50, 100)).toBe(0.5)
  })

  it('returns Infinity when demand is zero, per DESIGN 7.4\'s own comment', () => {
    expect(computeCoverage(100, 0)).toBe(Infinity)
  })

  it('returns Infinity for a negligible (but non-zero) demand too', () => {
    expect(computeCoverage(100, 1e-12)).toBe(Infinity)
  })

  it('handles zero stock against real demand', () => {
    expect(computeCoverage(0, 50)).toBe(0)
  })
})

describe('computeCoveragePower (table-based, vs a high-precision Math.pow reference)', () => {
  it('matches Math.pow within 0.5% across the table\'s full coverage range, for every baked elasticity', () => {
    const coverageSamples = [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 19.99]

    for (const elasticity of ELASTICITIES) {
      for (const coverage of coverageSamples) {
        const reference = Math.pow(coverage, -elasticity)
        const tableValue = computeCoveragePower(coverage, elasticity)
        const relativeError = Math.abs(tableValue - reference) / reference
        expect(relativeError, `coverage=${coverage}, elasticity=${elasticity}`).toBeLessThan(0.005)
      }
    }
  })

  it('returns exactly 1 at coverage 1 for any elasticity (x^0... no: x^(-e) at x=1 is 1 for any e)', () => {
    for (const elasticity of ELASTICITIES) {
      expect(computeCoveragePower(1, elasticity)).toBeCloseTo(1, 2)
    }
  })

  it('throws a clear error for an elasticity with no baked table', () => {
    expect(() => computeCoveragePower(1, 0.9999)).toThrow(/no baked price table/)
  })
})

describe('computePriceMultiplier', () => {
  it('respects pMin and pMax bounds for extreme coverage', () => {
    expect(computePriceMultiplier(0, 0.5, PRICE_RULES)).toBe(PRICE_RULES.pMax) // No stock at all: scarce, price ceiling.
    expect(computePriceMultiplier(19.99, 0.3, PRICE_RULES)).toBeGreaterThanOrEqual(PRICE_RULES.pMin)
    expect(computePriceMultiplier(19.99, 0.3, PRICE_RULES)).toBeLessThanOrEqual(PRICE_RULES.pMax)
  })

  it('zero-demand nodes sit exactly at the floor (PHASES.md\'s own wording)', () => {
    const coverage = computeCoverage(500, 0) // Infinity.
    expect(computePriceMultiplier(coverage, 0.5, PRICE_RULES)).toBe(PRICE_RULES.pMin)
  })

  it('sits near 1.0 (neither floor nor ceiling) when stock exactly matches demand', () => {
    const coverage = computeCoverage(100, 100)
    expect(computePriceMultiplier(coverage, 0.5, PRICE_RULES)).toBeCloseTo(1, 2)
  })

  it('never exceeds pMax even for abundant scarcity (very low coverage)', () => {
    const coverage = computeCoverage(1, 1000) // coverage = 0.001.
    expect(computePriceMultiplier(coverage, 0.7, PRICE_RULES)).toBe(PRICE_RULES.pMax)
  })

  it('never drops below pMin even for extreme abundance', () => {
    const coverage = computeCoverage(100000, 10)
    expect(computePriceMultiplier(coverage, 0.3, PRICE_RULES)).toBe(PRICE_RULES.pMin)
  })
})

describe('computePrice', () => {
  it('multiplies base price by the price multiplier and the economy revenue multiplier', () => {
    expect(computePrice(10, 1.5, 1.0)).toBeCloseTo(15)
    expect(computePrice(10, 1.5, 1.08)).toBeCloseTo(16.2)
  })
})

describe('computeCostOfLiving', () => {
  it('sums the food, coal, clothing and goods basket prices', () => {
    const localPrices = { food: 20, coal: 5, clothing: 90, goods: 85, luxuries: 300 }
    expect(computeCostOfLiving(localPrices)).toBeCloseTo(20 + 5 + 90 + 85)
  })

  it('treats a missing basket cargo price as zero rather than throwing', () => {
    expect(computeCostOfLiving({ food: 20 })).toBeCloseTo(20)
  })

  it('is zero when no prices are known at all', () => {
    expect(computeCostOfLiving({})).toBe(0)
  })
})
