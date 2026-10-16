/**
 * Carves rivers and lakes into the generated terrain: priority-flood
 * depression filling (so every land cell has a drainage path to the
 * sea), D8 flow directions, rain-weighted flow accumulation, river
 * width classes and lake detection. DESIGN.md 5.2 step 7. Purely
 * derived from elevation, water and rain; no randomness, so no seed is
 * needed.
 *
 * @module sim/mapgen/hydrology
 */

import { indexOf, isInBounds } from './grid.js'

/** @type {readonly [number, number][]} The 8 D8 drainage directions. */
const NEIGHBOUR_OFFSETS_8 = Object.freeze([
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
])

/**
 * A small binary min-heap of (priority, cellIndex) pairs, used to pop
 * cells in increasing filled-elevation order during the priority-flood
 * pass. Not exported: an internal detail of this module.
 */
class MinHeap {
  constructor() {
    /** @type {[number, number][]} */
    this.items = []
  }

  get size() {
    return this.items.length
  }

  /**
   * @param {number} priority Sort key (filled elevation).
   * @param {number} index Cell index.
   * @returns {void}
   */
  push(priority, index) {
    this.items.push([priority, index])
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.items[parent][0] <= this.items[i][0]) break
      ;[this.items[parent], this.items[i]] = [this.items[i], this.items[parent]]
      i = parent
    }
  }

  /**
   * @returns {[number, number]} The (priority, cellIndex) pair with the lowest priority.
   */
  pop() {
    const top = this.items[0]
    const last = this.items.pop()
    if (this.items.length > 0) {
      this.items[0] = last
      let i = 0
      const n = this.items.length
      for (;;) {
        let smallest = i
        const left = 2 * i + 1
        const right = 2 * i + 2
        if (left < n && this.items[left][0] < this.items[smallest][0]) smallest = left
        if (right < n && this.items[right][0] < this.items[smallest][0]) smallest = right
        if (smallest === i) break
        ;[this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]]
        i = smallest
      }
    }
    return top
  }
}

/**
 * Clamps a value to the Int16 elevation range.
 *
 * @param {number} value The value to clamp.
 * @returns {number} An integer in [-32768, 32767].
 */
function clampInt16(value) {
  const rounded = Math.floor(value + 0.5)
  if (rounded < -32768) return -32768
  if (rounded > 32767) return 32767
  return rounded
}

/**
 * Counts how many times a positive integer can be halved before
 * reaching 1: an exact `floor(log2(n))` computed with bit shifts only,
 * so river width classes never depend on a floating-point `Math.log2`
 * (not in DESIGN 4.5's exact-arithmetic whitelist).
 *
 * @param {number} n A positive integer.
 * @returns {number} floor(log2(n)).
 */
function integerLog2(n) {
  let bits = 0
  let v = n
  while (v > 1) {
    v = v >>> 1
    bits++
  }
  return bits
}

/**
 * Runs priority-flood depression filling and D8 flow-direction
 * assignment in one combined pass. Seeds the fill from every sea cell
 * (the only true sinks) and repeatedly pops the lowest-filled
 * undecided cell, relaxing its land neighbours. Because a neighbour is
 * only ever relaxed once (by whichever cell pops first), the resulting
 * `flowTo` graph is a cycle-free tree rooted at the sea: every land
 * cell's downstream neighbour is strictly earlier in `fillOrder`, so
 * reversing `fillOrder` later gives a correct upstream-before-
 * downstream processing order for flow accumulation, including inside
 * the flat surface of a filled depression (a lake), where several
 * cells can share the same filled elevation.
 *
 * @param {{width: number, height: number, elev: Int16Array, water: Uint8Array}} grid The world grid.
 * @returns {{filled: Int32Array, flowTo: Int32Array, fillOrder: number[]}}
 *   `filled`: elevation after depression filling, one per cell.
 *   `flowTo`: index of the cell each cell drains into, or -1 (only for
 *   sea cells, which are never relaxed).
 *   `fillOrder`: cell indices in the order the flood-fill finalised them.
 */
