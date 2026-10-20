/**
 * A small pool of tile-render workers (PHASES.md T2.03, DESIGN 9.4):
 * dispatches render requests to whichever worker is free, in priority
 * order (visible tiles before neighbours), de-duplicates repeat
 * requests for the same tile, and routes both successful renders and
 * worker errors back to the caller.
 *
 * `createWorker` is injectable so this module's scheduling logic (the
 * part actually worth testing) can be tested with a fake worker object
 * instead of a real `Worker`, which needs a browser. The default
 * spawns the real tile-render worker.
 *
 * @module render/tileWorkerPool
 */

/** @returns {Worker} The real tile-render worker (DESIGN 9.4). */
function defaultCreateWorker() {
  return new Worker(new URL('../workers/tileWorker.js', import.meta.url), { type: 'module' })
}

/**
 * @param {object} [options]
 * @param {number} [options.workerCount]
 * @param {() => {postMessage: Function, terminate?: Function, onmessage?: Function, onerror?: Function}} [options.createWorker] Defaults to a real tile-render `Worker`.
 * @param {object} [options.initPayload] PHASES.md T2.04: when given, sent once to every worker as `{type: 'init', ...initPayload}` before any render request reaches it (the grid layers, coastline SDF, land-use colours and palette a worker needs to paint real terrain). Omitted entirely in tests and whenever no world has been loaded yet, so a worker falls back to its own placeholder renderer; existing callers that never pass this see no behaviour change.
 * @param {(key: string, bitmap: *) => void} [options.onTile]
 * @param {(key: string|null, message: string) => void} [options.onError] `key` is `null` for a whole-worker crash not tied to one request.
 * @returns {{request: (key: string, message: object, priority: number) => void, cancel: (key: string) => void, pendingCount: () => number, inFlightCount: () => number, destroy: () => void}}
 */
export function createTileWorkerPool({
  workerCount = 2,
  createWorker = defaultCreateWorker,
  initPayload,
  onTile,
  onError,
} = {}) {
  const workers = []
  const idle = []
  /** @type {Map<string, object>} Tile key to the worker currently rendering it. */
  const inFlight = new Map()
  /** @type {{key: string, message: object, priority: number}[]} Lower priority number is served first. */
  const queue = []

  /** @param {object} worker @returns {void} */
  function attach(worker) {
    worker.onmessage = (event) => {
      const data = event.data
      inFlight.delete(data.key)
      if (data.type === 'tile') onTile?.(data.key, data.bitmap)
      else if (data.type === 'error') onError?.(data.key, data.message)
      idle.push(worker)
      pump()
    }
    worker.onerror = (event) => {
      onError?.(null, event?.message ?? 'tile worker crashed')
    }
  }

  for (let i = 0; i < workerCount; i++) {
    const worker = createWorker()
    attach(worker)
    // Posted before the worker is added to `idle`/`workers`, but what
    // actually guarantees ordering is that this call happens inside
    // this same synchronous loop, before `createTileWorkerPool()`
    // returns — no render request can reach this worker (via
    // `request()`, called later by a caller holding the returned pool)
    // until after that, and postMessage to one worker is always FIFO.
    if (initPayload) worker.postMessage({ type: 'init', ...initPayload })
    workers.push(worker)
    idle.push(worker)
  }

  /** @returns {void} Dispatches queued requests to idle workers, highest priority first. */
  function pump() {
    if (queue.length === 0 || idle.length === 0) return
    queue.sort((a, b) => a.priority - b.priority)
    while (idle.length > 0 && queue.length > 0) {
      const next = queue.shift()
      if (inFlight.has(next.key)) continue // superseded by a request already dispatched
      const worker = idle.pop()
      inFlight.set(next.key, worker)
      worker.postMessage(next.message)
    }
  }

  return {
    /**
     * Requests a tile render. A repeat request for a key already
     * queued or in flight is folded into the existing one (keeping the
     * higher priority, i.e. the lower number), never double-dispatched.
     *
     * @param {string} key
     * @param {object} message Posted to the worker as-is.
     * @param {number} priority 0 for visible tiles, 1 for neighbours (DESIGN 9.4's own ordering).
     * @returns {void}
     */
    request(key, message, priority) {
      if (inFlight.has(key)) return
      const existing = queue.find((item) => item.key === key)
      if (existing) {
        existing.priority = Math.min(existing.priority, priority)
        return
      }
      queue.push({ key, message, priority })
      pump()
    },

    /** @param {string} key @returns {void} Removes a not-yet-dispatched request. No effect once a worker is already rendering it. */
    cancel(key) {
      const index = queue.findIndex((item) => item.key === key)
      if (index !== -1) queue.splice(index, 1)
    },

    /** @returns {number} */
    pendingCount: () => queue.length,
    /** @returns {number} */
    inFlightCount: () => inFlight.size,

    /** @returns {void} Terminates every worker. */
    destroy() {
      for (const worker of workers) worker.terminate?.()
    },
  }
}
