/**
 * The game calendar and fixed-step loop maths (DESIGN 4.1-4.3). Every
 * function here is pure (no DOM, no wall-clock reads) so a Node test
 * can drive any number of days directly; `src/state/clockRunner.js` is
 * the thin `requestAnimationFrame` wrapper that turns real elapsed
 * time into calls into this module.
 *
 * @module sim/clock
 */

/** @type {number} A game year is always 360 days (DESIGN 4.1). */
export const DAYS_PER_YEAR = 360

/** @type {number} Every month is exactly 30 days (DESIGN 4.1). */
export const DAYS_PER_MONTH = 30

/** @type {number} 360 / 30. */
export const MONTHS_PER_YEAR = DAYS_PER_YEAR / DAYS_PER_MONTH

/** @type {readonly string[]} Calendar month names, index matches `monthIndexOf()`. The 30-day month is a deliberate simplification (DESIGN 4.1); real month names are just the familiar labels for it. */
export const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
])

/** @type {readonly number[]} 0-based month indices when the March/September economy level check fires (DESIGN 4.1: "month index 2 and 8"). */
const LEVEL_CHECK_MONTHS = Object.freeze([2, 8])

/**
 * @param {number} day A `gameDay` value.
 * @returns {number} The 0-based month index within its year (0 = January).
 */
export function monthIndexOf(day) {
  return Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR
}

/**
 * @param {number} day A `gameDay` value.
 * @returns {string} The calendar month name day falls within.
 */
export function monthName(day) {
  return MONTH_NAMES[monthIndexOf(day)]
}

/**
 * @param {number} day A `gameDay` value.
 * @returns {number} How many full 360-day years have elapsed by day (0 for days 0-359).
 */
export function yearIndexOf(day) {
  return Math.floor(day / DAYS_PER_YEAR)
}

/**
 * @typedef {object} ClockHooks
 * @property {(day: number) => void} [onDay] Fires once per advanced day.
 * @property {(day: number, monthIndex: number) => void} [onMonth] Fires when `day` is the first day of a new month.
 * @property {(day: number, monthIndex: number) => void} [onLevelCheck] Fires alongside `onMonth` in March and September.
 * @property {(day: number, yearIndex: number) => void} [onYearEnd] Fires when `day` is the first day of a new year.
 */

/**
 * Advances the calendar by exactly one day, firing whichever hooks the
 * new day triggers. DESIGN 4.3's cadence table in order: day, then
 * month (with the March/September level check alongside it), then
 * year end — all three can fire on the same day (e.g. day 360 is a
 * month start, a level-check month is never also a year start since
 * March and September aren't month 0, and a year start).
 *
 * @param {number} day The current `gameDay`, before this tick.
 * @param {ClockHooks} [hooks] Hooks to call for this new day.
 * @returns {number} The new `gameDay` (`day + 1`).
 */
export function tickDay(day, hooks = {}) {
  const newDay = day + 1

  hooks.onDay?.(newDay)

  if (newDay % DAYS_PER_MONTH === 0) {
    const monthIndex = monthIndexOf(newDay)
    hooks.onMonth?.(newDay, monthIndex)
    if (LEVEL_CHECK_MONTHS.includes(monthIndex)) {
      hooks.onLevelCheck?.(newDay, monthIndex)
    }
  }

  if (newDay % DAYS_PER_YEAR === 0) {
    hooks.onYearEnd?.(newDay, yearIndexOf(newDay))
  }

  return newDay
}

/**
 * Advances the calendar by `count` whole days, firing hooks for each
 * one in order. Equivalent to calling `tickDay()` `count` times.
 *
 * @param {number} day The starting `gameDay`.
 * @param {number} count How many days to advance.
 * @param {ClockHooks} [hooks] Hooks to call for each new day.
 * @returns {number} The final `gameDay` (`day + count`).
 */
export function advanceDays(day, count, hooks = {}) {
  let current = day
  for (let i = 0; i < count; i++) {
    current = tickDay(current, hooks)
  }
  return current
}

/** @type {readonly number[]} Valid game speeds: paused, 1x, 2x, 4x (DESIGN 4.2). */
export const SPEEDS = Object.freeze([0, 1, 2, 4])

/**
 * @typedef {object} AdvanceStep
 * @property {number} days Whole days to advance this frame (0 to `maxDaysPerFrame`).
 * @property {number} accumulatorMs Leftover sub-day time to carry into the next frame.
 */

/**
 * The fixed-step loop's accumulator maths (DESIGN 4.2): converts one
 * frame's elapsed wall-clock time into a whole number of game days to
 * advance, carrying any leftover fractional time forward rather than
 * dropping it — so a frame that arrives late (a slow frame, or a
 * background tab capped below `maxDaysPerFrame`) still catches up
 * exactly, just spread over more frames, with the one deliberate
 * exception being `speed === 0` (paused), which drops all accumulated
 * time per DESIGN 4.4's "no catch-up" rule rather than queuing days to
 * play the moment the player unpauses.
 *
 * Pure function of its inputs only, so speed only ever changes how
 * much wall-clock time one game day costs, never what a day actually
 * does when it ticks (DESIGN 4.2: "speed changes alter only wall-clock
 * pace, not results").
 *
 * @param {number} accumulatorMs Leftover time carried from the previous frame.
 * @param {number} frameMs Wall-clock time elapsed this frame.
 * @param {number} speed One of `SPEEDS` (0 = paused).
 * @param {number} msPerDayAt1x How long one game day takes at 1x speed.
 * @param {number} maxDaysPerFrame The most days one frame is allowed to advance.
 * @returns {AdvanceStep}
 */
export function computeAdvanceStep(accumulatorMs, frameMs, speed, msPerDayAt1x, maxDaysPerFrame) {
  if (speed <= 0) {
    return { days: 0, accumulatorMs: 0 }
  }

  const msPerDay = msPerDayAt1x / speed
  const total = accumulatorMs + frameMs
  const days = Math.min(Math.floor(total / msPerDay), maxDaysPerFrame)

  return { days, accumulatorMs: total - days * msPerDay }
}
