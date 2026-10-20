/**
 * Pure camera maths (DESIGN 9.2): zoom-to-cursor, drag-to-pan, inertia
 * decay, clamping and fit-to-island. Every function that touches
 * screen pixels takes a `projection` parameter (the `worldToScreen`/
 * `screenToWorld` pair from `render/projection.js`, DESIGN 9.2.1) and
 * never does its own screen maths, so a future projection swap needs
 * no changes here — proven by this module's own tests, which run
 * every transform and anchoring test twice: once against
 * `topDownProjection` and once against a 2:1 isometric projection
 * defined only in the test file.
 *
 * Zoom-to-cursor and drag-to-pan are both the same underlying move:
 * "put this world point at this screen point, at this zoom", so both
 * are built on one small shared primitive (`cameraForWorldAtScreen`).
 *
 * @module render/camera
 */

/** @type {number} DESIGN 9.2's zoom floor: the whole island visible. */
export const MIN_PPM = 1.5
/** @type {number} DESIGN 9.2's zoom ceiling: one grid cell is 192 pixels. */
export const MAX_PPM = 96

/**
 * @param {number} ppm
 * @param {number} [minPpm]
 * @param {number} [maxPpm]
 * @returns {number}
 */
export function clampPpm(ppm, minPpm = MIN_PPM, maxPpm = MAX_PPM) {
  return Math.min(maxPpm, Math.max(minPpm, ppm))
}

/**
 * Clamps the camera's world position to the island's bounds plus a
 * margin, so panning cannot run away into empty sea forever.
 *
 * @param {import('./projection.js').Camera} camera
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} bounds Island bounds, in miles.
 * @param {number} [marginMiles]
 * @returns {import('./projection.js').Camera}
 */
export function clampPosition(camera, bounds, marginMiles = 0) {
  return {
    ...camera,
    x: Math.min(bounds.maxX + marginMiles, Math.max(bounds.minX - marginMiles, camera.x)),
    y: Math.min(bounds.maxY + marginMiles, Math.max(bounds.minY - marginMiles, camera.y)),
  }
}

/**
 * The shared primitive: the camera that places `worldPoint` exactly
 * at `screenPoint`, at `ppm`. Works for any projection of the form
 * `screen = centre + M(ppm) * (point - camera)` — true of top-down and
 * of any sheared/isometric variant — because calling `screenToWorld`
 * with a zeroed-out camera returns exactly `M(ppm)^-1 * (screenPoint -
 * centre)`, the one piece that is otherwise projection-specific.
 *
 * @param {import('./projection.js').Viewport} viewport
 * @param {import('./projection.js').Point} worldPoint
 * @param {import('./projection.js').Point} screenPoint
 * @param {number} ppm
 * @param {{screenToWorld: Function}} projection
 * @returns {import('./projection.js').Camera}
 */
function cameraForWorldAtScreen(viewport, worldPoint, screenPoint, ppm, projection) {
  const offset = projection.screenToWorld({ x: 0, y: 0, ppm }, viewport, screenPoint)
  return { x: worldPoint.x - offset.x, y: worldPoint.y - offset.y, ppm }
}

/**
 * Zooms to `newPpm` while keeping the world point under `screenPoint`
 * fixed on screen (DESIGN 9.2: wheel zoom is "anchored to the
 * cursor"). `newPpm` is clamped to `[MIN_PPM, MAX_PPM]`.
 *
 * @param {import('./projection.js').Camera} camera
 * @param {import('./projection.js').Viewport} viewport
 * @param {import('./projection.js').Point} screenPoint
 * @param {number} newPpm
 * @param {{worldToScreen: Function, screenToWorld: Function}} projection
 * @returns {import('./projection.js').Camera}
 */
export function zoomAtPoint(camera, viewport, screenPoint, newPpm, projection) {
  const worldBefore = projection.screenToWorld(camera, viewport, screenPoint)
  return cameraForWorldAtScreen(viewport, worldBefore, screenPoint, clampPpm(newPpm), projection)
}

/**
 * Converts a wheel event's `deltaY` into an exponential zoom step,
 * anchored to the cursor (DESIGN 9.2: "wheel zoom is exponential").
 * Positive `deltaY` (scrolling down) zooms out; negative zooms in.
 *
 * @param {import('./projection.js').Camera} camera
 * @param {import('./projection.js').Viewport} viewport
 * @param {import('./projection.js').Point} screenPoint
 * @param {number} deltaY A wheel event's `deltaY`.
 * @param {{worldToScreen: Function, screenToWorld: Function}} projection
 * @param {number} [sensitivity]
 * @returns {import('./projection.js').Camera}
 */
