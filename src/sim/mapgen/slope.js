/**
 * Computes the quantised slope layer from the elevation gradient.
 * DESIGN.md 5.2 step 8. Pure function of elevation; no seed needed.
 *
 * @module sim/mapgen/slope
 */

import { clampByte, indexOf } from './grid.js'

/** Metres per mile, for converting a metres-per-mile gradient to a dimensionless rise/run ratio. */
const METRES_PER_MILE = 1609.344

/**
 * Generates the slope layer (step 8): the elevation gradient magnitude
 * (central differences, one-sided at the grid edges) converted to a
 * dimensionless rise/run ratio and quantised into a byte. Deliberately
 * stores a ratio rather than an angle in degrees, since converting a
 * ratio to an angle needs `Math.atan`, which is outside DESIGN 4.5's
 * exact-arithmetic whitelist; thresholds that compare against this
 * layer (e.g. mapgen.json soil.rockSlopeRatio) are themselves
 * precomputed ratios for the same reason.
 *
 * @param {{width: number, height: number, elev: Int16Array, cellMiles: number, slope: Uint8Array}} grid The world grid.
 * @param {{quantizationScale: number}} params mapgen.json's slope settings.
 * @returns {void}
 */
export function generateSlope(grid, params) {
  const { width, height, elev, cellMiles, slope } = grid

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)

      let dzdx
      if (x === 0) {
        dzdx = (elev[indexOf(grid, x + 1, y)] - elev[i]) / cellMiles
      } else if (x === width - 1) {
        dzdx = (elev[i] - elev[indexOf(grid, x - 1, y)]) / cellMiles
      } else {
        dzdx = (elev[indexOf(grid, x + 1, y)] - elev[indexOf(grid, x - 1, y)]) / (2 * cellMiles)
      }

      let dzdy
      if (y === 0) {
        dzdy = (elev[indexOf(grid, x, y + 1)] - elev[i]) / cellMiles
      } else if (y === height - 1) {
        dzdy = (elev[i] - elev[indexOf(grid, x, y - 1)]) / cellMiles
      } else {
        dzdy = (elev[indexOf(grid, x, y + 1)] - elev[indexOf(grid, x, y - 1)]) / (2 * cellMiles)
      }

      const ratioX = dzdx / METRES_PER_MILE
      const ratioY = dzdy / METRES_PER_MILE
      const ratio = Math.sqrt(ratioX * ratioX + ratioY * ratioY)

      slope[i] = clampByte(ratio * params.quantizationScale)
    }
  }
}
