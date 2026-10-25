import { describe, expect, it } from 'vitest'
import { computeFrameStats, FRAME_BUDGET_MS } from './perfTour.js'

describe('computeFrameStats', () => {
  it('returns all zeros for an empty capture (the tour never ran, or captured nothing)', () => {
    expect(computeFrameStats([])).toEqual({
      count: 0, avgMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0, minMs: 0, overBudgetCount: 0, overBudgetFraction: 0,
    })
  })

  it('computes avg/min/max for a simple set of frame times', () => {
    const stats = computeFrameStats([10, 20, 30])
    expect(stats.count).toBe(3)
    expect(stats.avgMs).toBeCloseTo(20, 10)
    expect(stats.minMs).toBe(10)
    expect(stats.maxMs).toBe(30)
    expect(stats.medianMs).toBe(20)
  })

  it('is insensitive to input order (sorts internally for percentiles)', () => {
    const sorted = computeFrameStats([1, 2, 3, 4, 5])
    const shuffled = computeFrameStats([3, 1, 5, 2, 4])
    expect(shuffled).toEqual(sorted)
  })

  it('p95 sits near the top of the distribution, not the median', () => {
    const stats = computeFrameStats(Array.from({ length: 100 }, (_, i) => i + 1)) // 1..100
    expect(stats.medianMs).toBeCloseTo(50.5, 5)
    expect(stats.p95Ms).toBeCloseTo(95.05, 2)
    expect(stats.p95Ms).toBeGreaterThan(stats.medianMs)
  })

  it('counts frames over the 60fps budget (1000/60 ms) and reports the fraction', () => {
    const stats = computeFrameStats([5, 10, 16, 17, 20, 30]) // budget ~16.67ms: 17/20/30 are over
    expect(stats.overBudgetCount).toBe(3)
    expect(stats.overBudgetFraction).toBeCloseTo(0.5, 10)
  })

  it('a single frame exactly at the budget does not count as over budget', () => {
    const stats = computeFrameStats([FRAME_BUDGET_MS])
    expect(stats.overBudgetCount).toBe(0)
  })

  it('all frames comfortably under budget report zero dropped frames', () => {
    const stats = computeFrameStats([1, 2, 3, 4, 5])
    expect(stats.overBudgetCount).toBe(0)
    expect(stats.overBudgetFraction).toBe(0)
  })
})
