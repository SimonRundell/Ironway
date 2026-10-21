import { DAYS_PER_MONTH } from '../sim/clock.js'
import { valueNoise2D } from '../sim/noise.js'
import { hexToRgb } from './terrain/sampleTerrain.js'

/**
 * Industry rendering (PHASES.md T2.08, DESIGN 9.6): a distinct sprite
 * per industry type, smoke or steam scaled by utilisation, turning
 * mill wheels, glowing furnaces and a shipyard slipway, a construction
 * look for the first months after opening and an increasingly derelict
 * look for however long an industry has stayed closed. Industries have
 * no footprint or population to grow into (unlike `settlements.js`'s
 * settlements) — one `Industry` is always exactly one sprite — so
 * there is no zoom-band layout to derive, only a style and an
 * animation state, both pure functions of the industry's own fields
 * plus the current sim day and render timestamp.
 *
 * Pure style/animation/particle-state helpers are exported and unit
 * tested on their own; `drawIndustriesLayer()` is the one function
 * that touches a `CanvasRenderingContext2D`, browser-verified the same
 * way every other canvas-drawing function in this project is.
 *
 * @module render/industries
 */

/** @type {number} Fixed seed for the smoke-particle phase-offset hash. Not tied to the world's own seed: the offset is cosmetic (which instant in a repeating cycle a given particle slot is at), not a generation input. */
const PARTICLE_SEED = 51407

/**
 * @param {string} typeId An `industries.json` id.
 * @param {object} industriesRules `palette.json`'s `industries` block.
 * @returns {string} One of `mine`, `forestry`, `fishery`, `watermill`, `furnace`, `shipyard`, `factory`.
 */
export function spriteCategoryFor(typeId, industriesRules) {
  return industriesRules.spriteCategoryByTypeId[typeId] ?? 'factory'
}

/**
 * @param {string} typeId
 * @param {object} industriesRules
 * @returns {{r: number, g: number, b: number}}
 */
export function industryColour(typeId, industriesRules) {
  return hexToRgb(industriesRules.colourByTypeId[typeId] ?? '#888888')
}

/**
 * @param {string} category From `spriteCategoryFor()`.
 * @param {object} industriesRules
 * @returns {boolean} Whether this category ever emits smoke/steam (DESIGN 9.6: water-powered mills and the non-fuel-burning forestry/fishery sites do not).
 */
export function categoryHasSmoke(category, industriesRules) {
  return industriesRules.smokeByCategory[category] ?? true
}

/**
 * @param {number} value
 * @returns {number} `value` clamped to [0, 1].
 */
function clamp01(value) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * An industry's lifecycle phase (DESIGN 9.6: "construction look on
 * opening", "derelict look after closure, as months of closure pass").
 * `closedDay` takes priority over `openedDay`: a closed industry is
 * derelict regardless of how recently it had opened before closing.
 *
 * @param {import('../sim/state.js').Industry} industry
 * @param {number} gameDay The sim's current day.
 * @param {object} industriesRules `palette.json`'s `industries` block (`constructionDays`, `derelictFullDays`).
 * @returns {{phase: 'construction', constructionT: number}|{phase: 'derelict', derelictT: number}|{phase: 'operating'}} `constructionT`/`derelictT` are 0 to 1 progress through the respective look.
 */
export function lifecyclePhase(industry, gameDay, industriesRules) {
  if (industry.closedDay !== null) {
    const daysSinceClose = gameDay - industry.closedDay
    return { phase: 'derelict', derelictT: clamp01(daysSinceClose / industriesRules.derelictFullDays) }
  }
  const daysSinceOpen = gameDay - industry.openedDay
  if (daysSinceOpen < industriesRules.constructionDays) {
    return { phase: 'construction', constructionT: clamp01(daysSinceOpen / industriesRules.constructionDays) }
  }
  return { phase: 'operating' }
}

