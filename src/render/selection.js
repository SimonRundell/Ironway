import { findNearestLink } from './network.js'

/**
 * Settlement and industry hit testing (PHASES.md T2.12), the same
 * flat-threshold convention `network.js`'s own `findNearestLink()`
 * already established for links: pure world-space geometry, the caller
 * converts a screen point to world space with `projection.screenToWorld()`
 * first. `findNearestEntity()` combines all three entity types into one
 * click-to-select result for `MapView`'s pointer handling.
 *
 * @module render/selection
 */

/** @type {number} Default hit radius for a settlement, in world miles — generous enough to cover a capital's largest Region-band blob without needing to replicate the exact per-zoom visual radius `render/settlements.js` computes. */
export const SETTLEMENT_HIT_RADIUS_MILES = 3
/** @type {number} Default hit radius for an industry, in world miles — an industry sprite is small and fixed-size at every zoom band it's visible in (DESIGN 9.6), so a small flat radius matches it closely. */
export const INDUSTRY_HIT_RADIUS_MILES = 1
/** @type {number} Default hit radius for a link, in world miles, matching T2.06's own click-to-select distance. */
export const LINK_HIT_RADIUS_MILES = 1.5

/**
 * @param {import('../sim/state.js').Settlement[]} settlements
 * @param {{x: number, y: number}} worldPoint
 * @param {number} maxDistanceMiles
 * @returns {{settlement: import('../sim/state.js').Settlement, distanceMiles: number}|null}
 */
export function findNearestSettlement(settlements, worldPoint, maxDistanceMiles) {
  let best = null
  for (const settlement of settlements) {
    const distanceMiles = Math.hypot(worldPoint.x - settlement.x, worldPoint.y - settlement.y)
    if (distanceMiles > maxDistanceMiles) continue
    if (!best || distanceMiles < best.distanceMiles) best = { settlement, distanceMiles }
  }
  return best
}

/**
 * @param {import('../sim/state.js').Industry[]} industries
 * @param {{x: number, y: number}} worldPoint
 * @param {number} maxDistanceMiles
 * @returns {{industry: import('../sim/state.js').Industry, distanceMiles: number}|null}
 */
export function findNearestIndustry(industries, worldPoint, maxDistanceMiles) {
  let best = null
  for (const industry of industries) {
    const distanceMiles = Math.hypot(worldPoint.x - industry.x, worldPoint.y - industry.y)
    if (distanceMiles > maxDistanceMiles) continue
    if (!best || distanceMiles < best.distanceMiles) best = { industry, distanceMiles }
  }
  return best
}

/**
 * Picks the single closest hit across settlements, industries and
 * links, each tested against its own hit radius — whichever entity's
 * own match comes back with the smallest `distanceMiles` wins, so a
 * tap near an industry sited right next to its home settlement
 * correctly favours the industry if the click lands closer to it.
 *
 * @param {object} options
 * @param {import('../sim/state.js').Settlement[]} [options.settlements]
 * @param {import('../sim/state.js').Industry[]} [options.industries]
 * @param {import('../sim/state.js').Link[]} [options.links]
 * @param {{x: number, y: number}} options.worldPoint
 * @returns {{type: 'settlement', id: number}|{type: 'industry', id: number}|{type: 'link', id: number}|null}
 */
export function findNearestEntity({ settlements, industries, links, worldPoint }) {
  const candidates = []

  if (settlements) {
    const hit = findNearestSettlement(settlements, worldPoint, SETTLEMENT_HIT_RADIUS_MILES)
    if (hit) candidates.push({ type: 'settlement', id: hit.settlement.id, distanceMiles: hit.distanceMiles })
  }
  if (industries) {
    const hit = findNearestIndustry(industries, worldPoint, INDUSTRY_HIT_RADIUS_MILES)
    if (hit) candidates.push({ type: 'industry', id: hit.industry.id, distanceMiles: hit.distanceMiles })
  }
  if (links) {
    const hit = findNearestLink(links, worldPoint, LINK_HIT_RADIUS_MILES)
    if (hit) candidates.push({ type: 'link', id: hit.link.id, distanceMiles: hit.distanceMiles })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.distanceMiles - b.distanceMiles)
  return { type: candidates[0].type, id: candidates[0].id }
}
