import { SPEEDS, advanceDays, computeAdvanceStep } from '../sim/clock.js'

/**
 * The browser-side wrapper around `sim/clock.js`'s pure calendar and
 * accumulator maths (DESIGN 4.2): a `requestAnimationFrame` loop that
 * turns real elapsed time into whole game-day ticks, with play-speed
 * control and an automatic pause while the tab is hidden. Everything
 * that actually decides *when* a day, month, level-check or year-end
 * hook fires lives in `sim/clock.js`; this module only ever supplies
 * wall-clock time to it.
 *
 * @module state/clockRunner
 */

/**
 * Creates a clock runner.
 *
 * @param {object} options
 * @param {number} [options.startDay] The `gameDay` to start from (e.g. a loaded save's current day).
 * @param {number} [options.msPerDayAt1x] How long one game day takes at 1x speed (DESIGN 4.2 default 500).
 * @param {number} [options.maxDaysPerFrame] The most days one animation frame is allowed to advance (DESIGN 4.2 default 8).
 * @param {boolean} [options.pauseOnHidden] Whether the clock stops ticking while the tab is hidden (DESIGN 4.2, a config flag).
 * @param {import('../sim/clock.js').ClockHooks} [options.hooks] Calendar hooks, forwarded to `sim/clock.js`'s `advanceDays()`.
 * @returns {{start: () => void, stop: () => void, setSpeed: (speed: number) => void, getSpeed: () => number, getDay: () => number}}
 */
export function createClockRunner({
  startDay = 0,
  msPerDayAt1x = 500,
  maxDaysPerFrame = 8,
  pauseOnHidden = true,
  hooks = {},
} = {}) {
  let day = startDay
  let speed = 1
  let accumulatorMs = 0
  let lastFrameTime = null
  let hidden = false
  let rafId = null

  /**
   * One `requestAnimationFrame` step: advances `day` by whatever
   * `computeAdvanceStep()` says this frame's elapsed time is worth,
   * then schedules the next frame. Re-reads `hidden` every frame
   * (rather than trusting a one-off reset from the visibility
   * listener) so a tab that only throttles `requestAnimationFrame`
   * instead of fully suspending it while hidden still can't sneak in
   * any days.
   *
   * @param {number} now `requestAnimationFrame`'s timestamp for this frame.
   * @returns {void}
   */
  function frame(now) {
    const effectiveSpeed = hidden && pauseOnHidden ? 0 : speed

    if (lastFrameTime !== null) {
      const frameMs = now - lastFrameTime
      const step = computeAdvanceStep(accumulatorMs, frameMs, effectiveSpeed, msPerDayAt1x, maxDaysPerFrame)
      accumulatorMs = step.accumulatorMs
      day = advanceDays(day, step.days, hooks)
    }

    lastFrameTime = now
    rafId = requestAnimationFrame(frame)
  }

  /**
   * Re-baselines the frame timer on every visibility transition (not
   * just hidden to visible) so a `requestAnimationFrame` that was
   * fully suspended while hidden never has its entire hidden duration
   * counted as one giant elapsed frame the moment it resumes.
   *
   * @returns {void}
   */
  function handleVisibilityChange() {
    hidden = document.visibilityState === 'hidden'
    lastFrameTime = null
    if (hidden && pauseOnHidden) {
      accumulatorMs = 0
    }
  }

  /**
   * Starts the loop.
   *
   * @returns {void}
   */
  function start() {
    lastFrameTime = null
    rafId = requestAnimationFrame(frame)
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  /**
   * Stops the loop.
   *
   * @returns {void}
   */
  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }

  /**
   * Sets the play speed. Dropping to paused (0) also drops any
   * accumulated sub-day time, the same "no catch-up" rule DESIGN 4.4
   * applies to the tab-hidden case.
   *
   * @param {number} newSpeed One of `SPEEDS`.
   * @returns {void}
   * @throws {Error} If `newSpeed` isn't one of `SPEEDS`.
   */
  function setSpeed(newSpeed) {
    if (!SPEEDS.includes(newSpeed)) {
      throw new Error(`createClockRunner: invalid speed ${newSpeed}; must be one of ${SPEEDS.join(', ')}.`)
    }
    speed = newSpeed
    if (speed === 0) {
      accumulatorMs = 0
    }
  }

  return {
    start,
    stop,
    setSpeed,
    getSpeed: () => speed,
    getDay: () => day,
  }
}
