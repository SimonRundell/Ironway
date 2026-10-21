/**
 * The network layer (PHASES.md T2.06, DESIGN 9.3's "static overlays:
 * rivers, roads, rail, sea lanes"): draws every link's path as a
 * smoothed, styled line on the overlay canvas, and answers "which link
 * is nearest this point" for hit testing. Pure geometry and style
 * selection live here as plain functions so they are unit testable
 * without a canvas; `drawNetworkLayer()` is the one function that
 * actually touches a `CanvasRenderingContext2D`, browser-verified the
 * same way every other canvas-drawing function in this project is.
 *
 * @module render/network
 */

/**
 * @param {import('../sim/state.js').Link} link
 * @param {object} palette The validated `palette.json` rules.
 * @returns {string} A CSS colour.
 */
export function linkColour(link, palette) {
  if (link.mode === 'sea') return palette.seaLane
  const byTier = link.mode === 'rail' ? palette.railByTier : palette.roadByTier
  return byTier[String(link.tier)] ?? byTier['0']
}

/**
 * @param {import('../sim/state.js').Link} link
 * @param {{widthPxByTier: number[], seaLaneWidthPx: number}} networkRules palette.json's `network` block.
 * @returns {number} Screen-pixel line width, independent of zoom (DESIGN 9.6's "lines are clean at all zooms" reads as a constant screen weight, not a world-space one that would vanish zoomed out or swamp the screen zoomed in).
 */
export function linkWidthPx(link, networkRules) {
  if (link.mode === 'sea') return networkRules.seaLaneWidthPx
  return networkRules.widthPxByTier[link.tier] ?? networkRules.widthPxByTier[0]
}

/**
 * Level-of-detail visibility (DESIGN 9.6's "visibility by zoom band"):
 * minor tracks and early tiers clutter the view at Region/Area zoom
 * without being individually readable, so each tier only appears once
 * the camera is close enough. Sea lanes and rail are always visible —
 * both are sparse enough, and important enough as route context, to
 * never need hiding.
 *
 * @param {import('../sim/state.js').Link} link
 * @param {number} ppm Camera pixels-per-mile.
 * @param {{minPpmByTier: number[]}} networkRules palette.json's `network` block.
 * @returns {boolean}
 */
export function isLinkVisible(link, ppm, networkRules) {
  if (link.mode !== 'road') return true
  const minPpm = networkRules.minPpmByTier[link.tier] ?? 0
  return ppm >= minPpm
}

/**
 * Render-time level-of-detail simplification: drops path points that
 * project within `minGapPx` screen pixels of the last kept point.
 * `path` is already geographically simplified once at generation time
 * (`mapgen.json`'s `pathSimplifyToleranceMiles`, a fixed tolerance in
 * miles), but at low zoom even that can still have several points per
 * screen pixel; stroking all of them costs draw calls for a visual
 * difference nobody can see. Always keeps the first and last point, so
 * a link's endpoints never move.
 *
 * @param {{x: number, y: number}[]} screenPoints Already projected to screen space.
 * @param {number} minGapPx
 * @returns {{x: number, y: number}[]}
 */
export function simplifyScreenPoints(screenPoints, minGapPx) {
  if (screenPoints.length <= 2) return screenPoints

  const kept = [screenPoints[0]]
  let last = screenPoints[0]
  for (let i = 1; i < screenPoints.length - 1; i++) {
    const point = screenPoints[i]
    const dx = point.x - last.x
    const dy = point.y - last.y
    if (Math.sqrt(dx * dx + dy * dy) >= minGapPx) {
      kept.push(point)
      last = point
    }
  }
  kept.push(screenPoints[screenPoints.length - 1])
  return kept
}

/**
 * Shortest distance from a point to a line segment.
 *
 * @param {{x: number, y: number}} point
 * @param {{x: number, y: number}} a Segment start.
 * @param {{x: number, y: number}} b Segment end.
 * @returns {number}
 */
export function distanceToSegment(point, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y)
  }
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
  t = Math.min(1, Math.max(0, t))
  const nearestX = a.x + t * dx
  const nearestY = a.y + t * dy
  return Math.hypot(point.x - nearestX, point.y - nearestY)
}

