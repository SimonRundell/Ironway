import { describe, expect, it } from 'vitest'
import { agriProductivityMultiplier, interpolateYearTable } from './era.js'

const AGRI_TABLE = [
  { year: 1830, value: 1.00 },
  { year: 1840, value: 1.15 },
  { year: 1870, value: 1.35 },
  { year: 1900, value: 1.55 },
  { year: 1920, value: 1.75 },
  { year: 1930, value: 1.85 },
]

describe('interpolateYearTable', () => {
  it('returns the first value exactly at the first year', () => {
    expect(interpolateYearTable(AGRI_TABLE, 1830)).toBe(1.00)
  })

  it('returns the last value exactly at the last year', () => {
    expect(interpolateYearTable(AGRI_TABLE, 1930)).toBe(1.85)
  })

  it('returns an exact table value when the year matches a middle entry', () => {
    expect(interpolateYearTable(AGRI_TABLE, 1900)).toBe(1.55)
  })

  it('linearly interpolates halfway between two entries', () => {
    // Halfway between (1830, 1.00) and (1840, 1.15): 1.00 + 0.15 * 0.5 = 1.075.
    expect(interpolateYearTable(AGRI_TABLE, 1835)).toBeCloseTo(1.075)
  })

  it('linearly interpolates a quarter of the way between two entries', () => {
    // A quarter of the way between (1870, 1.35) and (1900, 1.55): 1.35 + 0.20 * 0.25 = 1.40.
    expect(interpolateYearTable(AGRI_TABLE, 1877.5)).toBeCloseTo(1.40)
  })

  it('clamps to the first value before the table starts', () => {
    expect(interpolateYearTable(AGRI_TABLE, 1700)).toBe(1.00)
  })

  it('clamps to the last value after the table ends', () => {
    expect(interpolateYearTable(AGRI_TABLE, 2000)).toBe(1.85)
  })
})

describe('agriProductivityMultiplier', () => {
  it('reads from the eras.json agriProductivityMultiplier table', () => {
    const erasRules = { agriProductivityMultiplier: AGRI_TABLE }
    expect(agriProductivityMultiplier(erasRules, 1830)).toBe(1.00)
    expect(agriProductivityMultiplier(erasRules, 1920)).toBe(1.75)
  })
})
