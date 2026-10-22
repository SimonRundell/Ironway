import { SPEEDS, computeAdvanceStep } from '../sim/clock.js'
import { createSimWorkerCore } from '../sim/simWorkerCore.js'

/**
 * The sim worker (PHASES.md T2.11, DESIGN 4.2): runs a loaded save's
 * whole economic simulation off the main thread, so a heavy month tick
 * never costs a single dropped render frame. `sim/simWorkerCore.js`
 * does all the actual work; this file is only the message-protocol
 * wrapper and the clock loop that decides when to call it.
 *
 * A Worker has no `requestAnimationFrame` (no DOM), so unlike
 * `state/clockRunner.js` (the main-thread wrapper it replaces — see
 * DECISIONS.md), this loop runs on `setInterval`, feeding real elapsed
 * time into the exact same `sim/clock.js` accumulator maths
 * (`computeAdvanceStep`) `clockRunner.js` already used. The sim module
 * itself (`tick.js`/`clock.js`) needed no change at all for this move,
 * exactly DESIGN 4.2's "this is a wrapper change only".
 *
 * Message protocol:
 * - `{type: 'init', world, gameState, rules, seed, gameDay, speed}` in, once, before anything else.
 * - `{type: 'setSpeed', speed}` in: one of `sim/clock.js`'s own `SPEEDS`.
 * - `{type: 'setHidden', hidden}` in: forwards `document.visibilitychange` (no DOM here to read it directly).
 * - `{type: 'snapshot'}` in (a request) -> `{type: 'snapshot', gameDay, gameState}` out, once.
 * - `{type: 'debugAction', action}` in -> applied immediately, then a `dirty` message out (same shape as a month tick's).
 * - `{type: 'step', gameDay}` out: posted on every real day advanced, win or not a month/year boundary — the single source of truth for the displayed date.
 * - `{type: 'dirty', ...patch}` out: posted whenever a month or year boundary fired — the mirror-patch the main thread merges into its own read-only copy.
 * - `{type: 'error', message}` out: a caught exception during a tick or debug action (distinct from an uncaught crash, which surfaces to the main thread via `worker.onerror` instead, with no message from this file at all).
 *
 * @module workers/simWorker
 */

/** @type {number} How often the worker's own clock loop ticks, in real ms — a worker equivalent of a render frame, decoupled from the main thread's actual frame rate. */
const TICK_INTERVAL_MS = 100

/** @type {ReturnType<typeof createSimWorkerCore>|null} */
let core = null
/** @type {object} */
let clockConfig = { msPerDayAt1x: 500, maxDaysPerFrame: 8, pauseOnHidden: true }
let speed = 0
let hidden = false
let accumulatorMs = 0
let lastTickTime = null
let intervalId = null

/**
 * One clock-loop tick: converts real elapsed time into whole game days
 * via the same pure maths `clockRunner.js` used on the main thread, then
 * advances the sim by that many days and posts whatever that produced.
 *
 * @returns {void}
 */
function tick() {
  const now = Date.now()
  const effectiveSpeed = hidden && clockConfig.pauseOnHidden ? 0 : speed

  if (lastTickTime !== null) {
    const frameMs = now - lastTickTime
    const step = computeAdvanceStep(accumulatorMs, frameMs, effectiveSpeed, clockConfig.msPerDayAt1x, clockConfig.maxDaysPerFrame)
    accumulatorMs = step.accumulatorMs

    if (step.days > 0) {
      try {
        const result = core.advanceDays(step.days)
        self.postMessage({ type: 'step', gameDay: result.gameDay })
        if (result.dirty) self.postMessage({ type: 'dirty', ...result.dirty })
      } catch (err) {
        self.postMessage({ type: 'error', message: err.message })
      }
    }
  }

  lastTickTime = now
}

self.onmessage = (event) => {
  const data = event.data

  if (data.type === 'init') {
    core = createSimWorkerCore({ world: data.world, gameState: data.gameState, rules: data.rules, seed: data.seed, gameDay: data.gameDay })
    clockConfig = {
      msPerDayAt1x: data.rules.client?.msPerDayAt1x ?? 500,
      maxDaysPerFrame: data.rules.client?.maxDaysPerFrame ?? 8,
      pauseOnHidden: data.rules.client?.pauseOnHidden ?? true,
    }
    speed = SPEEDS.includes(data.speed) ? data.speed : 0
    accumulatorMs = 0
    lastTickTime = null
    intervalId = setInterval(tick, TICK_INTERVAL_MS)
    return
  }

  if (!core) return // Every other message needs an initialised core.

  if (data.type === 'setSpeed') {
    speed = SPEEDS.includes(data.speed) ? data.speed : 0
    if (speed === 0) accumulatorMs = 0 // Same "no catch-up while paused" rule clockRunner.js's own setSpeed() applied (DESIGN 4.4).
    return
  }

  if (data.type === 'setHidden') {
    hidden = data.hidden
    lastTickTime = null // Re-baseline, same reason clockRunner.js's own visibility handler did: a suspended interval's whole gap must never count as one giant elapsed frame on resume.
    if (hidden && clockConfig.pauseOnHidden) accumulatorMs = 0
    return
  }

  if (data.type === 'snapshot') {
    const snap = core.getSnapshot()
    self.postMessage({ type: 'snapshot', gameDay: snap.gameDay, gameState: snap.gameState })
    return
  }

  if (data.type === 'debugAction') {
    try {
      const patch = core.applyDebugAction(data.action)
      self.postMessage({ type: 'dirty', ...patch })
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message })
    }
  }
}