/**
 * @param {import('../sim/state.js').Industry} industry
 * @param {object} industriesRules `palette.json`'s `industries` block (`idleUtilisation`).
 * @returns {boolean} True when utilisation is too low to count as active (DESIGN 9.6/PHASES.md T2.08's own Done-when: "idle industries do not animate").
 */
export function isIdle(industry, industriesRules) {
  return industry.utilisation < industriesRules.idleUtilisation
}

/**
 * How many smoke/steam particles an operating, non-idle industry of a
 * smoke-emitting category should have active at once (DESIGN 9.6:
 * "smoke or steam particles scaled by utilisation"). Zero whenever the
 * industry isn't actually operating (closed, under construction,
 * idle) or its category never emits smoke at all.
 *
 * @param {import('../sim/state.js').Industry} industry
 * @param {string} category From `spriteCategoryFor()`.
 * @param {{phase: string}} lifecycle From `lifecyclePhase()`.
 * @param {object} industriesRules `palette.json`'s `industries` block (`maxParticlesPerIndustry`).
 * @returns {number} Integer particle count.
 */
export function particleCountFor(industry, category, lifecycle, industriesRules) {
  if (lifecycle.phase !== 'operating') return 0
  if (!categoryHasSmoke(category, industriesRules)) return 0
  if (isIdle(industry, industriesRules)) return 0
  return Math.max(1, Math.round(industry.utilisation * industriesRules.maxParticlesPerIndustry))
}

/**
 * One smoke particle's animated state at a given moment: a repeating
 * rise-and-fade cycle, `particleLifeMs` long, phase-offset per
 * `(industryId, slotIndex)` so an industry's several particles don't
 * all pulse in lockstep. Deterministic and side-effect free — the
 * same `nowMs` always gives the same result, which is what makes this
 * independently unit testable without a running animation loop.
 *
 * @param {number} industryId
 * @param {number} slotIndex
 * @param {number} nowMs The render loop's own frame timestamp.
 * @param {object} industriesRules `palette.json`'s `industries` block (`particleLifeMs`, `particleRiseMiles`).
 * @returns {{riseMiles: number, alpha: number, driftMiles: number}}
 */
export function particleState(industryId, slotIndex, nowMs, industriesRules) {
  const phaseOffsetMs = valueNoise2D(PARTICLE_SEED, industryId, slotIndex) * industriesRules.particleLifeMs
  const t = ((nowMs + phaseOffsetMs) % industriesRules.particleLifeMs) / industriesRules.particleLifeMs
  const riseMiles = t * industriesRules.particleRiseMiles
  const alpha = Math.sin(t * Math.PI)
  const driftSign = valueNoise2D(PARTICLE_SEED + 1, industryId, slotIndex) - 0.5
  const driftMiles = driftSign * 0.2 * riseMiles
  return { riseMiles, alpha, driftMiles }
}

/**
 * A mill/furnace wheel's rotation angle at a given moment: proportional
 * to utilisation (faster at higher utilisation, motionless at zero),
 * never animating at all once idle or not operating — DESIGN 9.6's
 * "water wheels or mills that turn" and the Done-when's "idle
 * industries do not animate" are the same requirement for this helper.
 *
 * @param {import('../sim/state.js').Industry} industry
 * @param {{phase: string}} lifecycle From `lifecyclePhase()`.
 * @param {number} nowMs
 * @param {object} industriesRules `palette.json`'s `industries` block (`idleUtilisation`).
 * @returns {number} Radians, or 0 if the wheel should not be turning.
 */
export function wheelAngle(industry, lifecycle, nowMs, industriesRules) {
  if (lifecycle.phase !== 'operating' || isIdle(industry, industriesRules)) return 0
  return (nowMs / 1000) * industry.utilisation * Math.PI * 2 * 0.3
}

