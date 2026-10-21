import { valueNoise2D } from '../sim/noise.js'
import { blobRadiusMiles, featureOffsets, totalPopulation } from './settlements.js'
import { hexToRgb } from './terrain/sampleTerrain.js'

/**
 * Trickle visualisation (PHASES.md T2.09, DESIGN 9.6): carts, trains
 * and ships moving along each `Link`'s own `path`, density and colour
 * driven by `link.recentFlow` (tonnes per cargo id, written by
 * `sim/tick.js`'s `runMonth()` — see DECISIONS.md for why this field
 * exists at all), plus crane/crate/moored-ship activity at port
 * settlements with live sea flow. A vehicle's position is a pure
 * function of `(link.id, slotIndex, nowMs)` — never the camera — which
 * is what makes "no sprite teleports at zoom changes" (the Done-when)
 * true by construction rather than something that has to be
 * separately guarded against.
 *
 * Pure flow/position/colour helpers are exported and unit tested on
 * their own; `drawTrafficLayer()` is the one function that touches a
 * `CanvasRenderingContext2D`, browser-verified the same way every
 * other canvas-drawing function in this project is.
 *
 * @module render/traffic
 */

/** @type {number} Fixed seed for the per-link, per-slot phase-offset hash. Not tied to the world's own seed: the offset is cosmetic (which point in a repeating loop a given vehicle slot starts at), not a generation input. */
const PHASE_SEED = 62803

/**
 * @param {import('../sim/state.js').Link} link
 * @returns {number} Total tonnes across every cargo moved on this link last month.
 */
export function linkFlowTonnes(link) {
  let sum = 0
  for (const tonnes of Object.values(link.recentFlow)) sum += tonnes
  return sum
}

/**
 * The cargo category to colour a link's traffic by (DESIGN 9.6: "roads
 * ... coloured by cargo category"): whichever cargo carried the most
 * tonnes on this link last month. A link carrying nothing has no
 * dominant category.
 *
 * @param {import('../sim/state.js').Link} link
 * @param {{id: string, category: string}[]} cargoRules `cargo.json`'s `cargo` array.
 * @returns {string|null}
 */
export function dominantCargoCategory(link, cargoRules) {
  let bestCargo = null
  let bestTonnes = 0
  for (const [cargoId, tonnes] of Object.entries(link.recentFlow)) {
    if (tonnes > bestTonnes) {
      bestTonnes = tonnes
      bestCargo = cargoId
    }
  }
  if (bestCargo === null) return null
  return cargoRules.find((c) => c.id === bestCargo)?.category ?? null
}

/**
 * @param {string|null} category From `dominantCargoCategory()`.
 * @param {object} trafficRules `palette.json`'s `traffic` block.
 * @returns {{r: number, g: number, b: number}}
 */
export function vehicleColour(category, trafficRules) {
  const hex = (category && trafficRules.colourByCargoCategory[category]) || trafficRules.defaultColour
  return hexToRgb(hex)
}

/**
 * How many vehicle sprites a link's current flow supports (DESIGN
 * 9.6/PHASES.md T2.09's own Done-when: "a link with zero flow shows
 * nothing, high flow shows more traffic"). Zero tonnes gives zero
 * vehicles outright — never a floor of one — so an idle link is
 * genuinely empty, not sparsely decorated.
 *
 * @param {import('../sim/state.js').Link} link
 * @param {object} trafficRules `palette.json`'s `traffic` block (`tonnesPerVehicle`, `maxVehiclesPerLink`).
 * @returns {number} Integer vehicle count.
 */
export function vehicleCountForLink(link, trafficRules) {
  const tonnes = linkFlowTonnes(link)
  if (tonnes <= 0) return 0
  return Math.min(trafficRules.maxVehiclesPerLink, Math.max(1, Math.round(tonnes / trafficRules.tonnesPerVehicle)))
}

/**
 * @param {number[][]} path `[x, y]` pairs, in world miles.
 * @returns {number} Total arc length, in miles.
 */
