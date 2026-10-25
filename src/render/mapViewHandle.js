import { easeOutCubic, lerpCamera } from './camera.js'

/**
 * Builds the object `ui/MapView.jsx` exposes via `useImperativeHandle()`
 * (PHASES.md T2.12): `markDirty` (T2.07) plus `jumpTo`/`setCamera`/
 * `getCamera`/`getViewport`, which the search box and minimap both need
 * to drive or read the camera from outside the component. Pulled out of
 * `MapView.jsx` itself for the same reason `debugStressTest.js`'s own
 * `createStressTestRunner()` was (T2.06): it is plain glue over refs the
 * caller already owns, not a React concern, and kept MapView's own file
 * from growing past react-doctor's "giant component" threshold.
 *
 * @module render/mapViewHandle
 */

/**
 * @param {object} options
 * @param {import('react').RefObject<import('./projection.js').Camera>} options.cameraRef
 * @param {import('react').RefObject<{from: import('./projection.js').Camera, to: import('./projection.js').Camera, startMs: number, durationMs: number}|null>} options.jumpAnimRef
 * @param {import('react').RefObject<{width: number, height: number}>} options.viewportRef
 * @param {() => void} options.markDirty
 * @param {number} options.jumpDurationMs
 * @returns {{markDirty: () => void, jumpTo: (worldPoint: {x: number, y: number}, ppm?: number) => void, setCamera: (camera: import('./projection.js').Camera) => void, getCamera: () => import('./projection.js').Camera|null, getViewport: () => {width: number, height: number}}}
 */
export function createMapViewHandle({ cameraRef, jumpAnimRef, viewportRef, markDirty, jumpDurationMs }) {
  return {
    markDirty,

    /**
     * Eases the camera to centre `worldPoint` at `ppm` (DESIGN 9.2's
     * "short eased animation", reused here for "jump to a place" the
     * same way it already applies to wheel zoom).
     *
     * @param {{x: number, y: number}} worldPoint
     * @param {number} [ppm] Defaults to the current zoom.
     * @returns {void}
     */
    jumpTo(worldPoint, ppm) {
      if (!cameraRef.current) return
      const targetPpm = ppm ?? cameraRef.current.ppm
      jumpAnimRef.current = {
        from: cameraRef.current,
        to: { x: worldPoint.x, y: worldPoint.y, ppm: targetPpm },
        startMs: performance.now(),
        durationMs: jumpDurationMs,
      }
      markDirty()
    },

    /** @param {import('./projection.js').Camera} camera @returns {void} Sets the camera immediately, no animation (the minimap's drag-to-pan). */
    setCamera(camera) {
      jumpAnimRef.current = null
      cameraRef.current = camera
      markDirty()
    },

    /** @returns {import('./projection.js').Camera|null} */
    getCamera: () => cameraRef.current,
    /** @returns {{width: number, height: number}} */
    getViewport: () => viewportRef.current,
  }
}

/**
 * Steps an in-progress `jumpTo()` animation by one frame (PHASES.md
 * T2.12). Pure except for the two ref writes, mirroring the inertia
 * step this same render loop already does for drag flicks.
 *
 * @param {object} options
 * @param {import('react').RefObject<object|null>} options.jumpAnimRef
 * @param {import('react').RefObject<import('./projection.js').Camera>} options.cameraRef
 * @param {number} options.timestampMs
 * @param {() => void} options.markDirty
 * @returns {void}
 */
export function stepJumpAnimation({ jumpAnimRef, cameraRef, timestampMs, markDirty }) {
  const anim = jumpAnimRef.current
  // `durationMs <= 0` (PHASES.md T2.14's reduced-motion setting builds
  // its handle with `jumpDurationMs: 0`, so every jump snaps instantly)
  // is treated as "already finished" explicitly, rather than dividing
  // by zero: `timestampMs - anim.startMs` can legitimately be exactly 0
  // on the very first frame after `jumpTo()` runs, which would make
  // `0 / 0` evaluate to `NaN`, not `Infinity`.
  const t = anim.durationMs <= 0 ? 1 : Math.min(1, (timestampMs - anim.startMs) / anim.durationMs)
  cameraRef.current = lerpCamera(anim.from, anim.to, easeOutCubic(t))
  if (t >= 1) jumpAnimRef.current = null
  else markDirty()
}
