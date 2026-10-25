import { fbm2D, valueNoise2D } from '../sim/noise.js'
import { hexToRgb } from './terrain/sampleTerrain.js'

/**
 * Settlement rendering (PHASES.md T2.07, DESIGN 9.5): a soft population
 * blob at Region zoom, a footprint polygon with streets at Area/Local,
 * and individual procedural buildings by class district (plus church,
 * market, mill and wharf features) at Detail zoom. None of this layout
 * exists anywhere in the generated world — `Settlement` (`sim/state.js`)
 * only carries a position, population and housing capacity, not a
 * footprint, street grid or building list — so it is derived here,
 * entirely as a pure function of the settlement's own `id` and a fixed
 * seed, which is what makes "layout identical after reload" (the
 * Done-when) hold by construction rather than needing to be persisted.
 *
 * Pure geometry/colour helpers are exported and unit tested on their
 * own; `drawSettlementsLayer()` is the one function that touches a
 * `CanvasRenderingContext2D`, browser-verified the same way every other
 * canvas-drawing function in this project is.
 *
 * @module render/settlements
 */

/** @type {number} Fixed seed for all settlement layout derivation (slot angles, footprint jitter, feature placement). Not tied to the world's own seed: two different worlds should not coincidentally share a settlement id's layout, but the layout itself is cosmetic, not a generation input, so one constant seed for every world is fine (same convention as `sampleTerrain.js`'s texture-noise seed). */
const SETTLEMENT_LAYOUT_SEED = 82301

/**
 * @param {import('../sim/state.js').Settlement} settlement
 * @returns {number} Total population across every class.
 */
export function totalPopulation(settlement) {
  let sum = 0
  for (const entry of Object.values(settlement.pop)) sum += entry.pop
  return sum
}

/**
 * @param {import('../sim/state.js').Settlement} settlement
 * @param {{id: string}[]} classesRules `classes.json`'s `classes` array, index-matched to `settlement.pop`'s keys.
 * @returns {Record<string, number>} Each class id to its share of total population, 0 to 1. Empty settlement (no population yet) returns all zeros rather than dividing by zero.
 */
export function classShares(settlement, classesRules) {
  const total = totalPopulation(settlement)
  const shares = {}
  classesRules.forEach((cls, index) => {
    shares[cls.id] = total > 0 ? (settlement.pop[index]?.pop ?? 0) / total : 0
  })
  return shares
}

/**
 * @param {Record<string, number>} shares From `classShares()`.
 * @param {Record<string, string>} classColoursHex `palette.json`'s `settlements.classColours`.
 * @returns {{r: number, g: number, b: number}} The population-weighted blend of every class's colour (DESIGN 9.5's "tinted by dominant class mix").
 */
export function dominantColour(shares, classColoursHex) {
  let r = 0, g = 0, b = 0
  let weight = 0
  for (const [classId, share] of Object.entries(shares)) {
    const colour = hexToRgb(classColoursHex[classId] ?? '#888888')
    r += colour.r * share
    g += colour.g * share
    b += colour.b * share
    weight += share
  }
  if (weight === 0) return hexToRgb(Object.values(classColoursHex)[0] ?? '#888888')
  return { r: r / weight, g: g / weight, b: b / weight }
}

/**
 * Region-band blob radius (DESIGN 9.5: "sized by the square root of
 * population"), floored so even the smallest hamlet still shows as
 * something rather than vanishing to a sub-pixel dot.
 *
 * @param {number} population
 * @param {{blobRadiusMilesPerSqrtPop: number, minBlobRadiusMiles: number}} settlementRules `palette.json`'s `settlements` block.
 * @returns {number} Radius, in world miles.
 */
export function blobRadiusMiles(population, settlementRules) {
  return Math.max(settlementRules.minBlobRadiusMiles, settlementRules.blobRadiusMilesPerSqrtPop * Math.sqrt(population))
}

