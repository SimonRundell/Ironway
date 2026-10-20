import { computeDistanceFromSources } from '../../sim/mapgen/grid.js'
import { COAST_FLAG } from '../../sim/mapgen/coast.js'

/**
 * Builds the two fields `sampleTerrain.js` needs to draw rivers as
 * smooth variable-width curves (DESIGN 9.4) without ever tracing an
 * explicit flow-path polyline: a distance-to-nearest-river-cell field
 * and a per-cell half-width field, both bilinear-sampled at render
 * time the same way `coastlineSdf.js`'s SDF is. A pixel is "river" when
 * its sampled distance is less than its sampled half-width; because
 * both fields are continuous, the boundary is naturally antialiased
 * and the width tapers smoothly rather than stepping between river and
 * bank. `flowTo` (the actual drainage graph, used to build `river` and
 * `flow` in hydrology.js) is not part of the packed save blob, so an
 * explicit path trace is not available here regardless — this distance
 * field approach needs only `grid.river` and `grid.coast`, which are.
 *
 * @module render/terrain/riverField
 */

/**
 * @param {object} grid A fully generated world grid (river, coast, cellMiles, width, height).
 * @param {{milesPerClass: number, estuaryBoost: number}} riverWidthRules palette.json's `riverWidth` block.
 * @returns {{riverDistance: Float32Array, riverHalfWidth: Float32Array}}
 *   Both in world miles, one value per cell. `riverDistance` is 0 at a
 *   river cell itself, increasing with distance from the nearest one.
 *   `riverHalfWidth` is 0 away from rivers; at a river cell it is half
 *   that cell's width class scaled to miles, boosted where the coast
 *   layer flags the cell as an estuary (DESIGN's "estuaries widening
 *   toward the sea") — the boost itself only reaches the handful of
 *   cells right at a river mouth, but bilinear sampling of the field
 *   spreads that into a short, smooth widening over the neighbouring
 *   cells rather than a step.
 */
export function buildRiverFields(grid, riverWidthRules) {
  const { width, height, cellMiles, river, coast } = grid
  const size = width * height

  const riverDistance = computeDistanceFromSources(grid, (i) => river[i] > 0)
  const riverDistanceMiles = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    riverDistanceMiles[i] = riverDistance[i] * cellMiles
  }

  const riverHalfWidth = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    if (river[i] <= 0) continue
    const isEstuary = (coast[i] & COAST_FLAG.ESTUARY) !== 0
    const widthMiles = river[i] * riverWidthRules.milesPerClass * (isEstuary ? riverWidthRules.estuaryBoost : 1)
    riverHalfWidth[i] = widthMiles / 2
  }

  return { riverDistance: riverDistanceMiles, riverHalfWidth }
}
