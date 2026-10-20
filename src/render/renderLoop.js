/**
 * A dirty-flag render loop (DESIGN 9.2/9.3): nothing redraws unless
 * something calls `markDirty()`, and a frame is scheduled only once
 * per dirty mark, not polled every vsync. When nothing changes, zero
 * `requestAnimationFrame` calls happen at all, which is how the loop
 * idles at near-zero CPU rather than merely doing nothing in an
 * otherwise still-running per-frame callback.
 *
 * @module render/renderLoop
 */

/**
 * @param {object} [options]
 * @param {(timestampMs: number) => void} options.render Called once per dirty frame. May call `markDirty()` again itself to keep animating (inertia, eased zoom).
 * @param {(callback: FrameRequestCallback) => number} [options.requestFrame]
 * @param {(handle: number) => void} [options.cancelFrame]
 * @returns {{start: () => void, stop: () => void, markDirty: () => void}}
 */
export function createRenderLoop({
  render,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
} = {}) {
  let running = false
  let frameId = null

  /** @param {number} timestampMs @returns {void} */
  function frame(timestampMs) {
    frameId = null
    if (running) render(timestampMs)
  }

  return {
    /** @returns {void} */
    start() {
      running = true
    },
    /** @returns {void} Stops the loop and cancels any frame already scheduled. */
    stop() {
      running = false
      if (frameId !== null) {
        cancelFrame(frameId)
        frameId = null
      }
    },
    /** @returns {void} Schedules exactly one frame, if the loop is running and none is already pending. */
    markDirty() {
      if (running && frameId === null) {
        frameId = requestFrame(frame)
      }
    },
  }
}

/**
 * Sizes a canvas's backing store for `devicePixelRatio` while keeping
 * its CSS size (and therefore every `render/projection.js` and
 * `render/camera.js` calculation) in CSS pixels (DESIGN 9.3: canvases
 * are "sized to the viewport times `devicePixelRatio`, clamped to 2").
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} [dpr]
 * @returns {{width: number, height: number}} The viewport, in CSS pixels, for `render/projection.js`.
 */
export function resizeCanvasForDpr(canvas, cssWidth, cssHeight, dpr = Math.min(2, window.devicePixelRatio || 1)) {
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { width: cssWidth, height: cssHeight }
}
