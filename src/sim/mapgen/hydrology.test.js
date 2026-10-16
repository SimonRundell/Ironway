import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createWorldGrid } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology, riverWidthClass } from './hydrology.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules
const cache = new Map()

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
})

/**
 * Runs the island, rain and hydrology steps for a seed and returns the
 * grid plus hydrology's flow-direction tree. Memoised per seed since
 * several `it.each` blocks check different properties of the same 20
 * generated islands.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object, flowTo: Int32Array, filled: Int32Array}}
 */
function generate(seed) {
  if (cache.has(seed)) {
    return cache.get(seed)
  }

  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  generateIsland(grid, seed, mapgenRules)
  generateRain(grid, mapgenRules.climate)
  const { flowTo, filled } = generateHydrology(grid, mapgenRules.hydrology)

  const result = { grid, flowTo, filled }
  cache.set(seed, result)
  return result
}

/**
 * Follows a cell's flow-direction chain until it reaches the sea or a
 * lake, or gives up after a generous step budget.
 *
 * @param {object} grid The world grid.
 * @param {Int32Array} flowTo From generateHydrology().
 * @param {number} start Starting cell index.
 * @returns {{reachedWater: boolean, steps: number}}
 */
function traceToWater(grid, flowTo, start) {
  let current = start
  let steps = 0
  const limit = grid.width * grid.height + 10

  while (steps < limit) {
    const next = flowTo[current]
    if (next === -1) {
      return { reachedWater: true, steps } // sea (the only cells with no downstream)
    }
    if (grid.water[next] === 1 || grid.water[next] === 2) {
      return { reachedWater: true, steps: steps + 1 }
    }
    current = next
    steps++
  }

  return { reachedWater: false, steps }
}

describe('generateHydrology property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: every river cell drains to sea or lake', (seed) => {
    const { grid, flowTo } = generate(seed)

    for (let i = 0; i < grid.river.length; i++) {
      if (grid.river[i] === 0) continue
      const { reachedWater } = traceToWater(grid, flowTo, i)
      expect(reachedWater).toBe(true)
    }
  })

  it.each(SEEDS)('%s: no river flows uphill after filling', (seed) => {
    const { grid, flowTo, filled } = generate(seed)

    for (let i = 0; i < grid.river.length; i++) {
      if (grid.river[i] === 0) continue

      let current = i
      let steps = 0
      const limit = grid.width * grid.height + 10

      while (steps < limit) {
        const next = flowTo[current]
        if (next === -1) break
        expect(filled[next]).toBeLessThanOrEqual(filled[current])
        if (grid.water[next] === 1 || grid.water[next] === 2) break
        current = next
        steps++
      }
    }
  })

  it.each(SEEDS)('%s: at least 3 rivers are over 100 miles long', (seed) => {
    const { grid, flowTo } = generate(seed)
    const cellMiles = mapgenRules.grid.cellMiles

    // A river source is a river cell with no upstream river-classified neighbour.
    const hasUpstreamRiver = new Uint8Array(grid.width * grid.height)
    for (let i = 0; i < flowTo.length; i++) {
      if (grid.river[i] > 0 && flowTo[i] !== -1 && grid.river[flowTo[i]] > 0) {
        hasUpstreamRiver[flowTo[i]] = 1
      }
    }

    let longRivers = 0
    for (let i = 0; i < flowTo.length; i++) {
      if (grid.river[i] === 0 || hasUpstreamRiver[i]) continue

      let current = i
      let lengthMiles = 0
      let steps = 0
      const limit = grid.width * grid.height + 10

      while (steps < limit) {
        const next = flowTo[current]
        if (next === -1) break
        const x1 = current % grid.width
        const y1 = Math.floor(current / grid.width)
        const x2 = next % grid.width
        const y2 = Math.floor(next / grid.width)
        const diagonal = x1 !== x2 && y1 !== y2
        lengthMiles += diagonal ? cellMiles * Math.SQRT2 : cellMiles
        if (grid.water[next] === 1) break
        current = next
        steps++
      }

      if (lengthMiles >= 100) longRivers++
    }

    expect(longRivers).toBeGreaterThanOrEqual(3)
  })
})

describe('riverWidthClass', () => {
  it('is 0 below the threshold', () => {
    expect(riverWidthClass(199, 200)).toBe(0)
  })

  it('is 1 exactly at the threshold', () => {
    expect(riverWidthClass(200, 200)).toBe(1)
  })

  it('doubles the width class roughly every doubling of flow', () => {
    expect(riverWidthClass(200, 200)).toBe(1)
    expect(riverWidthClass(400, 200)).toBe(2)
    expect(riverWidthClass(800, 200)).toBe(3)
    expect(riverWidthClass(1600, 200)).toBe(4)
    expect(riverWidthClass(3200, 200)).toBe(5)
  })

  it('never exceeds width class 5', () => {
    expect(riverWidthClass(1000000, 200)).toBe(5)
  })
})

describe('generateHydrology lake detection (synthetic grid)', () => {
  it('marks a deep depression as a lake and raises it to the fill level', () => {
    // 5x5 grid: sea border, a rim at 50m, a 1-cell pit at 0m in the
    // middle. Filling must raise the pit to 50m (fillAmount 50),
    // which exceeds a lakeDepth of 10.
    const width = 5
    const height = 5
    const grid = createWorldGrid(width, height, 2)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const onEdge = x === 0 || x === width - 1 || y === 0 || y === height - 1
        if (onEdge) {
          grid.water[i] = 1
          grid.elev[i] = -5
        } else if (x === 2 && y === 2) {
          grid.water[i] = 0
          grid.elev[i] = 1 // the pit
        } else {
          grid.water[i] = 0
          grid.elev[i] = 50 // the rim
        }
      }
    }

    grid.rain.fill(50)

    generateHydrology(grid, { riverThreshold: 999999, lakeDepth: 10, flowScaleDivisor: 1 })

    const pitIndex = 2 * width + 2
    expect(grid.water[pitIndex]).toBe(2)
    expect(grid.elev[pitIndex]).toBe(50)
  })

  it('leaves a shallow depression as ordinary land', () => {
    // Same shape, but the pit is only 5m below the rim: fillAmount 5,
    // which does not exceed a lakeDepth of 10.
    const width = 5
    const height = 5
    const grid = createWorldGrid(width, height, 2)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const onEdge = x === 0 || x === width - 1 || y === 0 || y === height - 1
        if (onEdge) {
          grid.water[i] = 1
          grid.elev[i] = -5
        } else if (x === 2 && y === 2) {
          grid.water[i] = 0
          grid.elev[i] = 45
        } else {
          grid.water[i] = 0
          grid.elev[i] = 50
        }
      }
    }

    grid.rain.fill(50)

    generateHydrology(grid, { riverThreshold: 999999, lakeDepth: 10, flowScaleDivisor: 1 })

    const pitIndex = 2 * width + 2
    expect(grid.water[pitIndex]).toBe(0)
  })
})