/**
 * A furnace's glow intensity at a given moment: a gentle pulse scaled
 * by utilisation, zero whenever idle or not operating (DESIGN 9.6's
 * "furnaces glowing").
 *
 * @param {import('../sim/state.js').Industry} industry
 * @param {{phase: string}} lifecycle From `lifecyclePhase()`.
 * @param {number} nowMs
 * @param {object} industriesRules `palette.json`'s `industries` block (`idleUtilisation`).
 * @returns {number} 0 to 1.
 */
export function furnaceGlowIntensity(industry, lifecycle, nowMs, industriesRules) {
  if (lifecycle.phase !== 'operating' || isIdle(industry, industriesRules)) return 0
  return industry.utilisation * (0.7 + 0.3 * Math.sin(nowMs / 400))
}

/**
 * @param {{r: number, g: number, b: number}} colour
 * @returns {string} `"r,g,b"`, ready to interpolate into an `rgb(...)`/`rgba(...)` CSS string.
 */
function rgbTriplet(colour) {
  return `${Math.round(colour.r)},${Math.round(colour.g)},${Math.round(colour.b)}`
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * @param {{r: number, g: number, b: number}} a
 * @param {{r: number, g: number, b: number}} b
 * @param {number} t
 * @returns {{r: number, g: number, b: number}}
 */
function lerpRgb(a, b, t) {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) }
}

/**
 * A mine head-frame (DESIGN 9.6): an A-frame of two angled legs meeting
 * at a pulley wheel, over a small base shed. Never animated — DESIGN
 * only calls for mills/wheels to turn and furnaces to glow, not
 * head-frames, so a mine's only moving part is its smoke.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawMineSprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  const halfWidth = sizePx * 0.3
  const height = sizePx * 0.8
  const top = { x: screen.x, y: screen.y - height }
  ctx.strokeStyle = `rgb(${rgb})`
  ctx.lineWidth = Math.max(1, sizePx * 0.08)
  ctx.beginPath()
  ctx.moveTo(screen.x - halfWidth, screen.y)
  ctx.lineTo(top.x, top.y)
  ctx.lineTo(screen.x + halfWidth, screen.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(top.x, top.y, sizePx * 0.1, 0, Math.PI * 2)
  ctx.fillStyle = `rgb(${rgb})`
  ctx.fill()
  ctx.fillRect(screen.x - halfWidth * 0.9, screen.y - sizePx * 0.18, halfWidth * 1.8, sizePx * 0.18)
}

/**
 * A forestry camp (DESIGN 9.6: a distinct recognisable sprite, no
 * special animation called out): a stacked pile of logs beside a
 * pitched-roof hut.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawForestrySprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.fillStyle = `rgb(${rgb})`
  const logRadius = sizePx * 0.12
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.arc(screen.x - sizePx * 0.3 + i * logRadius * 1.6, screen.y, logRadius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.beginPath()
  ctx.moveTo(screen.x + sizePx * 0.08, screen.y + sizePx * 0.2)
  ctx.lineTo(screen.x + sizePx * 0.3, screen.y - sizePx * 0.35)
  ctx.lineTo(screen.x + sizePx * 0.52, screen.y + sizePx * 0.2)
  ctx.closePath()
  ctx.fill()
}

/**
 * A fishery (DESIGN 9.6): a jetty with a small boat hull moored beside
 * it and a net arc.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawFisherySprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.strokeStyle = `rgb(${rgb})`
  ctx.lineWidth = Math.max(1, sizePx * 0.06)
  ctx.beginPath()
  ctx.moveTo(screen.x - sizePx * 0.4, screen.y)
  ctx.lineTo(screen.x + sizePx * 0.4, screen.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(screen.x - sizePx * 0.3, screen.y + sizePx * 0.05)
  ctx.lineTo(screen.x, screen.y + sizePx * 0.3)
  ctx.lineTo(screen.x + sizePx * 0.3, screen.y + sizePx * 0.05)
  ctx.closePath()
  ctx.fillStyle = `rgb(${rgb})`
  ctx.fill()
  ctx.beginPath()
  ctx.arc(screen.x, screen.y - sizePx * 0.15, sizePx * 0.25, Math.PI * 0.15, Math.PI * 0.85)
  ctx.stroke()
}

/**
 * A water-powered mill (DESIGN 9.6's "water wheels or mills that
 * turn"): a building with a spoked wheel on one side, rotated by
 * `angle` (from `wheelAngle()`, 0 when idle or not operating).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @param {number} angle Radians.
 * @returns {void}
 */
