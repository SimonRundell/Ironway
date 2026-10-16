import { describe, expect, it } from 'vitest'
import { createWorldGrid, indexOf } from './grid.js'
import { generateSlope } from './slope.js'

const METRES_PER_MILE = 1609.344

describe('generateSlope', () => {
  it('is zero everywhere on flat terrain', () => {
    const grid = createWorldGrid(6, 6, 2)
    grid.elev.fill(100)

    generateSlope(grid, { quantizationScale: 100 })

    expect([...grid.slope].every((v) => v === 0)).toBe(true)
  })

  it('matches a hand-calculated value on a uniform east-west ramp', () => {
    // Each cell 2 miles wide, elevation rises by 100m per cell: a
    // uniform slope of 100m per 2 miles = 50 m/mile, independent of x.
    const width = 6
    const height = 3
    const cellMiles = 2
    const grid = createWorldGrid(width, height, cellMiles)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        grid.elev[indexOf(grid, x, y)] = x * 100
      }
    }

    generateSlope(grid, { quantizationScale: 100 })

    const expectedRatio = 50 / METRES_PER_MILE
    const expectedByte = Math.floor(expectedRatio * 100 + 0.5)

    // Interior columns use the central-difference formula and should
    // all match exactly; edge columns use a one-sided difference but
    // give the same ratio on a perfectly uniform ramp.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        expect(grid.slope[indexOf(grid, x, y)]).toBe(expectedByte)
      }
    }
  })

  it('gives a steeper ramp a larger slope value than a gentler one', () => {
    const makeRamp = (stepMetres) => {
      const grid = createWorldGrid(6, 3, 2)
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          grid.elev[indexOf(grid, x, y)] = x * stepMetres
        }
      }
      generateSlope(grid, { quantizationScale: 100 })
      return grid.slope[indexOf(grid, 3, 1)]
    }

    expect(makeRamp(200)).toBeGreaterThan(makeRamp(20))
  })

  it('never produces a value outside the Uint8 range, even on sharp terrain', () => {
    const grid = createWorldGrid(5, 5, 2)
    // Alternate very high and very low elevations: the sharpest
    // possible gradient the Int16 range allows.
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        grid.elev[indexOf(grid, x, y)] = (x + y) % 2 === 0 ? 1300 : -200
      }
    }

    generateSlope(grid, { quantizationScale: 100 })

    for (const value of grid.slope) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(255)
    }
  })

  it('uses a one-sided difference at the grid edges without crashing', () => {
    const grid = createWorldGrid(4, 4, 2)
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        grid.elev[indexOf(grid, x, y)] = x * 50 + y * 30
      }
    }

    expect(() => generateSlope(grid, { quantizationScale: 100 })).not.toThrow()
    for (const value of grid.slope) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})