function pathLengthMiles(path) {
  let length = 0
  for (let i = 1; i < path.length; i++) {
    length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
  }
  return length
}

/**
 * Samples a point at a given fraction of the way along a polyline's
 * total arc length (not simply `path[round(t * (path.length - 1))]`,
 * which would move at an uneven, segment-count-dependent pace along a
 * path whose segments vary in length). Degenerates gracefully: a
 * single-point or zero-length path always returns that point.
 *
 * @param {number[][]} path `[x, y]` pairs, in world miles.
 * @param {number} t 0 to 1.
 * @returns {{x: number, y: number}}
 */
export function pointAtPathFraction(path, t) {
  if (path.length === 0) return { x: 0, y: 0 }
  if (path.length === 1) return { x: path[0][0], y: path[0][1] }

  const totalLength = pathLengthMiles(path)
  if (totalLength === 0) return { x: path[0][0], y: path[0][1] }

  const target = Math.min(1, Math.max(0, t)) * totalLength
  let travelled = 0
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1]
    const [x1, y1] = path[i]
    const segmentLength = Math.hypot(x1 - x0, y1 - y0)
    if (travelled + segmentLength >= target || i === path.length - 1) {
      const segmentT = segmentLength === 0 ? 0 : (target - travelled) / segmentLength
      return { x: x0 + (x1 - x0) * segmentT, y: y0 + (y1 - y0) * segmentT }
    }
    travelled += segmentLength
  }
  return { x: path[path.length - 1][0], y: path[path.length - 1][1] }
}

/**
 * A vehicle slot's current world position: a deterministic, endlessly
 * repeating loop along `link.path`, `tripDurationMsByMode[link.mode]`
 * long, phase-offset per `(link.id, slotIndex)` so a link's several
 * vehicles aren't all bunched together. Depends only on `link`,
 * `slotIndex` and `nowMs` — never the camera or zoom — which is what
 * makes "no sprite teleports at zoom changes" (PHASES.md T2.09's own
 * Done-when) true by construction: the same moment in time always
 * maps to the same world point, at any `ppm`.
 *
 * @param {import('../sim/state.js').Link} link
 * @param {number} slotIndex
 * @param {number} nowMs The render loop's own frame timestamp.
 * @param {object} trafficRules `palette.json`'s `traffic` block (`tripDurationMsByMode`).
 * @returns {{x: number, y: number}}
 */
export function vehiclePosition(link, slotIndex, nowMs, trafficRules) {
  const durationMs = trafficRules.tripDurationMsByMode[link.mode]
  const phaseOffsetMs = valueNoise2D(PHASE_SEED, link.id, slotIndex) * durationMs
  const t = ((nowMs + phaseOffsetMs) % durationMs) / durationMs
  return pointAtPathFraction(link.path, t)
}

/**
 * Whether a port settlement should currently show crane/crate/moored-
 * ship activity (DESIGN 9.6: "ports show cranes, stacked crates and
 * moored ships"): it has a port at all, and at least one of its own
 * sea links carried something last month.
 *
 * @param {import('../sim/state.js').Settlement} settlement
 * @param {import('../sim/state.js').Link[]} links Every link in the world.
 * @returns {boolean}
 */
export function portHasActivity(settlement, links) {
  if (settlement.portTier <= 0) return false
  return links.some((link) => {
    if (link.mode !== 'sea') return false
    const touchesSettlement = (link.aType === 's' && link.aId === settlement.id) || (link.bType === 's' && link.bId === settlement.id)
    return touchesSettlement && linkFlowTonnes(link) > 0
  })
}

/**
 * @param {{r: number, g: number, b: number}} colour
 * @returns {string} `"r,g,b"`, ready to interpolate into an `rgb(...)` CSS string.
 */
function rgbTriplet(colour) {
  return `${Math.round(colour.r)},${Math.round(colour.g)},${Math.round(colour.b)}`
}

