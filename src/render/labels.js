import { MIN_PPM } from './camera.js'
import { KIND_RANK } from '../sim/mapgen/links.js'
import { totalPopulation } from './settlements.js'

/**
 * Floating name labels (PHASES.md T2.10, DESIGN 9.7): settlements and
 * industries, haloed for legibility over any terrain colour, laid out
 * by a priority-ordered spatial-grid declutter so labels never
 * overlap, fading in and out by zoom band, sized nearly constant in
 * screen pixels with only a small scale with zoom.
 *
 * River, bay and range labels are DESIGN 9.7's other named things, but
 * none of them have a discrete positioned entity anywhere in the
 * generated world to attach a label to — `world.names.rivers` is
 * always `[]` and `names.bays`/`names.ranges` are bare name strings
 * with no coordinate (see `sim/mapgen/world.js`'s own `buildWorldNames()`
 * comment and DECISIONS.md's T1.12 entry) — and DESIGN itself marks
 * river labels specifically as optional. Scoped out here rather than
 * inventing new mapgen data a rendering task shouldn't be deciding on
 * its own.
 *
 * Pure candidate/priority/layout functions are exported and unit
 * tested on their own; `drawLabelsLayer()` is the one function that
 * touches a `CanvasRenderingContext2D`, browser-verified the same way
 * every other canvas-drawing function in this project is.
 *
 * @module render/labels
 */

/** @type {number} Priority rank given to every industry label — one past the lowest (worst) settlement rank (`hamlet`), so a settlement of any kind always outranks any industry when both are candidates for the same screen space. */
const INDUSTRY_RANK = Object.keys(KIND_RANK).length

/**
 * @param {import('../sim/state.js').Settlement[]} settlements
 * @returns {object[]} One label candidate per settlement.
 */
export function buildSettlementCandidates(settlements) {
  return settlements.map((s) => ({
    key: `s:${s.id}`,
    kind: s.kind,
    x: s.x,
    y: s.y,
    text: s.name,
    rank: KIND_RANK[s.kind] ?? INDUSTRY_RANK,
    weight: totalPopulation(s),
  }))
}

/**
 * @param {import('../sim/state.js').Industry[]} industries
 * @returns {object[]} One label candidate per industry.
 */
export function buildIndustryCandidates(industries) {
  return industries.map((ind) => ({
    key: `i:${ind.id}`,
    kind: 'industry',
    x: ind.x,
    y: ind.y,
    text: ind.name,
    rank: INDUSTRY_RANK,
    weight: ind.capacity,
  }))
}

/**
 * A candidate's placement priority (DESIGN 9.7: "priority by rank then
 * population"): lower is placed first. Settlements rank by
 * `KIND_RANK` (capital highest priority, hamlet lowest), industries
 * all share one rank below every settlement kind; within a rank,
 * higher `weight` (population, or an industry's capacity) goes first.
 *
 * @param {object} candidate From `buildSettlementCandidates()`/`buildIndustryCandidates()`.
 * @returns {number} Lower sorts first.
 */
export function labelPriorityScore(candidate) {
  return candidate.rank * 1e12 - candidate.weight
}

/**
 * @param {string} text
 * @param {number} fontSizePx
 * @param {number} charWidthFactor `palette.json`'s `labels.charWidthFactor` — an average glyph width as a fraction of font size, since there is no canvas to measure real text width with in a pure/unit-tested function.
 * @returns {number} Estimated width, in screen pixels.
 */
export function estimateLabelWidthPx(text, fontSizePx, charWidthFactor) {
  return text.length * fontSizePx * charWidthFactor
}

/**
 * Label font size for the current zoom (DESIGN 9.7: "nearly constant
 * in screen pixels with a small scale with zoom"): a log2 ramp around
 * `refPpm` (the same log-space convention `camera.js`'s own
 * `lerpCamera()` uses for `ppm`, so equal zoom-factor steps change the
 * size by equal amounts in either direction), clamped to a narrow
 * scale range so it never reads as "zooming the text" the way the
 * world itself zooms.
 *
 * @param {number} ppm
 * @param {object} rules `palette.json`'s `labels` block.
 * @returns {number} Font size, in screen pixels.
 */
