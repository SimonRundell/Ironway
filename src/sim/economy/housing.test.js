import { describe, expect, it } from 'vitest'
import { applyHousingShrinkage, computeHousingConstruction, computeHousingRoom } from './housing.js'

const POP_RULES = {
  housingRequestThreshold: 0.95,
  materialsPerHomeUnit: 0.1,
  housingShrinkageRatePerMonth: 0.002,
  housingAbandonmentThreshold: 0.70,
}

describe('computeHousingRoom', () => {
  it('is 1 when population is zero', () => {
    expect(computeHousingRoom(0, 1000)).toBe(1)
  })

  it('is 0 when population exactly fills capacity', () => {
    expect(computeHousingRoom(1000, 1000)).toBe(0)
  })

  it('clamps to 0 when over capacity', () => {
    expect(computeHousingRoom(1500, 1000)).toBe(0)
  })

  it('is 0.5 at half occupancy', () => {
    expect(computeHousingRoom(500, 1000)).toBeCloseTo(0.5)
  })

  it('is 0 for zero capacity (never divides by zero)', () => {
    expect(computeHousingRoom(100, 0)).toBe(0)
  })
})

describe('computeHousingConstruction', () => {
  it('requests nothing below the request threshold', () => {
    const result = computeHousingConstruction(900, 1000, { bricks: 1000, planks: 1000, stone: 1000 }, POP_RULES) // 90% occupancy.
    expect(result.homesBuilt).toBe(0)
    expect(result.materialsConsumed).toEqual({ bricks: 0, planks: 0, stone: 0 })
  })

  it('a settlement without bricks, planks or stone cannot add housing (PHASES.md Done-when)', () => {
    const result = computeHousingConstruction(960, 1000, { bricks: 0, planks: 0, stone: 0 }, POP_RULES) // 96% occupancy, shortfall exists.
    expect(result.homesBuilt).toBe(0)
  })

  it('is capped by whichever material is scarcest (missing just one material still stalls fully)', () => {
    // shortfall = 960 - 950 = 10. Each material would need 10*0.1 = 1 tonne. Stone has none.
    const result = computeHousingConstruction(960, 1000, { bricks: 100, planks: 100, stone: 0 }, POP_RULES)
    expect(result.homesBuilt).toBe(0)
  })

  it('builds exactly the shortfall when materials are ample', () => {
    // shortfall = 960 - 950 = 10, needing 1 tonne of each material; all are ample.
    const result = computeHousingConstruction(960, 1000, { bricks: 100, planks: 100, stone: 100 }, POP_RULES)
    expect(result.homesBuilt).toBeCloseTo(10)
    expect(result.materialsConsumed.bricks).toBeCloseTo(1)
    expect(result.materialsConsumed.planks).toBeCloseTo(1)
    expect(result.materialsConsumed.stone).toBeCloseTo(1)
  })

  it('builds a partial amount when materials only cover part of the shortfall', () => {
    // shortfall = 10, needing 1 tonne of each; stone only has 0.4 tonnes -> 4 homes worth.
    const result = computeHousingConstruction(960, 1000, { bricks: 100, planks: 100, stone: 0.4 }, POP_RULES)
    expect(result.homesBuilt).toBeCloseTo(4)
    expect(result.materialsConsumed.stone).toBeCloseTo(0.4)
    expect(result.materialsConsumed.bricks).toBeCloseTo(0.4) // Same homesBuilt rate applied to every material.
  })
})

describe('applyHousingShrinkage', () => {
  it('does not shrink above the abandonment threshold', () => {
    expect(applyHousingShrinkage(750, 1000, POP_RULES)).toBe(1000) // 75% occupancy, threshold is 70%.
  })

  it('shrinks slowly below the abandonment threshold', () => {
    const next = applyHousingShrinkage(500, 1000, POP_RULES) // 50% occupancy.
    expect(next).toBeCloseTo(1000 * 0.998)
  })

  it('does not shrink below zero or divide by zero for an already-empty settlement', () => {
    expect(applyHousingShrinkage(0, 0, POP_RULES)).toBe(0)
  })
})