/**
 * A cart or wagon (DESIGN 9.6's "carts and wagons"): a small box body
 * on two wheels. Billboarded like every other small object in this
 * project (the T2.00 spike's own convention) — no rotation to face
 * its direction of travel, which would need the path's local tangent
 * and isn't worth the complexity for a sprite this size.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawCartSprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.fillStyle = `rgb(${rgb})`
  ctx.fillRect(screen.x - sizePx * 0.4, screen.y - sizePx * 0.25, sizePx * 0.8, sizePx * 0.4)
  ctx.fillStyle = 'rgba(40,36,30,0.8)'
  ctx.beginPath()
  ctx.arc(screen.x - sizePx * 0.22, screen.y + sizePx * 0.18, sizePx * 0.12, 0, Math.PI * 2)
  ctx.arc(screen.x + sizePx * 0.22, screen.y + sizePx * 0.18, sizePx * 0.12, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * An early train (DESIGN 9.6's "occasional early trains"): an
 * elongated body with a small raised cab, standing in for a
 * locomotive and its wagons without needing a specific one from
 * `vehicles.json` (this layer draws one generic sprite per rail link,
 * not per vehicle type/era).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawTrainSprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.fillStyle = `rgb(${rgb})`
  ctx.fillRect(screen.x - sizePx * 0.55, screen.y - sizePx * 0.18, sizePx * 1.1, sizePx * 0.32)
  ctx.fillRect(screen.x - sizePx * 0.55, screen.y - sizePx * 0.34, sizePx * 0.28, sizePx * 0.2)
}

/**
 * A ship (DESIGN 9.6's "ships between ports"): a simple hull.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawShipSprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.fillStyle = `rgb(${rgb})`
  ctx.beginPath()
  ctx.moveTo(screen.x - sizePx * 0.5, screen.y)
  ctx.lineTo(screen.x - sizePx * 0.3, screen.y + sizePx * 0.22)
  ctx.lineTo(screen.x + sizePx * 0.3, screen.y + sizePx * 0.22)
  ctx.lineTo(screen.x + sizePx * 0.5, screen.y)
  ctx.closePath()
  ctx.fill()
  ctx.fillRect(screen.x - sizePx * 0.12, screen.y - sizePx * 0.28, sizePx * 0.24, sizePx * 0.28)
}

/**
 * Picks the draw function for a link's mode.
 *
 * @param {string} mode `road`, `rail` or `sea`.
 * @returns {(ctx: CanvasRenderingContext2D, screen: {x: number, y: number}, sizePx: number, colour: {r: number, g: number, b: number}) => void}
 */
function spriteForMode(mode) {
  if (mode === 'rail') return drawTrainSprite
  if (mode === 'sea') return drawShipSprite
  return drawCartSprite
}

/**
 * @param {string} mode `road`, `rail` or `sea`.
 * @param {object} trafficRules `palette.json`'s `traffic` block.
 * @returns {number} World-mile sprite size for this mode.
 */
function sizeMilesForMode(mode, trafficRules) {
  if (mode === 'rail') return trafficRules.trainSizeMiles
  if (mode === 'sea') return trafficRules.shipSizeMiles
  return trafficRules.cartSizeMiles
}