function computeFillAndFlow(grid) {
  const { width, height, elev, water } = grid
  const size = width * height
  const filled = new Int32Array(size)
  const flowTo = new Int32Array(size).fill(-1)
  const queued = new Uint8Array(size)
  const fillOrder = []
  const heap = new MinHeap()

  for (let i = 0; i < size; i++) {
    if (water[i] === 1) {
      filled[i] = elev[i]
      queued[i] = 1
      heap.push(elev[i], i)
    }
  }

  while (heap.size > 0) {
    const [, i] = heap.pop()
    fillOrder.push(i)

    const x = i % width
    const y = Math.floor(i / width)

    for (const [dx, dy] of NEIGHBOUR_OFFSETS_8) {
      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(grid, nx, ny)) continue

      const ni = indexOf(grid, nx, ny)
      if (queued[ni] || water[ni] === 1) continue

      filled[ni] = Math.max(elev[ni], filled[i])
      flowTo[ni] = i
      queued[ni] = 1
      heap.push(filled[ni], ni)
    }
  }

  return { filled, flowTo, fillOrder }
}

/**
 * Accumulates rain-weighted flow: each cell collects its own rain plus
 * everything its upstream neighbours collected, passed along the
 * `flowTo` tree. Processes `fillOrder` in reverse so every cell is
 * finalised before the one it drains into is touched, which is exactly
 * correct for this tree (see computeFillAndFlow) regardless of any
 * filled-elevation ties among lake cells.
 *
 * @param {{width: number, height: number, water: Uint8Array, rain: Uint8Array}} grid The world grid.
 * @param {Int32Array} flowTo From computeFillAndFlow().
 * @param {number[]} fillOrder From computeFillAndFlow().
 * @returns {Float64Array} Accumulated rain-weighted flow per cell.
 */
function computeFlowAccumulation(grid, flowTo, fillOrder) {
  const { water, rain } = grid
  const accumulation = new Float64Array(grid.width * grid.height)

  for (let k = fillOrder.length - 1; k >= 0; k--) {
    const i = fillOrder[k]
    if (water[i] === 1) continue // sea cells neither collect rain nor forward it further

    accumulation[i] += rain[i]
    const downstream = flowTo[i]
    if (downstream !== -1) {
      accumulation[downstream] += accumulation[i]
    }
  }

  return accumulation
}

/**
 * Converts a scaled flow value into a 1-5 river width class, using the
 * exact integer log2 of how many multiples of `riverThreshold` the
 * flow reaches.
 *
 * @param {number} flowValue The cell's scaled flow value.
 * @param {number} riverThreshold mapgen.json's hydrology.riverThreshold.
 * @returns {number} 0 (not a river) or 1 to 5 (width class).
 */
export function riverWidthClass(flowValue, riverThreshold) {
  if (flowValue < riverThreshold) {
    return 0
  }

  const ratio = Math.floor(flowValue / riverThreshold)
  const widthClass = integerLog2(ratio) + 1
  if (widthClass < 1) return 1
  if (widthClass > 5) return 5
  return widthClass
}

/**
 * Generates hydrology (step 7): fills depressions so every land cell
 * drains to the sea, marks depressions deeper than `lakeDepth` as
 * lakes (raising their visible elevation to the water surface),
 * accumulates rain-weighted flow, and classifies river cells and their
 * width. Requires climate.generateRain() to have already populated
 * `grid.rain`.
 *
 * @param {object} grid The world grid (water, elev, flow and river are written; rain is read).
 * @param {{riverThreshold: number, lakeDepth: number, flowScaleDivisor: number}} params
 *   mapgen.json's hydrology settings.
 * @returns {{flowTo: Int32Array, filled: Int32Array}} The flow-direction
 *   tree and filled elevation, exposed for tests that need to trace a
 *   cell's drainage path.
 */
export function generateHydrology(grid, params) {
  const { filled, flowTo, fillOrder } = computeFillAndFlow(grid)
  const size = grid.width * grid.height

  for (let i = 0; i < size; i++) {
    if (grid.water[i] !== 0) continue // only original land can become a lake

    const fillAmount = filled[i] - grid.elev[i]
    if (fillAmount > params.lakeDepth) {
      grid.water[i] = 2
      grid.elev[i] = clampInt16(filled[i])
    }
  }

  const accumulation = computeFlowAccumulation(grid, flowTo, fillOrder)

  for (let i = 0; i < size; i++) {
    if (grid.water[i] === 1) continue // sea: no flow or river values needed

    const scaled = Math.min(65535, Math.floor(accumulation[i] / params.flowScaleDivisor))
    grid.flow[i] = scaled

    if (grid.water[i] === 0) {
      grid.river[i] = riverWidthClass(scaled, params.riverThreshold)
    }
  }

  return { flowTo, filled }
}
