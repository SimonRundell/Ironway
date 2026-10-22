import { describe, expect, it } from 'vitest'
import { findNearestEntity, findNearestIndustry, findNearestSettlement } from './selection.js'

describe('findNearestSettlement', () => {
  const settlements = [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 10, y: 0 },
  ]

  it('returns the closest settlement within range', () => {
    const hit = findNearestSettlement(settlements, { x: 1, y: 0 }, 5)
    expect(hit.settlement.id).toBe(1)
    expect(hit.distanceMiles).toBe(1)
  })

  it('returns null when nothing is within range', () => {
    expect(findNearestSettlement(settlements, { x: 100, y: 100 }, 5)).toBeNull()
  })
})

describe('findNearestIndustry', () => {
  it('returns the closest industry within range', () => {
    const industries = [{ id: 1, x: 0, y: 0 }, { id: 2, x: 5, y: 0 }]
    const hit = findNearestIndustry(industries, { x: 4.5, y: 0 }, 1)
    expect(hit.industry.id).toBe(2)
  })
})

describe('findNearestEntity', () => {
  it('picks whichever entity type is genuinely closest', () => {
    const settlements = [{ id: 1, x: 0, y: 0 }]
    const industries = [{ id: 2, x: 0.3, y: 0 }]
    const hit = findNearestEntity({ settlements, industries, worldPoint: { x: 0.25, y: 0 } })
    expect(hit).toEqual({ type: 'industry', id: 2 })
  })

  it('falls back to a settlement when no industry is close enough', () => {
    const settlements = [{ id: 1, x: 0, y: 0 }]
    const industries = [{ id: 2, x: 50, y: 50 }]
    const hit = findNearestEntity({ settlements, industries, worldPoint: { x: 0.5, y: 0 } })
    expect(hit).toEqual({ type: 'settlement', id: 1 })
  })

  it('returns null when nothing is close enough to anything', () => {
    const hit = findNearestEntity({ settlements: [{ id: 1, x: 0, y: 0 }], worldPoint: { x: 500, y: 500 } })
    expect(hit).toBeNull()
  })

  it('considers links too, via the same combined hit test', () => {
    const links = [{ id: 9, path: [[0, 0], [10, 0]] }]
    const hit = findNearestEntity({ links, worldPoint: { x: 5, y: 0.1 } })
    expect(hit).toEqual({ type: 'link', id: 9 })
  })
})