function drawWatermillSprite(ctx, screen, sizePx, colour, angle) {
  const rgb = rgbTriplet(colour)
  ctx.fillStyle = `rgb(${rgb})`
  const bodyWidth = sizePx * 0.55
  const bodyHeight = sizePx * 0.45
  ctx.fillRect(screen.x - bodyWidth * 0.1, screen.y - bodyHeight * 0.5, bodyWidth, bodyHeight)

  const wheelCentre = { x: screen.x - sizePx * 0.28, y: screen.y }
  const wheelRadius = sizePx * 0.28
  ctx.strokeStyle = `rgb(${rgb})`
  ctx.lineWidth = Math.max(1, sizePx * 0.05)
  ctx.beginPath()
  ctx.arc(wheelCentre.x, wheelCentre.y, wheelRadius, 0, Math.PI * 2)
  ctx.stroke()
  for (let i = 0; i < 6; i++) {
    const spokeAngle = angle + (i / 6) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(wheelCentre.x, wheelCentre.y)
    ctx.lineTo(wheelCentre.x + Math.cos(spokeAngle) * wheelRadius, wheelCentre.y + Math.sin(spokeAngle) * wheelRadius)
    ctx.stroke()
  }
}

/**
 * A furnace works (DESIGN 9.6's "furnaces glowing"): a tall stack over
 * a base that blends toward `industriesRules.furnaceGlowColour` as
 * `glowIntensity` (from `furnaceGlowIntensity()`) rises.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @param {number} glowIntensity 0 to 1.
 * @param {{r: number, g: number, b: number}} glowColour
 * @returns {void}
 */
function drawFurnaceSprite(ctx, screen, sizePx, colour, glowIntensity, glowColour) {
  const stackRgb = rgbTriplet(colour)
  ctx.fillStyle = `rgb(${stackRgb})`
  ctx.fillRect(screen.x - sizePx * 0.1, screen.y - sizePx * 0.7, sizePx * 0.2, sizePx * 0.7)

  const baseColour = glowIntensity > 0 ? lerpRgb(colour, glowColour, glowIntensity) : colour
  ctx.fillStyle = `rgb(${rgbTriplet(baseColour)})`
  ctx.fillRect(screen.x - sizePx * 0.35, screen.y - sizePx * 0.05, sizePx * 0.7, sizePx * 0.35)
}

/**
 * A shipyard (DESIGN 9.6's "shipyard slipways with hulls under
 * construction"): an angled slipway with a hull-shaped scaffold on it.
 * Always shown mid-construction — a shipyard's whole purpose is
 * building ships, so this look is permanent, not tied to
 * `lifecyclePhase()`'s own construction/operating distinction (which
 * still governs whether the slipway itself looks newly built or
 * derelict).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawShipyardSprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.strokeStyle = `rgb(${rgb})`
  ctx.lineWidth = Math.max(1, sizePx * 0.06)
  ctx.beginPath()
  ctx.moveTo(screen.x - sizePx * 0.4, screen.y + sizePx * 0.3)
  ctx.lineTo(screen.x + sizePx * 0.4, screen.y - sizePx * 0.1)
  ctx.stroke()

  ctx.fillStyle = `rgb(${rgb})`
  ctx.beginPath()
  ctx.ellipse(screen.x, screen.y, sizePx * 0.32, sizePx * 0.14, -0.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(40,36,30,0.6)'
  ctx.lineWidth = Math.max(1, sizePx * 0.03)
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath()
    ctx.moveTo(screen.x + i * sizePx * 0.12, screen.y - sizePx * 0.18)
    ctx.lineTo(screen.x + i * sizePx * 0.12, screen.y + sizePx * 0.1)
    ctx.stroke()
  }
}

/**
 * A generic factory (every category that isn't a mine, forestry camp,
 * fishery, water mill, furnace or shipyard): a rectangular building
 * with two chimney stacks, coloured by `industriesRules.colourByTypeId`
 * so different factory types are still distinguishable from each
 * other even though they share a silhouette.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {{r: number, g: number, b: number}} colour
 * @returns {void}
 */
