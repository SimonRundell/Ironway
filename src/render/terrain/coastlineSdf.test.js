import { describe, expect, it } from 'vitest'
import { createWorldGrid, indexOf } from '../../sim/mapgen/grid.js'
import { buildCoastlineSdf } from './coastlineSdf.js'

/**
 * @param {string[]} rows One character per cell, 'L' for land, 'S' for sea.
 * @returns {object} A grid with `water` set from the pattern (cellMiles = 1).
 */
function gridFromPattern(rows) {
  const height = rows.length
  const width = rows[0].length
  const grid = createWorldGrid(width, height, 1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      grid.water[indexOf(grid, x, y)] = rows[y][x] === 'S' ? 1 : 0
    }
  }
  return grid
}

describe('buildCoastlineSdf', () => {
  it('is zero only at the coastline, positive on land, negative at sea', () => {
    const grid = gridFromPattern([
      'SSSSS',
      'SSSSS',
      'SSLLS',
      'SSLLS',
      'SSSSS',
    ])
    const sdf = buildCoastlineSdf(grid)

    for (let i = 0; i < sdf.length; i++) {
      if (grid.water[i] === 0) expect(sdf[i]).toBeGreaterThanOrEqual(0)
      else expect(sdf[i]).toBeLessThanOrEqual(0)
    }
    // Every land cell here touches sea diagonally or orthogonally, so
    // the whole little island is coastline (distance 0).
    for (let i = 0; i < sdf.length; i++) {
      if (grid.water[i] === 0) expect(sdf[i]).toBe(0)
    }
  })

  it('increases in magnitude with distance from the coast, scaled by cellMiles', () => {
    const rows = []
    for (let y = 0; y < 9; y++) rows.push('S'.repeat(9))
    for (let y = 2; y <= 6; y++) {
      rows[y] = rows[y].slice(0, 2) + 'L'.repeat(5) + rows[y].slice(7)
    }
    const grid = gridFromPattern(rows)
    grid.cellMiles = 2
    const sdf = buildCoastlineSdf(grid)

    const centreIndex = indexOf(grid, 4, 4) // the middle of the 5x5 land block
    const edgeIndex = indexOf(grid, 2, 4) // a coastal land cell on the same row
    expect(sdf[centreIndex]).toBeGreaterThan(sdf[edgeIndex])
    expect(sdf[edgeIndex]).toBe(0)

    const farSeaIndex = indexOf(grid, 0, 0)
    const nearSeaIndex = indexOf(grid, 1, 2) // just outside the land block
    expect(sdf[farSeaIndex]).toBeLessThan(sdf[nearSeaIndex])
  })

  it('is deterministic: identical grids produce identical fields', () => {
    const rows = ['SSSS', 'SLLS', 'SLLS', 'SSSS']
    const a = buildCoastlineSdf(gridFromPattern(rows))
    const b = buildCoastlineSdf(gridFromPattern(rows))
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})
