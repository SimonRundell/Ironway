import { monthIndexOf, yearIndexOf } from '../sim/clock.js'
import { computeCoverage, computePriceMultiplier, computePrice } from '../sim/economy/prices.js'
import { computePopulationDemand, computeRelayDemand, computeIndustryDemand, mergeDemand } from '../sim/economy/demand.js'
import { scaleIndustryDef } from '../sim/economy/industryLifecycle.js'
import { computeBuildableMask } from '../sim/mapgen/settlements.js'
import { RESOURCE } from '../sim/mapgen/resources.js'
import { classShares, dominantColour } from './settlements.js'

/**
 * Heat overlays (PHASES.md T2.12, DESIGN 9.6's "toggles: prices by
 * cargo, class distribution, confidence, employment, flows, resources,
 * land suitability"). Settlement-scalar overlays (`confidence`,
 * `employment`, `prices`) draw a coloured ring at each settlement's own
 * position, sized the same way `render/settlements.js` already sizes a
 * Region-band blob; `classMix` reuses that module's own dominant-class
 * colour directly rather than a heat ramp, since it is categorical, not
 * a scalar. `flows` colours and thickens each link by its total
 * `recentFlow` tonnes. `resources` and `suitability` are grid-level:
 * drawn as one filled rect per visible grid cell directly from
 * `world.grid`, not through the tile pyramid — DESIGN 9.3's "static
 * overlays" layer, uncached, since a toggle changes instantly and the
 * grid is small enough (a few thousand cells at most) that a redraw on
 * every pan/zoom is cheap, the same cost class as `network.js`'s own
 * per-frame line draws.
 *
 * `drawOverlayLayer()` is the one function touching a canvas; every
 * value/colour function above it is pure and unit tested on its own,
 * the same split every other render module in this project uses.
 *
 * @module render/overlays
 */

/** @type {readonly string[]} Valid overlay modes, `'none'` meaning nothing drawn. */
export const OVERLAY_MODES = Object.freeze(['none', 'prices', 'classMix', 'confidence', 'employment', 'flows', 'resources', 'suitability'])

/**
 * Linearly interpolates a value through a multi-stop hex colour ramp.
 *
 * @param {number} t 0 to 1.
 * @param {string[]} stops Hex colours (`#rrggbb`), evenly spaced along `t`.
 * @returns {string} `rgb(r, g, b)`.
 */
export function rampColour(t, stops) {
  const clamped = Math.min(1, Math.max(0, t))
  const segment = clamped * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(segment))
  const localT = segment - i

  const a = hexToRgb(stops[i])
  const b = hexToRgb(stops[i + 1])
  const r = Math.round(a.r + (b.r - a.r) * localT)
  const g = Math.round(a.g + (b.g - a.g) * localT)
  const bl = Math.round(a.b + (b.b - a.b) * localT)
  return `rgb(${r}, ${g}, ${bl})`
}

/** @param {string} hex `#rrggbb`. @returns {{r: number, g: number, b: number}} */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

/**
 * @param {import('../sim/state.js').Settlement} settlement
 * @returns {number} Population-weighted mean confidence, 0 to 100 (50 if the settlement has no population yet).
 */
export function confidenceForSettlement(settlement) {
  let sum = 0
  let weight = 0
  for (const row of Object.values(settlement.pop)) {
    if (!row || row.pop <= 0) continue
    sum += row.confidence * row.pop
    weight += row.pop
  }
  return weight > 0 ? sum / weight : 50
}

/**
 * @param {import('../sim/state.js').Settlement} settlement
 * @returns {number} Island-standard employment rate, 0 to 1 (0 if the settlement has no labour force yet).
 */
export function employmentRateForSettlement(settlement) {
  let employed = 0
  let pop = 0
  for (const row of Object.values(settlement.pop)) {
    if (!row) continue
    employed += row.employed || 0
    pop += row.pop || 0
  }
  return pop > 0 ? employed / pop : 0
}

