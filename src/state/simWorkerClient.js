/**
 * The main-thread wrapper around `workers/simWorker.js` (PHASES.md
 * T2.11): posts the protocol's inbound messages, dispatches its
 * outbound ones to callbacks, and reports a worker crash through
 * `onError` the same way `render/tileWorkerPool.js` already does for
 * tile workers.
 *
 * `createWorker` is injectable for the exact same reason
 * `tileWorkerPool.js`'s is: a real `Worker` needs a browser, so a unit
 * test supplies a fake one (built directly on `sim/simWorkerCore.js`,
 * the same pure logic the real worker calls) instead.
 *
 * @module state/simWorkerClient
 */

/** @returns {Worker} The real sim `Worker` (DESIGN 4.2). */
function defaultCreateWorker() {
  return new Worker(new URL('../workers/simWorker.js', import.meta.url), { type: 'module' })
}

/**
 * @param {object} [options]
 * @param {() => {postMessage: Function, terminate?: Function, onmessage?: Function, onerror?: Function}} [options.createWorker] Defaults to a real sim `Worker`.
 * @param {(gameDay: number) => void} [options.onStep] Called on every real day the worker advances, win or not a month boundary.
 * @param {(patch: import('../sim/simWorkerCore.js').MirrorPatch) => void} [options.onDirty] Called whenever a month/year boundary (or a debug action) produced a new mirror patch.
 * @param {(gameDay: number, gameState: import('../sim/state.js').GameState) => void} [options.onSnapshot] Called once per `requestSnapshot()` reply.
 * @param {(message: string) => void} [options.onError] Called on a caught in-worker exception or an uncaught worker crash (indistinguishable to the caller — both mean "something inside the sim broke"; see DECISIONS.md for why T2.11's own "crash is reported, game recovers from the last checkpoint" Done-when doesn't need the two told apart).
 * @returns {{init: (payload: object) => void, setSpeed: (speed: number) => void, setHidden: (hidden: boolean) => void, requestSnapshot: () => void, debugAction: (action: object) => void, destroy: () => void}}
 */
export function createSimWorkerClient({
  createWorker = defaultCreateWorker,
  onStep,
  onDirty,
  onSnapshot,
  onError,
} = {}) {
  const worker = createWorker()

  worker.onmessage = (event) => {
    const data = event.data
    if (data.type === 'step') onStep?.(data.gameDay)
    else if (data.type === 'dirty') onDirty?.(data)
    else if (data.type === 'snapshot') onSnapshot?.(data.gameDay, data.gameState)
    else if (data.type === 'error') onError?.(data.message)
  }
  worker.onerror = (event) => {
    onError?.(event?.message ?? 'sim worker crashed')
  }

  return {
    /**
     * @param {object} payload `{world, gameState, rules, seed, gameDay, speed}`.
     * @returns {void}
     */
    init(payload) {
      worker.postMessage({ type: 'init', ...payload })
    },

    /** @param {number} speed One of `sim/clock.js`'s `SPEEDS`. @returns {void} */
    setSpeed(speed) {
      worker.postMessage({ type: 'setSpeed', speed })
    },

    /** @param {boolean} hidden @returns {void} */
    setHidden(hidden) {
      worker.postMessage({ type: 'setHidden', hidden })
    },

    /** @returns {void} Reply arrives asynchronously via `onSnapshot`. */
    requestSnapshot() {
      worker.postMessage({ type: 'snapshot' })
    },

    /** @param {object} action `{type: 'forceClosure', industryId}` or `{type: 'addStock', settlementId, cargoId, qty}`. @returns {void} Reply arrives asynchronously via `onDirty`. */
    debugAction(action) {
      worker.postMessage({ type: 'debugAction', action })
    },

    /** @returns {void} */
    destroy() {
      worker.terminate?.()
    },
  }
}
