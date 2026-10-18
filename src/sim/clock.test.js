import { describe, expect, it } from 'vitest'
import {
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  MONTH_NAMES,
  advanceDays,
  computeAdvanceStep,
  monthIndexOf,
  monthName,
  tickDay,
  yearIndexOf,
} from './clock.js'

describe('monthIndexOf / monthName / yearIndexOf', () => {
  it('matches DESIGN 4.1\'s worked example: March is month index 2, September is month index 8', () => {
    expect(monthIndexOf(60)).toBe(2)
    expect(monthName(60)).toBe('March')
    expect(monthIndexOf(240)).toBe(8)
    expect(monthName(240)).toBe('September')
  })

  it('day 0 is the first day of January, year 0', () => {
    expect(monthIndexOf(0)).toBe(0)
    expect(monthName(0)).toBe('January')
    expect(yearIndexOf(0)).toBe(0)
  })

  it('wraps the month index across year boundaries', () => {
    expect(monthIndexOf(360)).toBe(0)
    expect(monthIndexOf(389)).toBe(0)
    expect(monthIndexOf(390)).toBe(1)
  })

  it('counts whole elapsed years', () => {
    expect(yearIndexOf(359)).toBe(0)
    expect(yearIndexOf(360)).toBe(1)
    expect(yearIndexOf(1079)).toBe(2)
    expect(yearIndexOf(1080)).toBe(3)
  })

  it('every month name is used exactly once across a year', () => {
    const names = new Set()
    for (let day = 0; day < DAYS_PER_YEAR; day += DAYS_PER_MONTH) {
      names.add(monthName(day))
    }
    expect(names.size).toBe(MONTH_NAMES.length)
  })
})

describe('tickDay / advanceDays', () => {
  it('advances the day by exactly one per tick', () => {
    expect(tickDay(0)).toBe(1)
    expect(tickDay(29)).toBe(30)
  })

  it('fires onDay for every tick, including ones that are not month boundaries', () => {
    const seen = []
    advanceDays(0, 5, { onDay: (day) => seen.push(day) })
    expect(seen).toEqual([1, 2, 3, 4, 5])
  })

  it('fires onMonth only on day 30, not on days 1-29', () => {
    const months = []
    advanceDays(0, 30, { onMonth: (day, monthIndex) => months.push({ day, monthIndex }) })
    expect(months).toEqual([{ day: 30, monthIndex: 1 }])
  })

  it('fires onLevelCheck alongside onMonth only in March and September', () => {
    const monthDays = []
    const levelCheckDays = []
    advanceDays(0, DAYS_PER_YEAR, {
      onMonth: (day) => monthDays.push(day),
      onLevelCheck: (day) => levelCheckDays.push(day),
    })
    expect(monthDays).toHaveLength(12)
    // Month index 2 (March) starts day 60; month index 8 (September) starts day 240.
    expect(levelCheckDays).toEqual([60, 240])
  })

  it('fires onYearEnd only on multiples of 360', () => {
    const years = []
    advanceDays(0, DAYS_PER_YEAR * 2, { onYearEnd: (day, yearIndex) => years.push({ day, yearIndex }) })
    expect(years).toEqual([
      { day: 360, yearIndex: 1 },
      { day: 720, yearIndex: 2 },
    ])
  })

  it('steps 1080 days and sees exactly 36 month hooks, 6 level checks and 3 year ends (PHASES.md T1.15 Done-when)', () => {
    let monthCount = 0
    let levelCheckCount = 0
    let yearEndCount = 0
    let dayCount = 0

    const finalDay = advanceDays(0, 1080, {
      onDay: () => dayCount++,
      onMonth: () => monthCount++,
      onLevelCheck: () => levelCheckCount++,
      onYearEnd: () => yearEndCount++,
    })

    expect(finalDay).toBe(1080)
    expect(dayCount).toBe(1080)
    expect(monthCount).toBe(36)
    expect(levelCheckCount).toBe(6)
    expect(yearEndCount).toBe(3)
  })

  it('works with no hooks supplied at all', () => {
    expect(advanceDays(0, 100)).toBe(100)
  })
})

describe('computeAdvanceStep', () => {
  it('advances zero days until a full day\'s worth of time has accumulated', () => {
    const step = computeAdvanceStep(0, 200, 1, 500, 8)
    expect(step).toEqual({ days: 0, accumulatorMs: 200 })
  })

  it('advances exactly one day once msPerDayAt1x has elapsed, carrying no remainder', () => {
    const step = computeAdvanceStep(0, 500, 1, 500, 8)
    expect(step).toEqual({ days: 1, accumulatorMs: 0 })
  })

  it('carries a fractional remainder forward across frames', () => {
    const step = computeAdvanceStep(0, 650, 1, 500, 8)
    expect(step.days).toBe(1)
    expect(step.accumulatorMs).toBeCloseTo(150)
  })

  it('a higher speed divides the effective ms-per-day, advancing more days for the same elapsed time', () => {
    const step1x = computeAdvanceStep(0, 500, 1, 500, 8)
    const step4x = computeAdvanceStep(0, 500, 4, 500, 8)
    expect(step1x.days).toBe(1)
    expect(step4x.days).toBe(4)
  })

  it('caps days advanced at maxDaysPerFrame, carrying the un-spent time forward rather than dropping it', () => {
    // At 4x with msPerDayAt1x=500, one day costs 125ms. 2000ms of elapsed
    // time would be 16 days uncapped; capped to 8, 1000ms of that time
    // is spent and 1000ms carries forward to the next frame.
    const step = computeAdvanceStep(0, 2000, 4, 500, 8)
    expect(step.days).toBe(8)
    expect(step.accumulatorMs).toBeCloseTo(1000)
  })

  it('drops all accumulated time when paused (speed 0), per DESIGN 4.4\'s "no catch-up" rule', () => {
    const step = computeAdvanceStep(450, 10000, 0, 500, 8)
    expect(step).toEqual({ days: 0, accumulatorMs: 0 })
  })

  it('speed changes alter only wall-clock pace, not the calendar results reached', () => {
    // Simulate running the same 1080 in-game days to completion at two
    // different speeds, each fed a total elapsed wall-clock time exactly
    // scaled for that speed, in small frame-sized slices. The resulting
    // day and hook counts must be identical; only how much real time it
    // took to get there differs.
    function runAtSpeed(speed, frameMs) {
      let day = 0
      let accumulatorMs = 0
      let monthCount = 0
      let elapsedWallClockMs = 0
      const msPerDayAt1x = 500
      const maxDaysPerFrame = 8

      while (day < 1080) {
        const { days, accumulatorMs: remaining } = computeAdvanceStep(accumulatorMs, frameMs, speed, msPerDayAt1x, maxDaysPerFrame)
        accumulatorMs = remaining
        elapsedWallClockMs += frameMs
        day = advanceDays(day, days, { onMonth: () => monthCount++ })
      }

      return { day, monthCount, elapsedWallClockMs }
    }

    const at1x = runAtSpeed(1, 50)
    const at4x = runAtSpeed(4, 50)

    expect(at1x.day).toBe(1080)
    expect(at4x.day).toBe(1080)
    expect(at1x.monthCount).toBe(36)
    expect(at4x.monthCount).toBe(36)
    // 4x reaches the same calendar outcome in roughly a quarter of the wall-clock time.
    expect(at4x.elapsedWallClockMs).toBeLessThan(at1x.elapsedWallClockMs / 3)
  })
})
