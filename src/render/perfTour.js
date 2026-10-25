import { MAX_PPM, MIN_PPM } from './camera.js'

/**
 * The performance spike's own scripted camera tour (PHASES.md T2.15,
 * DESIGN 9.9: "60 fps pan and zoom... no main-thread task over 16 ms
 * during interaction"). Reuses the exact same sine-wave sweep shape as
 * `debugStressTest.js`'s tile-pipeline stress test (full island, full
 * zoom range) rather than a gentler, more "realistic" pan pattern —
 * deliberately a worst case: if frame cost stays in budget while
 * oscillating across every zoom level and the whole island continuously,
 * normal play (which never moves this aggressively) has a comfortable
 * margin. Unlike the stress test, which only watches the tile cache
 * survive sustained churn, this module measures what DESIGN 9.9 actually
 * asks for: how long each frame's own synchronous render work takes.
 *
 * `MapView.jsx` measures that duration itself (wrapping its own
 * `drawPlaceholderWorld()` call, the one place the real per-frame cost
 * is actually paid) and pushes it into a plain `{frames: number[]}`
 * object this module is handed a reference to — the same "caller owns a
 * mutable ref across frames" convention `holeSince`/`holeStats` already
 * use elsewhere in this file, not a new pattern.
 *
 * @module render/perfTour
 */

/** @type {number} Length of the scripted performance tour. Long enough to sample several hundred frames across the full pan/zoom range (roughly 900 at 60fps), short enough to run as part of ordinary manual verification. */
export const PERF_TOUR_DURATION_MS = 15000
/** @type {number} DESIGN 9.9's own frame budget for 60fps (1000ms / 60). A frame taking longer than this is a dropped frame. */
export const FRAME_BUDGET_MS = 1000 / 60

/**
 * @param {number[]} sortedAscending
 * @param {number} fraction 0 to 1.
 * @returns {number} Linear-interpolated percentile; `NaN` for an empty array.
 */
function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return NaN
  const index = fraction * (sortedAscending.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sortedAscending[lower]
  const t = index - lower
  return sortedAscending[lower] + (sortedAscending[upper] - sortedAscending[lower]) * t
}

/**
 * Summarises a tour's per-frame synchronous render durations (PHASES.md
 * T2.15's "frame time capture"). Pure, so the maths is unit-testable
 * without a real render loop.
 *
 * @param {number[]} frameDurationsMs Milliseconds spent inside one frame's own `drawPlaceholderWorld()` call, in the order they were recorded.
 * @returns {{count: number, avgMs: number, medianMs: number, p95Ms: number, maxMs: number, minMs: number, overBudgetCount: number, overBudgetFraction: number}}
 */
export function computeFrameStats(frameDurationsMs) {
  const count = frameDurationsMs.length
  if (count === 0) {
    return { count: 0, avgMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0, minMs: 0, overBudgetCount: 0, overBudgetFraction: 0 }
  }
  const sorted = [...frameDurationsMs].sort((a, b) => a - b)
  const sum = frameDurationsMs.reduce((total, ms) => total + ms, 0)
  const overBudgetCount = frameDurationsMs.filter((ms) => ms > FRAME_BUDGET_MS).length
  return {
    count,
    avgMs: sum / count,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
    minMs: sorted[0],
    overBudgetCount,
    overBudgetFraction: overBudgetCount / count,
  }
}

/**
 * Builds a `run()` function that sweeps the camera across the whole
 * island and through every tile zoom level for `PERF_TOUR_DURATION_MS`,
 * recording every frame's render duration into `perfCaptureRef`, then
 * reports a full results object (frame-time stats, tile cache size,
 * JS heap delta if `performance.memory` is available) via `onComplete`
 * and restores the camera to wherever it was before the tour started.
 *
 * @param {object} options
 * @param {import('react').MutableRefObject<object>} options.cameraRef
 * @param {import('react').MutableRefObject<{frames: number[]}|null>} options.perfCaptureRef Set to `{frames: []}` for the tour's duration; `MapView.jsx`'s own `draw()` pushes each frame's duration here when it is non-null. Reset to `null` once the tour completes.
 * @param {import('react').MutableRefObject<number|null>} options.tourRef Holds the pending `requestAnimationFrame` id; also the re-entrancy guard (a tour already running is left alone).
 * @param {import('react').MutableRefObject<{cache: {size: number, totalBytes: number}}>} options.tileManagerRef For the cache-size part of the results.
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} options.bounds Island bounds, in miles, to sweep across.
 * @param {() => void} options.markDirty
 * @param {(results: {frameStats: ReturnType<typeof computeFrameStats>, cache: {tileCount: number, cacheMb: number}, heapDeltaMb: number|null, durationMs: number}) => void} options.onComplete
 * @returns {() => void} Call to start the tour. A no-op if one is already running or the camera isn't initialised yet.
 */
export function createPerfTourRunner({ cameraRef, perfCaptureRef, tourRef, tileManagerRef, bounds, markDirty, onComplete }) {
  return function run() {
    if (tourRef.current || !cameraRef.current) return
    const startedAt = performance.now()
    const restoreCamera = cameraRef.current
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY
    const centreX = (bounds.minX + bounds.maxX) / 2
    const centreY = (bounds.minY + bounds.maxY) / 2
    const logMinPpm = Math.log(MIN_PPM)
    const logMaxPpm = Math.log(MAX_PPM)
    const heapBefore = performance.memory?.usedJSHeapSize ?? null

    perfCaptureRef.current = { frames: [] }

    function tick(now) {
      const t = (now - startedAt) / PERF_TOUR_DURATION_MS
      if (t >= 1) {
        tourRef.current = null
        cameraRef.current = restoreCamera
        const frames = perfCaptureRef.current.frames
        perfCaptureRef.current = null
        markDirty()

        const cache = tileManagerRef.current.cache
        const heapAfter = performance.memory?.usedJSHeapSize ?? null
        onComplete({
          frameStats: computeFrameStats(frames),
          cache: { tileCount: cache.size, cacheMb: cache.totalBytes / (1024 * 1024) },
          heapDeltaMb: heapBefore !== null && heapAfter !== null ? (heapAfter - heapBefore) / (1024 * 1024) : null,
          durationMs: now - startedAt,
        })
        return
      }
      cameraRef.current = {
        x: centreX + Math.sin(t * Math.PI * 6) * width * 0.4,
        y: centreY + Math.sin(t * Math.PI * 4.5) * height * 0.4,
        ppm: Math.exp(logMinPpm + ((Math.sin(t * Math.PI * 8) + 1) / 2) * (logMaxPpm - logMinPpm)),
      }
      markDirty()
      tourRef.current = requestAnimationFrame(tick)
    }
    tourRef.current = requestAnimationFrame(tick)
  }
}