/**
 * Recomputes one cargo's current price at a settlement, the same
 * display-only approximation `ui/inspector/displaySettlementPrices.js`
 * already uses for the Inspector's own price table (`tick.js` never
 * persists demand/price numbers — DESIGN 7.1 treats them as ephemeral,
 * recomputed fresh every tick).
 *
 * @param {import('../sim/state.js').Settlement} settlement
 * @param {import('../sim/state.js').GameState} gameState
 * @param {object} rules The full validated rules bundle.
 * @param {string} cargoId
 * @param {Map<number, string>} classIdByIndex
 * @param {number} monthIndex
 * @param {number} year
 * @returns {number|null} The price, or `null` if this cargo has no demand at this settlement at all.
 */
export function priceForSettlement(settlement, gameState, rules, cargoId, classIdByIndex, monthIndex, year) {
  const cargoDef = rules.cargo.find((c) => c.id === cargoId)
  if (!cargoDef) return null

  const classRows = [...classIdByIndex].map(([index, classId]) => ({
    classId,
    pop: settlement.pop[index]?.pop || 0,
    confidence: settlement.pop[index]?.confidence ?? 50,
  }))
  const populationDemand = computePopulationDemand(classRows, settlement.kind, rules.difficulty.demandMode, rules.economy, 1, monthIndex, year)

  const industryDefById = new Map(rules.industries.map((d) => [d.id, d]))
  const localIndustryDemands = gameState.industries
    .filter((ind) => ind.homeSettlementId === settlement.id && ind.closedDay === null)
    .map((ind) => computeIndustryDemand(scaleIndustryDef(industryDefById.get(ind.typeId), ind.capacity)))

  const totalPop = classRows.reduce((sum, row) => sum + row.pop, 0)
  const relayDemand = computeRelayDemand(totalPop, [cargoId], rules.economy.flow.relayDemandPerThousandPerMonth)

  const demand = mergeDemand(populationDemand, relayDemand, ...localIndustryDemands)
  const cargoDemand = demand[cargoId] || 0
  if (cargoDemand <= 0 && (settlement.stock[cargoId] || 0) <= 0) return null

  const coverage = computeCoverage(settlement.stock[cargoId] || 0, cargoDemand)
  const multiplier = computePriceMultiplier(coverage, cargoDef.elasticity, rules.economy.price)
  const revenueMultiplier = rules.economy.levels[gameState.economyState.level].revenue
  return computePrice(cargoDef.basePrice, multiplier, revenueMultiplier)
}

/**
 * @typedef {object} SettlementMetric
 * @property {number} settlementId
 * @property {number|null} value `null` means this settlement has nothing to show (e.g. no demand for the selected cargo).
 */

/**
 * Computes every settlement's value for a scalar overlay mode
 * (`confidence`, `employment` or `prices`), ready to colour with
 * `rampColour()` against the mode's own fixed or relative range.
 *
 * @param {import('../sim/state.js').Settlement[]} settlements
 * @param {'confidence'|'employment'|'prices'} mode
 * @param {object} [context] Required for `'prices'`: `{gameState, rules, cargoId, classIdByIndex, gameDay, startYear}`.
 * @returns {SettlementMetric[]}
 */
export function settlementMetrics(settlements, mode, context = {}) {
  if (mode === 'confidence') {
    return settlements.map((s) => ({ settlementId: s.id, value: confidenceForSettlement(s) }))
  }
  if (mode === 'employment') {
    return settlements.map((s) => ({ settlementId: s.id, value: employmentRateForSettlement(s) }))
  }
  if (mode === 'prices') {
    const { gameState, rules, cargoId, classIdByIndex, gameDay, startYear } = context
    const monthIndex = monthIndexOf(gameDay)
    const year = startYear + yearIndexOf(gameDay)
    return settlements.map((s) => ({
      settlementId: s.id,
      value: priceForSettlement(s, gameState, rules, cargoId, classIdByIndex, monthIndex, year),
    }))
  }
  return settlements.map((s) => ({ settlementId: s.id, value: null }))
}

/**
 * @param {SettlementMetric[]} metrics
 * @returns {{min: number, max: number}} The range of non-null values (`{min: 0, max: 1}` if every value is `null`, so `normaliseValue()` never divides by zero).
 */
