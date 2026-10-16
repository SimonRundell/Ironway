/**
 * The world layer container: a fixed-size grid of typed-array layers,
 * per DESIGN.md 5.1. One grid is shared and progressively filled in by
 * every map generation step (island, hydrology, coast, climate, soil,
 * resources). World coordinates are in miles, origin top-left, x east,
 * y south; grid coordinates are in cells.
 *
 * @module sim/mapgen/grid
 */

/** @type {readonly [number, number][]} The 4 orthogonal neighbour offsets. */
const OFFSETS_4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

/** @type {readonly [number, number][]} All 8 neighbour offsets. */
const OFFSETS_8 = Object.freeze([
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
])

/**
 * Creates a world grid with every layer from DESIGN 5.1 pre-allocated
 * and zeroed. Not every generation step fills every layer immediately;
 * layers are populated progressively by later tasks (hydrology, coast,
 * soil, resources, settlements).
 *
 * @param {number} width Grid width in cells.
 * @param {number} height Grid height in cells.
 * @param {number} cellMiles Length of one cell's side, in miles.
 * @returns {object} The world grid.
 */
export function createWorldGrid(width, height, cellMiles) {
  const size = width * height

  return {
    width,
    height,
    cellMiles,
    elev: new Int16Array(size),
    water: new Uint8Array(size),
    flow: new Uint16Array(size),
    river: new Uint8Array(size),
    rain: new Uint8Array(size),
    soil: new Uint8Array(size),
    arable: new Uint8Array(size),
    pastoral: new Uint8Array(size),
    landuse: new Uint8Array(size),
    slope: new Uint8Array(size),
    coast: new Uint8Array(size),
    shelter: new Uint8Array(size),
    resource: new Uint8Array(size),
    richness: new Uint8Array(size),
    region: new Uint8Array(size),
  }
}

/**
 * Converts grid coordinates to a flat layer index.
 *
 * @param {{width: number}} grid The world grid (or anything with a `width`).
 * @param {number} x Grid x coordinate.
 * @param {number} y Grid y coordinate.
 * @returns {number} The index into any layer array.
 */
export function indexOf(grid, x, y) {
  return y * grid.width + x
}

/**
 * Checks whether grid coordinates fall inside the grid.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {number} x Grid x coordinate.
 * @param {number} y Grid y coordinate.
 * @returns {boolean} True if (x, y) is a valid cell.
 */
export function isInBounds(grid, x, y) {
  return x >= 0 && x < grid.width && y >= 0 && y < grid.height
}

/**
 * Lists the in-bounds orthogonal (4-connected) neighbours of a cell.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {number} x Grid x coordinate.
 * @param {number} y Grid y coordinate.
 * @returns {[number, number][]} Neighbour [x, y] pairs, 0 to 4 of them.
 */
export function neighbours4(grid, x, y) {
  const result = []
  for (const [dx, dy] of OFFSETS_4) {
    const nx = x + dx
    const ny = y + dy
    if (isInBounds(grid, nx, ny)) {
      result.push([nx, ny])
    }
  }
  return result
}

/**
 * Lists the in-bounds 8-connected neighbours of a cell.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {number} x Grid x coordinate.
 * @param {number} y Grid y coordinate.
 * @returns {[number, number][]} Neighbour [x, y] pairs, 0 to 8 of them.
 */
export function neighbours8(grid, x, y) {
  const result = []
  for (const [dx, dy] of OFFSETS_8) {
    const nx = x + dx
    const ny = y + dy
    if (isInBounds(grid, nx, ny)) {
      result.push([nx, ny])
    }
  }
  return result
}