export function labelFontSizePx(ppm, rules) {
  const rawScale = 1 + Math.log2(ppm / rules.refPpm) * rules.logScaleRate
  const scale = Math.min(rules.maxFontScale, Math.max(rules.minFontScale, rawScale))
  return rules.baseFontSizePx * scale
}

/**
 * @param {object} candidate
 * @param {object} rules `palette.json`'s `labels` block.
 * @returns {number} The `ppm` below which this candidate's kind is never shown at all.
 */
function minPpmFor(candidate, rules) {
  if (candidate.kind === 'industry') return rules.industriesMinPpm
  return rules.minPpmByKind[candidate.kind] ?? Infinity
}

/**
 * @param {object} candidate
 * @param {number} ppm
 * @param {object} rules `palette.json`'s `labels` block.
 * @returns {boolean}
 */
export function isLabelKindVisible(candidate, ppm, rules) {
  return ppm >= minPpmFor(candidate, rules)
}

/**
 * A label's opacity for the current zoom (DESIGN 9.7: "fading in and
 * out as zoom changes"): 0 below its kind's own `minPpm`, ramping to 1
 * over `fadeRangePpmFactor` times that, then flat. A kind whose
 * `minPpm` is at or below the camera's own zoom floor (`MIN_PPM`,
 * DESIGN 9.2) has nowhere lower to fade in from — PHASES.md T2.10's
 * own Done-when ("the capital and cities are always labelled in
 * Region band") means those kinds are simply always at full opacity
 * once visible, never mid-fade.
 *
 * @param {object} candidate
 * @param {number} ppm
 * @param {object} rules `palette.json`'s `labels` block.
 * @returns {number} 0 to 1.
 */
export function labelFadeAlpha(candidate, ppm, rules) {
  const minPpm = minPpmFor(candidate, rules)
  if (minPpm <= MIN_PPM) return ppm >= minPpm ? 1 : 0
  if (ppm < minPpm) return 0
  const fadeEndPpm = minPpm * rules.fadeRangePpmFactor
  if (ppm >= fadeEndPpm) return 1
  return (ppm - minPpm) / (fadeEndPpm - minPpm)
}

/**
 * @param {{x: number, y: number}} screen The candidate's anchor point, in screen pixels.
 * @param {string} text
 * @param {number} fontSizePx
 * @param {object} rules `palette.json`'s `labels` block.
 * @returns {{x: number, y: number, width: number, height: number}} The label's screen-space bounding box, centred horizontally above the anchor.
 */
function boxForCandidate(screen, text, fontSizePx, rules) {
  const width = estimateLabelWidthPx(text, fontSizePx, rules.charWidthFactor)
  const height = fontSizePx
  return {
    x: screen.x - width / 2,
    y: screen.y - rules.anchorOffsetPx - height,
    width,
    height,
  }
}

/**
 * @param {{x: number, y: number, width: number, height: number}} a
 * @param {{x: number, y: number, width: number, height: number}} b
 * @returns {boolean}
 */
function boxesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * Every spatial-grid cell key a box's extent touches (DESIGN 9.7's own
 * "spatial grid declutter"): computed from the box's actual extent,
 * not just its centre, so a label wider or taller than one cell is
 * still registered (and checked against) every cell it really covers.
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} cellSizePx
 * @returns {string[]}
 */
function cellKeysForBox(box, cellSizePx) {
  const minCx = Math.floor(box.x / cellSizePx)
  const maxCx = Math.floor((box.x + box.width) / cellSizePx)
  const minCy = Math.floor(box.y / cellSizePx)
  const maxCy = Math.floor((box.y + box.height) / cellSizePx)
  const keys = []
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) keys.push(`${cx},${cy}`)
  }
  return keys
}

/**
 * Lays out every candidate that is visible at the current zoom and
 * on/near screen, greedily in priority order, skipping any candidate
 * whose label box would overlap one already placed (PHASES.md T2.10's
 * own Done-when: "no overlapping labels"). A spatial grid keyed by
 * screen-pixel cell (not a flat O(n^2) pairwise scan) finds the
 * handful of already-placed boxes actually worth checking. Pure: no
 * canvas, no mutation of `candidates` — the same "pure layout, canvas
 * draws it" split every other render module in this project uses, and
 * what makes the literal Done-when directly unit-testable.
 *
 * @param {object} options
 * @param {object[]} options.candidates From `buildSettlementCandidates()`/`buildIndustryCandidates()`.
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {object} options.rules `palette.json`'s `labels` block.
 * @returns {{text: string, kind: string, screen: {x: number, y: number}, fontSizePx: number, alpha: number}[]} Only the labels that were actually placed.
 */