export function metricRange(metrics) {
  const values = metrics.map((m) => m.value).filter((v) => v !== null && Number.isFinite(v))
  if (values.length === 0) return { min: 0, max: 1 }
  return { min: Math.min(...values), max: Math.max(...values) }
}

/**
 * @param {number} value
 * @param {{min: number, max: number}} range
 * @returns {number} 0 to 1.
 */
export function normaliseValue(value, range) {
  const span = range.max - range.min
  if (span <= 0) return 0.5
  return (value - range.min) / span
}

/**
 * @param {import('../sim/state.js').Link} link
 * @returns {number} Total tonnes carried last month, summed across cargo.
 */
export function linkTotalFlow(link) {
  return Object.values(link.recentFlow || {}).reduce((sum, t) => sum + t, 0)
}

/**
 * @param {number} population
 * @param {object} settlementRules `palette.json`'s `settlements` block, for the same blob-radius formula `render/settlements.js` uses.
 * @param {object} overlayRules `palette.json`'s `overlays` block.
 * @returns {number} Ring radius in world miles.
 */
function ringRadiusMiles(population, settlementRules, overlayRules) {
  const base = Math.max(settlementRules.minBlobRadiusMiles, Math.sqrt(Math.max(0, population)) * settlementRules.blobRadiusMilesPerSqrtPop)
  return Math.min(overlayRules.ringRadiusMaxMiles, Math.max(overlayRules.ringRadiusMinMiles, base))
}

/**
 * Draws the selected heat overlay on the overlay canvas. Does not clear
 * the canvas — the caller owns that, same convention as every other
 * `drawXLayer` function in this project.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function, visibleWorldPolygon: Function}} options.projection
 * @param {string} options.mode One of `OVERLAY_MODES`, `'none'` draws nothing.
 * @param {object} options.grid `World.grid`: the generated world's grid layers, for `'resources'`/`'suitability'`.
 * @param {import('../sim/state.js').GameState} options.gameState
 * @param {object} options.rules The full validated rules bundle.
 * @param {string} [options.cargoId] Required when `mode === 'prices'`.
 * @param {Map<number, string>} [options.classIdByIndex] Required when `mode === 'prices'` or `'classMix'`.
 * @param {number} [options.gameDay] Required when `mode === 'prices'`.
 * @param {number} [options.startYear] Required when `mode === 'prices'`.
 * @returns {void}
 */
