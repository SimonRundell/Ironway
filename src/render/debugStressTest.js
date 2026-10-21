import { MAX_PPM, MIN_PPM } from './camera.js'

/**
 * `MapView`'s "Run tile pipeline stress test" debug button (T2.03's own
 * Done-when names a 5-minute version of this exact sweep; see
 * DECISIONS.md for why the interactive one runs shorter). Pulled out of
 * `MapView.jsx` itself since it is debug tooling, not core map
 * interaction — react-doctor flagged the component as too large once
 * T2.06's network hit-testing was added on top of it, and this block
 * was the clearest candidate with no React concerns of its own (it only
 * mutates refs it is handed and calls a markDirty callback).
 *
 * @module render/debugStressTest
 */

/** @type {number} Length of the scripted pan-and-zoom stress sweep. */
export const STRESS_TEST_DURATION_MS = 20000

/**
 * Builds a `run()` function that sweeps the camera across the whole
 * island and through every tile zoom level for `STRESS_TEST_DURATION_MS`,
 * so the tile pipeline's own debug line (cache size, max hole duration)
 * can be watched settle under sustained churn, then restores the camera
 * to wherever it was before the sweep started.
 *
 * @param {object} options
 * @param {import('react').MutableRefObject<object>} options.cameraRef
 * @param {import('react').MutableRefObject<number|null>} options.stressTestRef Holds the pending `requestAnimationFrame` id; also doubles as the re-entrancy guard (a sweep already running is left alone).
 * @param {import('react').MutableRefObject<{cache: object}>} options.tileManagerRef For the completion log line only.
 * @param {import('react').MutableRefObject<{maxMs: number}>} options.holeStatsRef For the completion log line only.
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} options.bounds Island bounds, in miles, to sweep across.
 * @param {number} options.tileMemoryCapMb For the completion log line only.
 * @param {() => void} options.markDirty
 * @returns {() => void} Call to start the sweep. A no-op if one is already running or the camera isn't initialised yet.
 */
export function createStressTestRunner({ cameraRef, stressTestRef, tileManagerRef, holeStatsRef, bounds, tileMemoryCapMb, markDirty }) {
  return function run() {
    if (stressTestRef.current || !cameraRef.current) return
    const startedAt = performance.now()
    const restoreCamera = cameraRef.current
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY
    const centreX = (bounds.minX + bounds.maxX) / 2
    const centreY = (bounds.minY + bounds.maxY) / 2
    const logMinPpm = Math.log(MIN_PPM)
    const logMaxPpm = Math.log(MAX_PPM)

    function tick(now) {
      const t = (now - startedAt) / STRESS_TEST_DURATION_MS
      if (t >= 1) {
        stressTestRef.current = null
        cameraRef.current = restoreCamera
        markDirty()
        const cache = tileManagerRef.current.cache
        console.log(
          `[MapView] stress test complete: max hole ${holeStatsRef.current.maxMs.toFixed(0)}ms, ` +
          `cache ${cache.size} tiles / ${(cache.totalBytes / (1024 * 1024)).toFixed(1)} of ${tileMemoryCapMb} MB`,
        )
        return
      }
      cameraRef.current = {
        x: centreX + Math.sin(t * Math.PI * 6) * width * 0.4,
        y: centreY + Math.sin(t * Math.PI * 4.5) * height * 0.4,
        ppm: Math.exp(logMinPpm + ((Math.sin(t * Math.PI * 8) + 1) / 2) * (logMaxPpm - logMinPpm)),
      }
      markDirty()
      stressTestRef.current = requestAnimationFrame(tick)
    }
    stressTestRef.current = requestAnimationFrame(tick)
  }
}
