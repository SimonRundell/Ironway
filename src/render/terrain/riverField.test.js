import { describe, expect, it } from 'vitest'
import { createWorldGrid, indexOf } from '../../sim/mapgen/grid.js'
import { COAST_FLAG } from '../../sim/mapgen/coast.js'
import { buildRiverFields } from './riverField.js'

const RIVER_WIDTH_RULES = { milesPerClass: 0.1, estuaryBoost: 2 }

/**
 * @param {string[]} rows One character per cell: 'R'1-5 river width class, '.' no river.
 * @returns {object} A grid with `river` set from the pattern (cellMiles = 1, coast all zero).
 */
function gridFromPattern(rows) {
  const height = rows.length
  const width = rows[0].length
  const grid = createWorldGrid(width, height, 1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x]
      grid.river[indexOf(grid, x, y)] = ch === '.' ? 0 : Number(ch)
    }
  }
  return grid
}

describe('buildRiverFields', () => {
  it('is zero distance and a positive half-width exactly at a river cell', () => {
    const grid = gridFromPattern([
      '.....',
      '.....',
      '..3..',
      '.....',
      '.....',
    ])
    const { riverDistance, riverHalfWidth } = buildRiverFields(grid, RIVER_WIDTH_RULES)
    const riverIndex = indexOf(grid, 2, 2)
    expect(riverDistance[riverIndex]).toBe(0)
    expect(riverHalfWidth[riverIndex]).toBeCloseTo((3 * RIVER_WIDTH_RULES.milesPerClass) / 2)
  })

  it('is zero half-width away from any river', () => {
    const grid = gridFromPattern(['.....', '.....', '..3..', '.....', '.....'])
    const { riverHalfWidth } = buildRiverFields(grid, RIVER_WIDTH_RULES)
    expect(riverHalfWidth[indexOf(grid, 0, 0)]).toBe(0)
  })

  it('distance increases away from the river, scaled by cellMiles', () => {
    const grid = gridFromPattern(['.....', '.....', '..3..', '.....', '.....'])
    grid.cellMiles = 2
    const { riverDistance } = buildRiverFields(grid, RIVER_WIDTH_RULES)
    const near = riverDistance[indexOf(grid, 1, 2)]
    const far = riverDistance[indexOf(grid, 0, 2)]
    expect(near).toBeGreaterThan(0)
    expect(far).toBeGreaterThan(near)
    expect(near).toBe(1 * grid.cellMiles)
  })

  it('boosts half-width at an estuary-flagged cell, but not at a plain river cell of the same class', () => {
    const grid = gridFromPattern(['...', '.3.', '...'])
    const estuaryIndex = indexOf(grid, 1, 1)
    grid.coast[estuaryIndex] = COAST_FLAG.ESTUARY
    const { riverHalfWidth } = buildRiverFields(grid, RIVER_WIDTH_RULES)

    const plainGrid = gridFromPattern(['...', '.3.', '...'])
    const { riverHalfWidth: plainHalfWidth } = buildRiverFields(plainGrid, RIVER_WIDTH_RULES)

    expect(riverHalfWidth[estuaryIndex]).toBeCloseTo(plainHalfWidth[estuaryIndex] * RIVER_WIDTH_RULES.estuaryBoost)
  })

  it('higher width classes produce a larger half-width', () => {
    const smallGrid = gridFromPattern(['...', '.1.', '...'])
    const bigGrid = gridFromPattern(['...', '.5.', '...'])
    const small = buildRiverFields(smallGrid, RIVER_WIDTH_RULES)
    const big = buildRiverFields(bigGrid, RIVER_WIDTH_RULES)
    const i = indexOf(smallGrid, 1, 1)
    expect(big.riverHalfWidth[i]).toBeGreaterThan(small.riverHalfWidth[i])
  })

  it('is deterministic', () => {
    const rows = ['.....', '..2..', '..2..', '..2..', '.....']
    const a = buildRiverFields(gridFromPattern(rows), RIVER_WIDTH_RULES)
    const b = buildRiverFields(gridFromPattern(rows), RIVER_WIDTH_RULES)
    expect(Array.from(a.riverDistance)).toEqual(Array.from(b.riverDistance))
    expect(Array.from(a.riverHalfWidth)).toEqual(Array.from(b.riverHalfWidth))
  })
})