function drawFactorySprite(ctx, screen, sizePx, colour) {
  const rgb = rgbTriplet(colour)
  ctx.fillStyle = `rgb(${rgb})`
  ctx.fillRect(screen.x - sizePx * 0.4, screen.y - sizePx * 0.25, sizePx * 0.8, sizePx * 0.4)
  ctx.fillRect(screen.x - sizePx * 0.25, screen.y - sizePx * 0.55, sizePx * 0.12, sizePx * 0.3)
  ctx.fillRect(screen.x + sizePx * 0.05, screen.y - sizePx * 0.5, sizePx * 0.12, sizePx * 0.25)
}

/**
 * Overlays a scaffolding look on top of an already-drawn sprite
 * (DESIGN 9.6's "construction look on opening"): a few diagonal cross
 * braces, fading out as `constructionT` (from `lifecyclePhase()`)
 * approaches 1.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} screen
 * @param {number} sizePx
 * @param {number} constructionT 0 to 1.
 * @returns {void}
 */
function drawConstructionOverlay(ctx, screen, sizePx, constructionT) {
  const alpha = 1 - constructionT
  ctx.strokeStyle = `rgba(156,138,106,${alpha.toFixed(3)})`
  ctx.lineWidth = Math.max(1, sizePx * 0.04)
  const half = sizePx * 0.45
  ctx.beginPath()
  ctx.moveTo(screen.x - half, screen.y - half)
  ctx.lineTo(screen.x + half, screen.y + half)
  ctx.moveTo(screen.x + half, screen.y - half)
  ctx.lineTo(screen.x - half, screen.y + half)
  ctx.stroke()
}

/**
 * Draws one smoke/steam particle (DESIGN 9.6's "smoke or steam
 * particles scaled by utilisation"): a soft circle that rises and
 * fades per `particleState()`.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} origin Screen position the particle rises from.
 * @param {{riseMiles: number, alpha: number, driftMiles: number}} state
 * @param {number} ppm
 * @param {number} particleSizeMiles
 * @returns {void}
 */
function drawSmokeParticle(ctx, origin, state, ppm, particleSizeMiles) {
  if (state.alpha <= 0) return
  const x = origin.x + state.driftMiles * ppm
  const y = origin.y - state.riseMiles * ppm
  const radius = particleSizeMiles * ppm * (0.6 + state.riseMiles)
  ctx.fillStyle = `rgba(222,222,222,${(state.alpha * 0.6).toFixed(3)})`
  ctx.beginPath()
  ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2)
  ctx.fill()
}

/**
 * Draws one industry: its category sprite (tinted toward
 * `industriesRules.derelictColour` once derelict), a construction
 * overlay while newly opened, and however many smoke particles its
 * current utilisation and remaining share of the global particle
 * budget allow.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('../sim/state.js').Industry} options.industry
 * @param {{x: number, y: number}} options.screen
 * @param {number} options.sizePx
 * @param {number} options.gameDay
 * @param {number} options.nowMs
 * @param {number} options.ppm
 * @param {object} options.industriesRules `palette.json`'s `industries` block.
 * @param {{r: number, g: number, b: number}} options.glowColour Pre-parsed `furnaceGlowColour`.
 * @param {{remaining: number}} options.particleBudget Mutated in place: decremented by however many particles this call draws.
 * @returns {void}
 */