export function drawOverlayLayer({ ctx, camera, viewport, projection, mode, grid, gameState, rules, cargoId, classIdByIndex, gameDay, startYear }) {
  if (mode === 'none') return
  const overlayRules = rules.palette.overlays

  if (mode === 'resources' || mode === 'suitability') {
    drawGridOverlay({ ctx, camera, viewport, projection, mode, grid, rules, overlayRules })
    return
  }

  if (mode === 'flows') {
    drawFlowOverlay({ ctx, camera, viewport, projection, links: gameState.links, overlayRules })
    return
  }

  if (mode === 'classMix') {
    for (const settlement of gameState.settlements) {
      const shares = classShares(settlement, rules.classes)
      const { r, g, b } = dominantColour(shares, rules.palette.settlements.classColours)
      drawRing(ctx, camera, viewport, projection, settlement, `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`, rules.palette.settlements, overlayRules)
    }
    return
  }

  const metrics = settlementMetrics(gameState.settlements, mode, { gameState, rules, cargoId, classIdByIndex, gameDay, startYear })
  const range = mode === 'confidence' ? { min: 0, max: 100 } : mode === 'employment' ? { min: 0, max: 1 } : metricRange(metrics)
  const byId = new Map(metrics.map((m) => [m.settlementId, m.value]))

  for (const settlement of gameState.settlements) {
    const value = byId.get(settlement.id)
    if (value === null || value === undefined) continue
    const colour = rampColour(normaliseValue(value, range), overlayRules.heatRamp)
    drawRing(ctx, camera, viewport, projection, settlement, colour, rules.palette.settlements, overlayRules)
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./projection.js').Camera} camera
 * @param {import('./projection.js').Viewport} viewport
 * @param {object} projection
 * @param {import('../sim/state.js').Settlement} settlement
 * @param {string} colour
 * @param {object} settlementRules
 * @param {object} overlayRules
 * @returns {void}
 */
function drawRing(ctx, camera, viewport, projection, settlement, colour, settlementRules, overlayRules) {
  const pop = Object.values(settlement.pop).reduce((sum, row) => sum + (row?.pop || 0), 0)
  const radiusMiles = ringRadiusMiles(pop, settlementRules, overlayRules)
  const screen = projection.worldToScreen(camera, viewport, { x: settlement.x, y: settlement.y })
  const radiusPx = radiusMiles * camera.ppm

  ctx.globalAlpha = overlayRules.ringAlpha
  ctx.fillStyle = colour
  ctx.beginPath()
  ctx.arc(screen.x, screen.y, radiusPx, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.strokeStyle = overlayRules.ringStrokeColour
  ctx.lineWidth = 1
  ctx.stroke()
}

/**
 * @param {object} options
 * @returns {void}
 */
function drawFlowOverlay({ ctx, camera, viewport, projection, links, overlayRules }) {
  const totals = links.map((link) => ({ link, total: linkTotalFlow(link) }))
  const range = metricRange(totals.map((t) => ({ settlementId: 0, value: t.total > 0 ? t.total : null })))

  for (const { link, total } of totals) {
    if (total <= 0 || !link.path || link.path.length < 2) continue
    const t = normaliseValue(total, range)
    ctx.strokeStyle = rampColour(t, overlayRules.heatRamp)
    ctx.globalAlpha = overlayRules.flowAlpha
    ctx.lineWidth = overlayRules.flowMinWidthPx + t * (overlayRules.flowMaxWidthPx - overlayRules.flowMinWidthPx)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    link.path.forEach(([x, y], i) => {
      const screen = projection.worldToScreen(camera, viewport, { x, y })
      if (i === 0) ctx.moveTo(screen.x, screen.y)
      else ctx.lineTo(screen.x, screen.y)
    })
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** @type {WeakMap<object, Uint8Array>} `grid -> buildable mask`, computed once per world rather than every frame. */
const buildableMaskCache = new WeakMap()

/**
 * @param {object} options
 * @returns {void}
 */
function drawGridOverlay({ ctx, camera, viewport, projection, mode, grid, rules, overlayRules }) {
  const corners = projection.visibleWorldPolygon(camera, viewport)
  const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x)) / grid.cellMiles))
  const maxX = Math.min(grid.width - 1, Math.ceil(Math.max(...corners.map((c) => c.x)) / grid.cellMiles))
  const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y)) / grid.cellMiles))
  const maxY = Math.min(grid.height - 1, Math.ceil(Math.max(...corners.map((c) => c.y)) / grid.cellMiles))

  let buildableMask = null
  if (mode === 'suitability') {
    buildableMask = buildableMaskCache.get(grid)
    if (!buildableMask) {
      buildableMask = computeBuildableMask(grid, rules.terrain)
      buildableMaskCache.set(grid, buildableMask)
    }
  }

  const resourceNameByValue = { [RESOURCE.COAL]: 'coal', [RESOURCE.IRON]: 'iron', [RESOURCE.STONE]: 'stone', [RESOURCE.CLAY]: 'clay' }
  const cellSizePx = grid.cellMiles * camera.ppm

  ctx.globalAlpha = overlayRules.cellAlpha
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * grid.width + x
      if (grid.water[i] !== 0) continue

      let colour
      if (mode === 'resources') {
        const name = resourceNameByValue[grid.resource[i]]
        if (!name) continue
        colour = overlayRules.resourceColours[name]
      } else {
        colour = buildableMask[i] ? overlayRules.suitabilityBuildableColour : overlayRules.suitabilityUnbuildableColour
      }

      const screen = projection.worldToScreen(camera, viewport, { x: x * grid.cellMiles, y: y * grid.cellMiles })
      ctx.fillStyle = colour
      ctx.fillRect(screen.x, screen.y, Math.ceil(cellSizePx), Math.ceil(cellSizePx))
    }
  }
  ctx.globalAlpha = 1
}