/**
 * Port activity (DESIGN 9.6: "ports show cranes, stacked crates and
 * moored ships"): a crane (an upright post with a horizontal jib), a
 * couple of stacked crates and a small moored hull, all at once —
 * this is a presence/absence signal (is this port currently busy),
 * not an animation, so there is nothing to scale by flow volume the
 * way vehicle count is.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawPortActivitySprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.strokeStyle = `rgb(${rgb})`
  ctx.lineWidth = Math.max(1, sizePx * 0.08)
  ctx.beginPath()
  ctx.moveTo(screen.x - sizePx * 0.3, screen.y + sizePx * 0.3)
  ctx.lineTo(screen.x - sizePx * 0.3, screen.y - sizePx * 0.4)
  ctx.lineTo(screen.x + sizePx * 0.3, screen.y - sizePx * 0.25)
  ctx.stroke()

  ctx.fillStyle = `rgb(${rgb})`
  ctx.fillRect(screen.x - sizePx * 0.55, screen.y + sizePx * 0.1, sizePx * 0.22, sizePx * 0.22)
  ctx.fillRect(screen.x - sizePx * 0.3, screen.y + sizePx * 0.18, sizePx * 0.22, sizePx * 0.14)

  ctx.beginPath()
  ctx.moveTo(screen.x + sizePx * 0.1, screen.y + sizePx * 0.35)
  ctx.lineTo(screen.x + sizePx * 0.25, screen.y + sizePx * 0.5)
  ctx.lineTo(screen.x + sizePx * 0.65, screen.y + sizePx * 0.5)
  ctx.lineTo(screen.x + sizePx * 0.8, screen.y + sizePx * 0.35)
  ctx.closePath()
  ctx.fill()
}

/**
 * Draws every link's traffic and every port settlement's activity on
 * the dynamic canvas layer (DESIGN 9.3), hidden below
 * `trafficRules.minPpm` — DESIGN 9.2's band table puts carts, trains
 * and ships from the Area band up, never at Region. A single shared
 * `vehicleBudget` is spent across every link in array order
 * (PHASES.md T2.09's own Done-when: "total animated sprites never
 * exceed the budget"), the same pattern `industries.js`'s
 * `particleBudget` already uses. Does not clear the canvas — the
 * caller owns that, same convention as the other dynamic-layer
 * functions.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {import('../sim/state.js').Link[]} options.links
 * @param {import('../sim/state.js').Settlement[]} options.settlements
 * @param {{id: string, category: string}[]} options.cargoRules `cargo.json`'s `cargo` array.
 * @param {object} options.trafficRules `palette.json`'s `traffic` block.
 * @param {object} options.settlementRules `palette.json`'s `settlements` block — reused only for `blobRadiusMiles()`'s sizing constants, so a port's crane/ship activity lands exactly on `settlements.js`'s own wharf feature offset rather than a second, possibly-misaligned computation of where "the wharf" is.
 * @param {number} options.nowMs The render loop's own frame timestamp.
 * @returns {void}
 */
export function drawTrafficLayer({ ctx, camera, viewport, projection, links, settlements, cargoRules, trafficRules, settlementRules, nowMs }) {
  if (camera.ppm < trafficRules.minPpm) return

  let vehicleBudgetRemaining = trafficRules.vehicleBudget

  for (const link of links) {
    if (link.mode !== 'road' && link.mode !== 'rail' && link.mode !== 'sea') continue
    if (link.path.length < 2) continue

    const desiredCount = vehicleCountForLink(link, trafficRules)
    if (desiredCount === 0) continue
    const count = Math.min(desiredCount, vehicleBudgetRemaining)
    if (count === 0) break
    vehicleBudgetRemaining -= count

    const category = dominantCargoCategory(link, cargoRules)
    const colour = vehicleColour(category, trafficRules)
    const sprite = spriteForMode(link.mode)
    const sizePx = sizeMilesForMode(link.mode, trafficRules) * camera.ppm

    for (let slot = 0; slot < count; slot++) {
      const worldPoint = vehiclePosition(link, slot, nowMs, trafficRules)
      const screen = projection.worldToScreen(camera, viewport, worldPoint)
      sprite(ctx, screen, sizePx, colour)
    }
  }

  const portSizePx = trafficRules.portActivitySizeMiles * camera.ppm
  for (const settlement of settlements) {
    if (!portHasActivity(settlement, links)) continue
    const radiusMiles = blobRadiusMiles(totalPopulation(settlement), settlementRules)
    const offset = featureOffsets(radiusMiles).wharf
    const worldPoint = { x: settlement.x + offset.x, y: settlement.y + offset.y }
    const screen = projection.worldToScreen(camera, viewport, worldPoint)
    drawPortActivitySprite(ctx, screen, portSizePx, vehicleColour(null, trafficRules))
  }
}