export function layoutLabels({ candidates, camera, viewport, projection, rules }) {
  const fontSizePx = labelFontSizePx(camera.ppm, rules)
  // Generous enough that a label anchored just off-screen, whose box
  // still reaches onto the visible canvas, isn't culled before that
  // box is ever considered.
  const margin = 200

  const onScreen = []
  for (const candidate of candidates) {
    if (!isLabelKindVisible(candidate, camera.ppm, rules)) continue
    const screen = projection.worldToScreen(camera, viewport, { x: candidate.x, y: candidate.y })
    if (screen.x < -margin || screen.x > viewport.width + margin || screen.y < -margin || screen.y > viewport.height + margin) continue
    onScreen.push({ candidate, screen })
  }
  onScreen.sort((a, b) => labelPriorityScore(a.candidate) - labelPriorityScore(b.candidate))

  const grid = new Map()
  const placed = []

  for (const { candidate, screen } of onScreen) {
    const box = boxForCandidate(screen, candidate.text, fontSizePx, rules)
    const keys = cellKeysForBox(box, rules.cellSizePx)

    let overlaps = false
    const checked = new Set()
    for (const key of keys) {
      const ids = grid.get(key)
      if (!ids) continue
      for (const id of ids) {
        if (checked.has(id)) continue
        checked.add(id)
        if (boxesOverlap(box, placed[id].box)) { overlaps = true; break }
      }
      if (overlaps) break
    }
    if (overlaps) continue

    const id = placed.length
    placed.push({ candidate, screen, box })
    for (const key of keys) {
      let ids = grid.get(key)
      if (!ids) { ids = []; grid.set(key, ids) }
      ids.push(id)
    }
  }

  return placed.map((p) => ({
    text: p.candidate.text,
    kind: p.candidate.kind,
    screen: p.screen,
    fontSizePx,
    alpha: labelFadeAlpha(p.candidate, camera.ppm, rules),
  }))
}

/**
 * Draws every placed label (DESIGN 9.7: "a halo for legibility"): a
 * thick dark stroke behind a light fill, which keeps the text
 * readable over any terrain colour underneath (PHASES.md T2.10's own
 * Done-when: "labels stay legible on all terrain colours") without
 * needing to sample what that colour actually is. Does not clear the
 * canvas — the caller owns that, same convention as every other
 * drawXLayer function in this project. Takes `settlements`/`industries`
 * directly (building their label candidates itself) rather than
 * pre-built candidates, the same convention `drawSettlementsLayer()`/
 * `drawTrafficLayer()` use for their own entity arrays.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {{worldToScreen: Function}} options.projection
 * @param {import('../sim/state.js').Settlement[]} options.settlements
 * @param {import('../sim/state.js').Industry[]} [options.industries] Omit to label settlements only.
 * @param {object} options.rules `palette.json`'s `labels` block.
 * @returns {void}
 */
export function drawLabelsLayer({ ctx, camera, viewport, projection, settlements, industries, rules }) {
  const candidates = [...buildSettlementCandidates(settlements), ...buildIndustryCandidates(industries ?? [])]
  const placed = layoutLabels({ candidates, camera, viewport, projection, rules })

  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.lineJoin = 'round'

  for (const label of placed) {
    if (label.alpha <= 0) continue
    const textY = label.screen.y - rules.anchorOffsetPx
    ctx.font = `${label.fontSizePx}px sans-serif`
    ctx.globalAlpha = label.alpha
    ctx.lineWidth = rules.haloWidthPx
    ctx.strokeStyle = rules.haloColour
    ctx.strokeText(label.text, label.screen.x, textY)
    ctx.fillStyle = rules.textColour
    ctx.fillText(label.text, label.screen.x, textY)
  }
  ctx.globalAlpha = 1
}