/**
 * Shortest distance from a point to a polyline (the minimum over every
 * segment in `path`).
 *
 * @param {{x: number, y: number}} point
 * @param {number[][]} path `[x, y]` pairs, in the same units as `point`.
 * @returns {number} `Infinity` for a path with fewer than 2 points.
 */
export function distanceToPath(point, path) {
  if (path.length < 2) return Infinity
  let nearest = Infinity
  for (let i = 1; i < path.length; i++) {
    const a = { x: path[i - 1][0], y: path[i - 1][1] }
    const b = { x: path[i][0], y: path[i][1] }
    const distance = distanceToSegment(point, a, b)
    if (distance < nearest) nearest = distance
  }
  return nearest
}

/**
 * Hit testing (PHASES.md T2.06's own Done-when: "hit testing returns
 * the nearest link under the cursor"): the closest link to a world
 * point, within `maxDistanceMiles`, or `null` if nothing is close
 * enough. Pure world-space geometry — the caller converts a screen
 * point to world space with `projection.screenToWorld()` first, the
 * same as every other hit-testing concern in this project.
 *
 * @param {import('../sim/state.js').Link[]} links
 * @param {{x: number, y: number}} worldPoint
 * @param {number} maxDistanceMiles
 * @returns {{link: import('../sim/state.js').Link, distanceMiles: number}|null}
 */
export function findNearestLink(links, worldPoint, maxDistanceMiles) {
  let best = null
  for (const link of links) {
    const distance = distanceToPath(worldPoint, link.path)
    if (distance <= maxDistanceMiles && (!best || distance < best.distanceMiles)) {
      best = { link, distanceMiles: distance }
    }
  }
  return best
}

/**
 * Smoothly strokes a simplified screen-space polyline: a quadratic
 * curve through the midpoint of each consecutive pair, using the
 * shared point between them as the control point. A standard
 * lightweight polyline-smoothing trick — each curve segment starts and
 * ends exactly on the midpoints either side of a vertex and bulges
 * toward that vertex, which rounds off the piecewise-linear path's
 * corners without needing a full spline fit. The very first and last
 * points are still visited exactly, so a link's endpoints never move.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}[]} points Already simplified to screen space.
 * @returns {void}
 */
function strokeSmoothPath(ctx, points) {
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)

  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y)
    ctx.stroke()
    return
  }

  for (let i = 1; i < points.length - 1; i++) {
    const current = points[i]
    const next = points[i + 1]
    const midX = (current.x + next.x) / 2
    const midY = (current.y + next.y) / 2
    ctx.quadraticCurveTo(current.x, current.y, midX, midY)
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y)
  ctx.stroke()
}

/** @type {number} Render-time point-gap simplification threshold (see `simplifyScreenPoints()`). */
const MIN_POINT_GAP_PX = 1.5

/**
 * Draws every link on the overlay canvas: road, rail and sea lanes
 * styled by mode and tier, level-of-detail visibility by zoom band,
 * smoothed corners. Does not clear the canvas — the caller (
 * `drawPlaceholderWorld.js`) owns that, since the overlay layer also
 * carries the debug grid.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx The overlay canvas context, already at identity transform.
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {import('../sim/state.js').Link[]} options.links
 * @param {object} options.palette The validated `palette.json` rules (roadByTier, railByTier, seaLane, network).
 * @returns {void}
 */
export function drawNetworkLayer({ ctx, camera, viewport, projection, links, palette }) {
  const networkRules = palette.network

  for (const link of links) {
    if (link.path.length < 2) continue
    if (!isLinkVisible(link, camera.ppm, networkRules)) continue

    const screenPoints = link.path.map(([x, y]) => projection.worldToScreen(camera, viewport, { x, y }))
    const simplified = simplifyScreenPoints(screenPoints, MIN_POINT_GAP_PX)
    if (simplified.length < 2) continue

    ctx.strokeStyle = linkColour(link, palette)
    ctx.lineWidth = linkWidthPx(link, networkRules)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.setLineDash(link.mode === 'sea' ? networkRules.seaLaneDash : [])

    strokeSmoothPath(ctx, simplified)
  }
  ctx.setLineDash([])
}
