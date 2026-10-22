import { describe, expect, it } from 'vitest'
import {
  confidenceForSettlement,
  employmentRateForSettlement,
  linkTotalFlow,
  metricRange,
  normaliseValue,
  rampColour,
  settlementMetrics,
} from './overlays.js'

function makeSettlement(overrides = {}) {
  return {
    id: 1,
    name: 'Testford',
    kind: 'town',
    x: 10,
    y: 20,
    pop: {
      0: { pop: 6000, employed: 5400, confidence: 70 },
      1: { pop: 3000, employed: 2400, confidence: 50 },
      2: { pop: 1000, employed: 900, confidence: 90 },
    },
    stock: {},
    ...overrides,
  }
}

describe('rampColour', () => {
  const stops = ['#000000', '#ffffff']

  it('returns the first stop at t=0 and the last stop at t=1', () => {
    expect(rampColour(0, stops)).toBe('rgb(0, 0, 0)')
    expect(rampColour(1, stops)).toBe('rgb(255, 255, 255)')
  })

  it('interpolates at the midpoint', () => {
    expect(rampColour(0.5, stops)).toBe('rgb(128, 128, 128)')
  })

  it('clamps out-of-range t', () => {
    expect(rampColour(-1, stops)).toBe('rgb(0, 0, 0)')
    expect(rampColour(2, stops)).toBe('rgb(255, 255, 255)')
  })

  it('interpolates across a middle stop in a 3-stop ramp', () => {
    const threeStops = ['#000000', '#ff0000', '#ffffff']
    expect(rampColour(0.5, threeStops)).toBe('rgb(255, 0, 0)')
  })
})

describe('confidenceForSettlement', () => {
  it('computes the population-weighted mean', () => {
    const settlement = makeSettlement()
    // (6000*70 + 3000*50 + 1000*90) / 10000 = 66
    expect(confidenceForSettlement(settlement)).toBeCloseTo(66, 5)
  })

  it('returns 50 for a settlement with no population yet', () => {
    const settlement = makeSettlement({ pop: { 0: { pop: 0, employed: 0, confidence: 70 } } })
    expect(confidenceForSettlement(settlement)).toBe(50)
  })
})

describe('employmentRateForSettlement', () => {
  it('computes island-standard employment across every class', () => {
    const settlement = makeSettlement()
    // (5400+2400+900) / (6000+3000+1000) = 8700/10000
    expect(employmentRateForSettlement(settlement)).toBeCloseTo(0.87, 5)
  })

  it('returns 0 for a settlement with no labour force yet', () => {
    const settlement = makeSettlement({ pop: { 0: { pop: 0, employed: 0, confidence: 50 } } })
    expect(employmentRateForSettlement(settlement)).toBe(0)
  })
})

describe('metricRange', () => {
  it('finds the min and max of non-null values', () => {
    const metrics = [{ settlementId: 1, value: 10 }, { settlementId: 2, value: null }, { settlementId: 3, value: 30 }]
    expect(metricRange(metrics)).toEqual({ min: 10, max: 30 })
  })

  it('returns a safe default when every value is null', () => {
    expect(metricRange([{ settlementId: 1, value: null }])).toEqual({ min: 0, max: 1 })
  })
})

describe('normaliseValue', () => {
  it('maps the range endpoints to 0 and 1', () => {
    expect(normaliseValue(10, { min: 10, max: 30 })).toBe(0)
    expect(normaliseValue(30, { min: 10, max: 30 })).toBe(1)
    expect(normaliseValue(20, { min: 10, max: 30 })).toBe(0.5)
  })

  it('returns 0.5 for a zero-width range rather than dividing by zero', () => {
    expect(normaliseValue(5, { min: 5, max: 5 })).toBe(0.5)
  })
})

describe('linkTotalFlow', () => {
  it('sums tonnes across every cargo', () => {
    expect(linkTotalFlow({ recentFlow: { coal: 100, iron: 50 } })).toBe(150)
  })

  it('returns 0 for a link with no recorded flow', () => {
    expect(linkTotalFlow({ recentFlow: {} })).toBe(0)
    expect(linkTotalFlow({})).toBe(0)
  })
})

describe('settlementMetrics', () => {
  it('computes confidence for every settlement', () => {
    const settlements = [makeSettlement({ id: 1 }), makeSettlement({ id: 2, pop: { 0: { pop: 100, employed: 100, confidence: 20 } } })]
    const metrics = settlementMetrics(settlements, 'confidence')
    expect(metrics).toEqual([
      { settlementId: 1, value: 66 },
      { settlementId: 2, value: 20 },
    ])
  })

  it('computes employment for every settlement', () => {
    const metrics = settlementMetrics([makeSettlement()], 'employment')
    expect(metrics[0].value).toBeCloseTo(0.87, 5)
  })

  it('returns null values for an unrecognised mode', () => {
    const metrics = settlementMetrics([makeSettlement()], 'classMix')
    expect(metrics).toEqual([{ settlementId: 1, value: null }])
  })
})
