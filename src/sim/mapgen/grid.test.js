import { describe, expect, it } from 'vitest'
import { clampByte, computeDistanceFromSources, createWorldGrid, indexOf, isInBounds, neighbours4, neighbours8 } from './grid.js'

describe('createWorldGrid', () => {
  it('allocates every DESIGN 5.1 layer at the right size', () => {
    const grid = createWorldGrid(10, 5, 2)

    expect(grid.width).toBe(10)
    expect(grid.height).toBe(5)
    expect(grid.cellMiles).toBe(2)

    for (const layer of [
      'elev', 'water', 'flow', 'river', 'rain', 'soil', 'arable', 'pastoral',
      'landuse', 'slope', 'coast', 'shelter', 'resource', 'richness', 'region',
    ]) {
      expect(grid[layer]).toBeDefined()
      expect(grid[layer].length).toBe(50)
    }
  })

  it('zeroes every layer initially', () => {
    const grid = createWorldGrid(4, 4, 2)
    expect([...grid.elev].every((v) => v === 0)).toBe(true)
    expect([...grid.water].every((v) => v === 0)).toBe(true)
  })

  it('uses the right typed array kind per layer', () => {
    const grid = createWorldGrid(4, 4, 2)
    expect(grid.elev).toBeInstanceOf(Int16Array)
    expect(grid.water).toBeInstanceOf(Uint8Array)
    expect(grid.flow).toBeInstanceOf(Uint16Array)
  })
})

describe('indexOf', () => {
  it('maps (x, y) to a row-major index', () => {
    const grid = createWorldGrid(10, 5, 2)
    expect(indexOf(grid, 0, 0)).toBe(0)
    expect(indexOf(grid, 9, 0)).toBe(9)
    expect(indexOf(grid, 0, 1)).toBe(10)
    expect(indexOf(grid, 3, 2)).toBe(23)
  })
})

describe('isInBounds', () => {
  const grid = createWorldGrid(10, 5, 2)

  it('accepts corners and interior points', () => {
    expect(isInBounds(grid, 0, 0)).toBe(true)
    expect(isInBounds(grid, 9, 4)).toBe(true)
    expect(isInBounds(grid, 5, 2)).toBe(true)
  })

  it('rejects anything outside the grid', () => {
    expect(isInBounds(grid, -1, 0)).toBe(false)
    expect(isInBounds(grid, 0, -1)).toBe(false)
    expect(isInBounds(grid, 10, 0)).toBe(false)
    expect(isInBounds(grid, 0, 5)).toBe(false)
  })
})

describe('neighbours4', () => {
  it('returns all 4 for an interior cell', () => {
    const grid = createWorldGrid(10, 5, 2)
    const result = neighbours4(grid, 5, 2)
    expect(result).toHaveLength(4)
    expect(result).toEqual(expect.arrayContaining([[6, 2], [4, 2], [5, 3], [5, 1]]))
  })

  it('returns only 2 for a corner cell', () => {
    const grid = createWorldGrid(10, 5, 2)
    const result = neighbours4(grid, 0, 0)
    expect(result).toHaveLength(2)
    expect(result).toEqual(expect.arrayContaining([[1, 0], [0, 1]]))
  })
})

describe('neighbours8', () => {
  it('returns all 8 for an interior cell', () => {
    const grid = createWorldGrid(10, 5, 2)
    expect(neighbours8(grid, 5, 2)).toHaveLength(8)
  })

  it('returns only 3 for a corner cell', () => {
    const grid = createWorldGrid(10, 5, 2)
    expect(neighbours8(grid, 0, 0)).toHaveLength(3)
  })
})

describe('clampByte', () => {
  it('rounds to the nearest integer', () => {
    expect(clampByte(10.4)).toBe(10)
    expect(clampByte(10.5)).toBe(11)
  })

  it('clamps below 0 to 0', () => {
    expect(clampByte(-5)).toBe(0)
  })

  it('clamps above 255 to 255', () => {
    expect(clampByte(300)).toBe(255)
  })

  it('passes through values already in range', () => {
    expect(clampByte(0)).toBe(0)
    expect(clampByte(255)).toBe(255)
    expect(clampByte(128)).toBe(128)
  })
})

describe('computeDistanceFromSources', () => {
  it('gives sources distance 0 and grows outward by 1 per step', () => {
    // 5x1 strip, source at the left end.
    const grid = createWorldGrid(5, 1, 2)
    const distance = computeDistanceFromSources(grid, (i) => i === 0)
    expect([...distance]).toEqual([0, 1, 2, 3, 4])
  })

  it('takes the shortest distance to any of several sources', () => {
    // 5x1 strip, sources at both ends: the middle cell is 2 away from either.
    const grid = createWorldGrid(5, 1, 2)
    const distance = computeDistanceFromSources(grid, (i) => i === 0 || i === 4)
    expect([...distance]).toEqual([0, 1, 2, 1, 0])
  })

  it('counts a diagonal step as distance 1 (8-connected)', () => {
    const grid = createWorldGrid(3, 3, 2)
    const distance = computeDistanceFromSources(grid, (i) => i === 0) // (0,0)
    expect(distance[indexOf(grid, 1, 1)]).toBe(1) // diagonal neighbour
    expect(distance[indexOf(grid, 2, 2)]).toBe(2)
  })

  it('leaves every cell at -1 when there are no sources', () => {
    const grid = createWorldGrid(3, 3, 2)
    const distance = computeDistanceFromSources(grid, () => false)
    expect([...distance].every((d) => d === -1)).toBe(true)
  })
})