function drawOneIndustry({ ctx, industry, screen, sizePx, gameDay, nowMs, ppm, industriesRules, glowColour, particleBudget }) {
  const category = spriteCategoryFor(industry.typeId, industriesRules)
  const lifecycle = lifecyclePhase(industry, gameDay, industriesRules)
  const baseColour = industryColour(industry.typeId, industriesRules)
  const derelictColour = hexToRgb(industriesRules.derelictColour)
  const colour = lifecycle.phase === 'derelict' ? lerpRgb(baseColour, derelictColour, lifecycle.derelictT) : baseColour

  switch (category) {
    case 'mine': drawMineSprite(ctx, screen, sizePx, colour); break
    case 'forestry': drawForestrySprite(ctx, screen, sizePx, colour); break
    case 'fishery': drawFisherySprite(ctx, screen, sizePx, colour); break
    case 'watermill': drawWatermillSprite(ctx, screen, sizePx, colour, wheelAngle(industry, lifecycle, nowMs, industriesRules)); break
    case 'furnace': drawFurnaceSprite(ctx, screen, sizePx, colour, furnaceGlowIntensity(industry, lifecycle, nowMs, industriesRules), glowColour); break
    case 'shipyard': drawShipyardSprite(ctx, screen, sizePx, colour); break
    default: drawFactorySprite(ctx, screen, sizePx, colour); break
  }

  if (lifecycle.phase === 'construction') {
    drawConstructionOverlay(ctx, screen, sizePx, lifecycle.constructionT)
  }

  const desiredParticles = particleCountFor(industry, category, lifecycle, industriesRules)
  const particlesToDraw = Math.min(desiredParticles, particleBudget.remaining)
  const smokeOrigin = { x: screen.x, y: screen.y - sizePx * 0.5 }
  for (let slot = 0; slot < particlesToDraw; slot++) {
    const state = particleState(industry.id, slot, nowMs, industriesRules)
    drawSmokeParticle(ctx, smokeOrigin, state, ppm, industriesRules.particleSizeMiles)
  }
  particleBudget.remaining -= particlesToDraw
}

/**
 * Draws every industry on the dynamic canvas layer (DESIGN 9.3),
 * hidden below `industriesRules.minPpm` (DESIGN 9.2's band table: no
 * industries at Region zoom, "regional industries" from Area up).
 * Each industry is one billboarded icon at a fixed world-mile size
 * (the T2.00 spike's own convention for small objects, since a true
 * building footprint would be sub-pixel at low zoom) — unlike
 * `settlements.js`'s settlements, there is no footprint or population
 * to grow into, so there is nothing resembling a zoom band split here.
 * Smoke particles are capped by a single shared budget across every
 * industry on screen (PHASES.md T2.08's own Done-when: "animation
 * cost is capped by a particle budget"), spent in array order so a
 * view with more industries than the budget allows simply stops
 * adding smoke past that point rather than drawing fewer particles per
 * industry everywhere. Does not clear the canvas — the caller owns
 * that, same convention as `drawNetworkLayer()`/`drawSettlementsLayer()`.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {import('../sim/state.js').Industry[]} options.industries
 * @param {object} options.industriesRules `palette.json`'s `industries` block.
 * @param {number} options.gameDay The sim's current day.
 * @param {number} options.nowMs The render loop's own frame timestamp.
 * @returns {void}
 */
export function drawIndustriesLayer({ ctx, camera, viewport, projection, industries, industriesRules, gameDay, nowMs }) {
  if (camera.ppm < industriesRules.minPpm) return

  const glowColour = hexToRgb(industriesRules.furnaceGlowColour)
  const sizePx = industriesRules.spriteSizeMiles * camera.ppm
  const particleBudget = { remaining: industriesRules.particleBudget }

  for (const industry of industries) {
    const screen = projection.worldToScreen(camera, viewport, { x: industry.x, y: industry.y })
    drawOneIndustry({ ctx, industry, screen, sizePx, gameDay, nowMs, ppm: camera.ppm, industriesRules, glowColour, particleBudget })
  }
}
