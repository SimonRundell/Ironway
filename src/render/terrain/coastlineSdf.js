import { computeDistanceFromSources } from '../../sim/mapgen/grid.js'

/**
 * Builds a signed distance field from the world grid's own `water`
 * layer (DESIGN 9.4: "a crisp coastline taken from a signed distance
 * field... so the coast stays sharp at any zoom"). Positive values are
 * land, negative are sea or lake, both in world miles; the zero level
 * set is the coastline itself. Built from `water` rather than a raw
 * elevation threshold because `water` is already the pipeline's own
 * settled land/sea boundary (island.js's erosion and lake fill have
 * already run), so the SDF agrees exactly with what the rest of the
 * generator calls land.
 *
 * Distance is 8-connected step count (`computeDistanceFromSources`'s
 * own metric, already used the same way for shelter and soil), scaled
 * by `cellMiles`. That is a Chebyshev-like approximation rather than
 * true Euclidean distance, but bilinear sampling of the result at
 * render time still gives a smooth, continuous boundary with no
 * cell-aligned stair-stepping, which is the property the renderer
 * actually needs.
 *
 * `computeDistanceFromSources` scores a source cell itself as 0, so a
 * coastal land cell (one step from the nearest sea source) comes back
 * as 1, not 0; subtracting 1 before scaling puts the zero level set
 * exactly on the coastal cells themselves, on both sides, which is
 * what the renderer's land/sea blend expects.
 *
 * @module render/terrain/coastlineSdf
 */

/**
 * @param {{width: number, height: number, cellMiles: number, water: Uint8Array}} grid A fully generated world grid.
 * @returns {Float32Array} One value per cell, in world miles: positive on land, negative at sea/lake, zero at the coastline.
 */
export function buildCoastlineSdf(grid) {
  const { width, height, cellMiles, water } = grid
  const isLand = (i) => water[i] === 0

  const distanceToWater = computeDistanceFromSources(grid, (i) => !isLand(i))
  const distanceToLand = computeDistanceFromSources(grid, isLand)

  const sdf = new Float32Array(width * height)
  for (let i = 0; i < sdf.length; i++) {
    const cells = isLand(i) ? distanceToWater[i] - 1 : -(distanceToLand[i] - 1)
    sdf[i] = cells * cellMiles
  }
  return sdf
}