/**
 * How many building slots a settlement's current housing capacity
 * supports (DESIGN 9.5: "number of buildings tracks `housingCapacity`"),
 * clamped to a sane on-screen range: a capital's real housing capacity
 * would imply thousands of individual icons, which is both unreadable
 * and well past any reasonable per-frame draw budget, so the count
 * saturates rather than growing without bound.
 *
 * @param {number} housing `settlement.housing`.
 * @param {{popPerBuildingSlot: number, minBuildingSlots: number, maxBuildingSlots: number}} settlementRules
 * @returns {number} Integer slot count.
 */
export function buildingSlotCount(housing, settlementRules) {
  const raw = Math.round(housing / settlementRules.popPerBuildingSlot)
  return Math.min(settlementRules.maxBuildingSlots, Math.max(settlementRules.minBuildingSlots, raw))
}

/**
 * One deterministic per-slot layout entry. Slot `index`'s angle, radius,
 * size jitter and class district never depend on how many slots are
 * currently active — growth only ever reveals a higher index, shrinkage
 * only ever hides one — so an existing building's position and class
 * never change as a settlement grows or shrinks, and the whole layout
 * is reproducible from `settlement.id` and `index` alone (the
 * Done-when's "identical after reload").
 *
 * @param {number} settlementId
 * @param {number} index Slot index, 0-based.
 * @param {string[]} classOrder `classes.json`'s class ids, in a fixed order (cumulative-share lookup must use the same order every call).
 * @param {Record<string, number>} shares From `classShares()`.
 * @returns {{angle: number, radiusFraction: number, sizeJitter: number, classId: string}}
 */
export function buildingSlot(settlementId, index, classOrder, shares) {
  const seed = SETTLEMENT_LAYOUT_SEED + settlementId * 97
  const angle = valueNoise2D(seed, index, 0) * Math.PI * 2
  const radiusFraction = 0.2 + valueNoise2D(seed, index, 1) * 0.8
  const sizeJitter = 0.8 + valueNoise2D(seed, index, 2) * 0.4

  const pick = valueNoise2D(seed, index, 3)
  let cumulative = 0
  let classId = classOrder[classOrder.length - 1]
  for (const id of classOrder) {
    cumulative += shares[id] ?? 0
    if (pick <= cumulative) { classId = id; break }
  }

  return { angle, radiusFraction, sizeJitter, classId }
}

/**
 * A deterministic, slightly irregular polygon approximating a
 * settlement's footprint (DESIGN 9.5's Area/Local band), in world
 * miles relative to the settlement centre.
 *
 * @param {number} settlementId
 * @param {number} radiusMiles From `blobRadiusMiles()`.
 * @param {{footprintPaddingFactor: number}} settlementRules
 * @param {number} [vertexCount]
 * @returns {{x: number, y: number}[]} Offsets from the settlement centre, in miles.
 */
export function footprintOffsets(settlementId, radiusMiles, settlementRules, vertexCount = 10) {
  const seed = SETTLEMENT_LAYOUT_SEED + settlementId * 131
  const baseRadius = radiusMiles * settlementRules.footprintPaddingFactor
  const points = []
  for (let i = 0; i < vertexCount; i++) {
    const angle = (i / vertexCount) * Math.PI * 2
    const jitter = 0.7 + valueNoise2D(seed, i, 9) * 0.5
    points.push({ x: Math.cos(angle) * baseRadius * jitter, y: Math.sin(angle) * baseRadius * jitter })
  }
  return points
}

/**
 * Deterministic street chords through a settlement's footprint (DESIGN
 * 9.5's "footprint polygon with streets"): each street is a straight
 * line from one side of the footprint to the other, at a fixed random
 * angle, so streets vary settlement to settlement without needing an
 * actual road graph.
 *
 * @param {number} settlementId
 * @param {number} radiusMiles
 * @param {number} [streetCount]
 * @returns {{angle: number}[]}
 */
