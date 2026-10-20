/**
 * All conversions between world miles and screen pixels (DESIGN 9.2.1).
 * No other renderer code does its own screen maths; `camera.js` and
 * every later canvas layer go through these functions instead. The
 * shipped projection is top-down: T2.00's spike measured a 2:1
 * isometric alternative at identical frame cost and found no case for
 * it (see `DECISIONS.md`), so DESIGN 9.2.1 keeps top-down as the one
 * projection `src` ships.
 *
 * @module render/projection
 */

/**
 * @typedef {object} Camera
 * @property {number} x World x the viewport is centred on, in miles.
 * @property {number} y World y the viewport is centred on, in miles.
 * @property {number} ppm Zoom: pixels per world mile (DESIGN 9.2, roughly 1.5 to 96).
 */

/**
 * @typedef {object} Viewport
 * @property {number} width Canvas CSS width, in pixels.
 * @property {number} height Canvas CSS height, in pixels.
 */

/**
 * @typedef {object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @param {Camera} camera
 * @param {Viewport} viewport
 * @param {Point} point World point, in miles.
 * @returns {Point} Screen point, in CSS pixels, viewport-centred.
 */
export function worldToScreen(camera, viewport, point) {
  return {
    x: viewport.width / 2 + (point.x - camera.x) * camera.ppm,
    y: viewport.height / 2 + (point.y - camera.y) * camera.ppm,
  }
}

/**
 * @param {Camera} camera
 * @param {Viewport} viewport
 * @param {Point} point Screen point, in CSS pixels.
 * @returns {Point} World point, in miles.
 */
export function screenToWorld(camera, viewport, point) {
  return {
    x: camera.x + (point.x - viewport.width / 2) / camera.ppm,
    y: camera.y + (point.y - viewport.height / 2) / camera.ppm,
  }
}

/**
 * The world-space footprint of the viewport (a rectangle in top-down,
 * a rotated quad in any sheared projection). Tile selection, culling,
 * label placement and hit testing all call this rather than assuming
 * a rectangle, so they keep working if a projection ever changes.
 *
 * @param {Camera} camera
 * @param {Viewport} viewport
 * @returns {Point[]} The four viewport corners, in world miles, clockwise from top-left.
 */
export function visibleWorldPolygon(camera, viewport) {
  const corners = [
    { x: 0, y: 0 },
    { x: viewport.width, y: 0 },
    { x: viewport.width, y: viewport.height },
    { x: 0, y: viewport.height },
  ]
  return corners.map((corner) => screenToWorld(camera, viewport, corner))
}

/**
 * The matrix to draw a cached, world-aligned tile at its screen
 * position (DESIGN 9.4): terrain tiles are rendered in world-aligned
 * space in the tile workers and are only ever placed on screen
 * through this, so the tile pipeline does not change if a projection
 * ever changes.
 *
 * @param {Camera} camera
 * @param {Viewport} viewport
 * @param {Point} tile The tile's world-space origin (top-left corner), in miles.
 * @returns {{a: number, b: number, c: number, d: number, e: number, f: number}} A `CanvasRenderingContext2D.setTransform`-compatible matrix.
 */
export function tileTransform(camera, viewport, tile) {
  const origin = worldToScreen(camera, viewport, tile)
  return { a: camera.ppm, b: 0, c: 0, d: camera.ppm, e: origin.x, f: origin.y }
}

/**
 * Draw order for tall objects (buildings, trains). Constant in
 * top-down, where screen position alone never implies occlusion.
 *
 * @returns {number}
 */
export function depthKey() {
  return 0
}

/**
 * The five functions above, bundled as DESIGN 9.2.1 describes them,
 * for code that wants to pass "a projection" around as one value
 * (`camera.js` takes exactly this shape, so a test or a future
 * projection swap can hand it a different implementation).
 *
 * @type {{worldToScreen: typeof worldToScreen, screenToWorld: typeof screenToWorld, visibleWorldPolygon: typeof visibleWorldPolygon, tileTransform: typeof tileTransform, depthKey: typeof depthKey}}
 */
export const topDownProjection = { worldToScreen, screenToWorld, visibleWorldPolygon, tileTransform, depthKey }