export function zoomByWheel(camera, viewport, screenPoint, deltaY, projection, sensitivity = 0.0015) {
  const newPpm = camera.ppm * Math.exp(-deltaY * sensitivity)
  return zoomAtPoint(camera, viewport, screenPoint, newPpm, projection)
}

/**
 * Pans the camera so the view shifts by `screenDelta` pixels: the
 * world point that was under the viewport centre is offset by the
 * same screen delta afterwards (DESIGN 9.2: "drag to pan").
 *
 * @param {import('./projection.js').Camera} camera
 * @param {import('./projection.js').Viewport} viewport
 * @param {import('./projection.js').Point} screenDelta
 * @param {{screenToWorld: Function}} projection
 * @returns {import('./projection.js').Camera}
 */
export function panByScreenDelta(camera, viewport, screenDelta, projection) {
  // screenToWorld's own "-centre" subtraction means a zeroed camera
  // only returns Minv(ppm)*rawDelta if the point passed in is
  // centre+rawDelta, not rawDelta itself.
  const target = { x: viewport.width / 2 + screenDelta.x, y: viewport.height / 2 + screenDelta.y }
  const shift = projection.screenToWorld({ x: 0, y: 0, ppm: camera.ppm }, viewport, target)
  return { ...camera, x: camera.x - shift.x, y: camera.y - shift.y }
}

/**
 * Advances drag inertia by one step (DESIGN 9.2: "drag to pan with
 * inertia"): pans by the distance `velocity` covers in `dtSeconds`,
 * then decays `velocity` exponentially.
 *
 * @param {import('./projection.js').Camera} camera
 * @param {import('./projection.js').Viewport} viewport
 * @param {import('./projection.js').Point} velocity Screen pixels per second.
 * @param {number} dtSeconds
 * @param {{screenToWorld: Function}} projection
 * @param {number} [friction] Exponential decay rate per second.
 * @returns {{camera: import('./projection.js').Camera, velocity: import('./projection.js').Point}}
 */
export function stepInertia(camera, viewport, velocity, dtSeconds, projection, friction = 4) {
  const screenDelta = { x: velocity.x * dtSeconds, y: velocity.y * dtSeconds }
  const nextCamera = panByScreenDelta(camera, viewport, screenDelta, projection)
  const decay = Math.exp(-friction * dtSeconds)
  return { camera: nextCamera, velocity: { x: velocity.x * decay, y: velocity.y * decay } }
}

/**
 * Centres and zooms the camera to show the whole island with a
 * margin, clamped to `[MIN_PPM, MAX_PPM]` (DESIGN 9.2's Home key).
 *
 * @param {import('./projection.js').Viewport} viewport
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} bounds Island bounds, in miles.
 * @param {number} [paddingFraction] Extra margin as a fraction of the fitted size, each side.
 * @returns {import('./projection.js').Camera}
 */
export function fitToIsland(viewport, bounds, paddingFraction = 0.05) {
  const width = (bounds.maxX - bounds.minX) * (1 + paddingFraction * 2)
  const height = (bounds.maxY - bounds.minY) * (1 + paddingFraction * 2)
  const ppm = clampPpm(Math.min(viewport.width / width, viewport.height / height))
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    ppm,
  }
}

/**
 * Eases a 0-1 progress value for a short animated transition (DESIGN
 * 9.2: wheel zoom has "a short eased animation").
 *
 * @param {number} t Progress, 0 to 1.
 * @returns {number} Eased progress, 0 to 1.
 */
export function easeOutCubic(t) {
  const u = 1 - t
  return 1 - u * u * u
}

/**
 * Interpolates between two cameras for an eased transition. `ppm` is
 * interpolated in log space, so a zoom-in and zoom-out of the same
 * magnitude take visually matched steps, rather than a linear
 * interpolation which would race through the start of a zoom-out.
 *
 * @param {import('./projection.js').Camera} from
 * @param {import('./projection.js').Camera} to
 * @param {number} t Progress, 0 to 1.
 * @returns {import('./projection.js').Camera}
 */
export function lerpCamera(from, to, t) {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    ppm: Math.exp(Math.log(from.ppm) + (Math.log(to.ppm) - Math.log(from.ppm)) * t),
  }
}