export function footprintStreets(settlementId, radiusMiles, streetCount = 3) {
  const seed = SETTLEMENT_LAYOUT_SEED + settlementId * 131
  const streets = []
  for (let i = 0; i < streetCount; i++) {
    streets.push({ angle: valueNoise2D(seed, i, 20) * Math.PI * 2 })
  }
  return streets
}

/**
 * Which civic features a settlement has (DESIGN 9.5: "Church or
 * chapel, market square, mill, wharf where relevant"), deterministic
 * from its id, kind and port tier. A church is universal (even a
 * hamlet has a chapel); a market square needs a town-sized population
 * to be worth drawing; a mill is a cosmetic rural feature, present for
 * roughly half of villages/towns/cities (varied by a per-id hash
 * rather than always-on, so neighbouring settlements don't all look
 * identical); a wharf only ever appears where the settlement actually
 * has a port.
 *
 * @param {import('../sim/state.js').Settlement} settlement
 * @returns {{church: boolean, market: boolean, mill: boolean, wharf: boolean}}
 */
export function settlementFeatures(settlement) {
  const hasMarket = settlement.kind === 'town' || settlement.kind === 'city' || settlement.kind === 'capital'
  const millEligible = settlement.kind === 'village' || settlement.kind === 'town' || settlement.kind === 'city' || settlement.kind === 'capital'
  const millRoll = valueNoise2D(SETTLEMENT_LAYOUT_SEED + 5, settlement.id, 0)
  return {
    church: true,
    market: hasMarket,
    mill: millEligible && millRoll < 0.5,
    wharf: settlement.portTier > 0,
  }
}

/**
 * Fixed world-space offsets (relative to the settlement centre) for
 * whichever features `settlementFeatures()` says are present, spread
 * evenly around the centre so they never overlap a regular building
 * slot's own ring. Always the same 4 angles regardless of which
 * features are active, so a feature's position never shifts if
 * another feature appears or disappears later (not currently possible
 * since features depend only on fixed settlement attributes, but keeps
 * the function honest about not reflowing).
 *
 * @param {number} radiusMiles
 * @returns {{church: {x: number, y: number}, market: {x: number, y: number}, mill: {x: number, y: number}, wharf: {x: number, y: number}}}
 */
export function featureOffsets(radiusMiles) {
  const r = radiusMiles * 0.35
  return {
    church: { x: 0, y: -r },
    market: { x: r * 0.87, y: r * 0.5 },
    mill: { x: -r * 0.87, y: r * 0.5 },
    wharf: { x: 0, y: r },
  }
}

/**
 * Advances one settlement's building-slot lifecycle tracking by one
 * frame: any slot index now below `activeCount` that isn't already
 * tracked is born (fade/scale in starts now); any tracked slot at or
 * above `activeCount` is marked abandoned (DESIGN 9.5's "shrinkage
 * shows abandoned buildings... then collapse and removal") the moment
 * it first falls out of range, not re-marked on every later frame; and
 * any abandoned slot that has finished fading is purged entirely. The
 * returned map is owned by the caller across frames (the draw function
 * itself is stateless, called fresh every frame, so lifecycle state
 * has to live somewhere else — the same ref-map pattern as
 * `drawPlaceholderWorld.js`'s `holeSince`).
 *
 * @param {Map<number, Map<number, {bornAt: number, removedAt: number|null}>>} lifecycleMap Settlement id to its own slot-index map. Mutated in place.
 * @param {number} settlementId
 * @param {number} activeCount Current `buildingSlotCount()`.
 * @param {number} nowMs
 * @param {number} abandonedFadeMs How long an abandoned slot stays tracked (and drawn, fading) before being purged.
 * @returns {Map<number, {bornAt: number, removedAt: number|null}>} This settlement's own slot map, for the caller to iterate when drawing.
 */
export function updateBuildingLifecycle(lifecycleMap, settlementId, activeCount, nowMs, abandonedFadeMs) {
  let slots = lifecycleMap.get(settlementId)
  if (!slots) {
    slots = new Map()
    lifecycleMap.set(settlementId, slots)
  }

  for (let index = 0; index < activeCount; index++) {
    const entry = slots.get(index)
    if (!entry) {
      slots.set(index, { bornAt: nowMs, removedAt: null })
    } else if (entry.removedAt !== null) {
      entry.removedAt = null
    }
  }

  for (const [index, entry] of slots) {
    if (index >= activeCount && entry.removedAt === null) {
      entry.removedAt = nowMs
    }
  }

  for (const [index, entry] of slots) {
    if (entry.removedAt !== null && nowMs - entry.removedAt > abandonedFadeMs) {
      slots.delete(index)
    }
  }

  return slots
}

/** @type {number} Footprint polygon vertex count (Area/Local bands). */
const FOOTPRINT_VERTEX_COUNT = 10
/** @type {number} Number of street chords drawn through a footprint (Area/Local bands). */
const STREET_COUNT = 3

/**
 * @param {{r: number, g: number, b: number}} colour
 * @returns {string} `"r,g,b"`, ready to interpolate into an `rgb(...)`/`rgba(...)` CSS string.
 */
function rgbTriplet(colour) {
  return `${Math.round(colour.r)},${Math.round(colour.g)},${Math.round(colour.b)}`
}

/**
 * Region-band representation (DESIGN 9.5): a soft radial gradient, not
 * a hard-edged circle, so it reads as a population glow rather than a
 * marker pin.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} radiusPx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawRegionBlob(ctx, screen, radiusPx, colour) {
  const r = Math.max(3, radiusPx)
  const rgb = rgbTriplet(colour)
  const gradient = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, r)
  gradient.addColorStop(0, `rgba(${rgb},0.55)`)
  gradient.addColorStop(1, `rgba(${rgb},0)`)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * Area/Local-band representation (DESIGN 9.5): a jittered footprint
 * polygon, filled and stroked, with a handful of street chords drawn
 * through it.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('../sim/state.js').Settlement} options.settlement
 * @param {number} options.radiusMiles From `blobRadiusMiles()`.
 * @param {{r: number, g: number, b: number}} options.colour
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {object} options.settlementRules `palette.json`'s `settlements` block.
 * @returns {void}
 */
function drawFootprint({ ctx, settlement, radiusMiles, colour, camera, viewport, projection, settlementRules }) {
  const offsets = footprintOffsets(settlement.id, radiusMiles, settlementRules, FOOTPRINT_VERTEX_COUNT)
  const rgb = rgbTriplet(colour)

  ctx.beginPath()
  offsets.forEach((offset, i) => {
    const point = projection.worldToScreen(camera, viewport, { x: settlement.x + offset.x, y: settlement.y + offset.y })
    if (i === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  ctx.closePath()
  ctx.fillStyle = `rgba(${rgb},0.22)`
  ctx.fill()
  ctx.strokeStyle = `rgba(${rgb},0.8)`
  ctx.lineWidth = 1.5
  ctx.stroke()

  const footprintRadiusMiles = radiusMiles * settlementRules.footprintPaddingFactor
  const streets = footprintStreets(settlement.id, footprintRadiusMiles, STREET_COUNT)
  ctx.strokeStyle = 'rgba(58,52,44,0.55)'
  ctx.lineWidth = 1
  for (const street of streets) {
    const dx = Math.cos(street.angle) * footprintRadiusMiles
    const dy = Math.sin(street.angle) * footprintRadiusMiles
    const a = projection.worldToScreen(camera, viewport, { x: settlement.x - dx, y: settlement.y - dy })
    const b = projection.worldToScreen(camera, viewport, { x: settlement.x + dx, y: settlement.y + dy })
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
}

/**
 * Draws one building (or feature) icon: a rectangle body with a
 * triangular pitched roof, billboarded (drawn at a fixed screen size,
 * never rotated or sheared by the projection — the same convention
 * T2.00's spike established for every small icon). `alpha`/`scale`
 * drive DESIGN 9.5's fade-and-scale-in on growth and fade-toward-
 * nothing on abandonment.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx Body width, in screen pixels.
 * @param {{r: number, g: number, b: number}} colour
 * @param {number} alpha 0 to 1.
 * @param {number} scale 0 to 1, applied to size.
 * @returns {void}
 */
function drawBuildingIcon(ctx, screen, sizePx, colour, alpha, scale) {
  if (alpha <= 0 || sizePx <= 0 || scale <= 0) return
  const width = sizePx * scale
  const height = width * 0.8

  ctx.globalAlpha = alpha
  ctx.fillStyle = `rgb(${rgbTriplet(colour)})`
  ctx.fillRect(screen.x - width / 2, screen.y - height / 2, width, height)
  ctx.beginPath()
  ctx.moveTo(screen.x - width / 2 - 1, screen.y - height / 2)
  ctx.lineTo(screen.x, screen.y - height / 2 - height * 0.6)
  ctx.lineTo(screen.x + width / 2 + 1, screen.y - height / 2)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1
}

/**
 * Detail-band representation (DESIGN 9.5): every active building slot
 * plus any still-fading abandoned one, each by its class district
 * colour (or the abandoned tint once vacated), with growth fade/scale-
 * in and shrink fade-out; then whichever civic features
 * `settlementFeatures()` says this settlement has.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('../sim/state.js').Settlement} options.settlement
 * @param {number} options.radiusMiles
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {string[]} options.classOrder
 * @param {Record<string, number>} options.shares From `classShares()`.
 * @param {object} options.settlementRules `palette.json`'s `settlements` block.
 * @param {Record<string, {r: number, g: number, b: number}>} options.classColoursRgb Pre-parsed, once per frame (not once per building).
 * @param {Record<string, {r: number, g: number, b: number}>} options.featureColoursRgb Pre-parsed, once per frame.
 * @param {{r: number, g: number, b: number}} options.abandonedRgb Pre-parsed, once per frame.
 * @param {Map<number, Map<number, {bornAt: number, removedAt: number|null}>>} options.lifecycleMap Mutated in place; owned by the caller across frames.
 * @param {number} options.nowMs
 * @param {boolean} [options.reducedMotion] PHASES.md T2.14: skips the fade-in/abandon-fade ramp below, drawing each building at its final look (fully appeared, or fully faded if abandoned) the instant its lifecycle state changes, rather than animating the transition.
 * @returns {void}
 */
function drawBuildings({ ctx, settlement, radiusMiles, camera, viewport, projection, classOrder, shares, settlementRules, classColoursRgb, featureColoursRgb, abandonedRgb, lifecycleMap, nowMs, reducedMotion }) {
  const activeCount = buildingSlotCount(settlement.housing, settlementRules)
  // `updateBuildingLifecycle` always gets the real `nowMs`, reduced
  // motion or not — it is bookkeeping (when a slot was born/abandoned),
  // not an animation, and freezing it would leave abandoned buildings
  // stuck "mid-fade" in the lifecycle map forever instead of ever
  // actually finishing their removal.
  const slots = updateBuildingLifecycle(lifecycleMap, settlement.id, activeCount, nowMs, settlementRules.abandonedFadeMs)

  for (const [index, entry] of slots) {
    const slot = buildingSlot(settlement.id, index, classOrder, shares)
    const worldX = settlement.x + Math.cos(slot.angle) * radiusMiles * slot.radiusFraction
    const worldY = settlement.y + Math.sin(slot.angle) * radiusMiles * slot.radiusFraction
    const screen = projection.worldToScreen(camera, viewport, { x: worldX, y: worldY })
    const sizeMiles = (settlementRules.buildingSizeMilesByClass[slot.classId] ?? 0.1) * slot.sizeJitter
    const sizePx = sizeMiles * camera.ppm

    const isAbandoned = entry.removedAt !== null
    let alpha
    let scale
    if (reducedMotion) {
      alpha = isAbandoned ? 0.3 : 1
      scale = 1
    } else if (!isAbandoned) {
      const t = Math.min(1, (nowMs - entry.bornAt) / settlementRules.fadeInMs)
      alpha = t
      scale = 0.3 + 0.7 * t
    } else {
      const t = Math.min(1, (nowMs - entry.removedAt) / settlementRules.abandonedFadeMs)
      alpha = 1 - t * 0.7
      scale = 1
    }
    const colour = isAbandoned ? abandonedRgb : (classColoursRgb[slot.classId] ?? abandonedRgb)
    drawBuildingIcon(ctx, screen, sizePx, colour, alpha, scale)
  }

  const features = settlementFeatures(settlement)
  const offsets = featureOffsets(radiusMiles)
  const featureSizePx = settlementRules.featureSizeMiles * camera.ppm
  for (const [name, present] of Object.entries(features)) {
    if (!present) continue
    const offset = offsets[name]
    const screen = projection.worldToScreen(camera, viewport, { x: settlement.x + offset.x, y: settlement.y + offset.y })
    drawBuildingIcon(ctx, screen, featureSizePx, featureColoursRgb[name], 1, 1)
  }
}

/**
 * Draws every settlement on the dynamic canvas layer (DESIGN 9.3),
 * picking DESIGN 9.5's band representation from the camera's current
 * `ppm`: a Region blob below `settlementRules.regionMaxPpm`, an
 * Area/Local footprint-and-streets below `settlementRules.localMaxPpm`,
 * and individual Detail-band buildings above that. Does not clear the
 * canvas — the caller owns that, same convention as `drawNetworkLayer()`.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {import('../sim/state.js').Settlement[]} options.settlements
 * @param {{id: string}[]} options.classesRules `classes.json`'s `classes` array.
 * @param {object} options.settlementRules `palette.json`'s `settlements` block.
 * @param {Map<number, Map<number, {bornAt: number, removedAt: number|null}>>} options.lifecycleMap Mutated in place; owned by the caller across frames (the same ref-map pattern as `drawPlaceholderWorld.js`'s `holeSince`).
 * @param {number} options.nowMs
 * @param {boolean} [options.reducedMotion] PHASES.md T2.14: forwarded to `drawBuildings()`'s own doc comment.
 * @returns {void}
 */
export function drawSettlementsLayer({ ctx, camera, viewport, projection, settlements, classesRules, settlementRules, lifecycleMap, nowMs, reducedMotion }) {
  const classOrder = classesRules.map((c) => c.id)
  const classColoursRgb = {}
  for (const id of classOrder) classColoursRgb[id] = hexToRgb(settlementRules.classColours[id] ?? '#888888')
  const featureColoursRgb = {}
  for (const [name, hex] of Object.entries(settlementRules.featureColours)) featureColoursRgb[name] = hexToRgb(hex)
  const abandonedRgb = hexToRgb(settlementRules.abandonedColour)

  for (const settlement of settlements) {
    const population = totalPopulation(settlement)
    const shares = classShares(settlement, classesRules)
    const screen = projection.worldToScreen(camera, viewport, { x: settlement.x, y: settlement.y })
    const radiusMiles = blobRadiusMiles(population, settlementRules)

    if (camera.ppm < settlementRules.regionMaxPpm) {
      drawRegionBlob(ctx, screen, radiusMiles * camera.ppm, dominantColour(shares, settlementRules.classColours))
    } else if (camera.ppm < settlementRules.localMaxPpm) {
      drawFootprint({ ctx, settlement, radiusMiles, colour: dominantColour(shares, settlementRules.classColours), camera, viewport, projection, settlementRules })
    } else {
      drawBuildings({ ctx, settlement, radiusMiles, camera, viewport, projection, classOrder, shares, settlementRules, classColoursRgb, featureColoursRgb, abandonedRgb, lifecycleMap, nowMs, reducedMotion })
    }
  }
}
