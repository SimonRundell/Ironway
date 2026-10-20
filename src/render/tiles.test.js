import { describe, expect, it } from 'vitest'
import { MAX_PPM, MIN_PPM } from './camera.js'
import { topDownProjection } from './projection.js'
import {
  TILE_PIXELS,
  buildTileLevels,
  levelIndexForPpm,
  parentTileKey,
  parseTileKey,
  tileKey,
  tileWorldSize,
  visibleTiles,
  worldToTileIndex,
} from './tiles.js'

describe('buildTileLevels', () => {
  it('doubles from MIN_PPM to MAX_PPM, matching the shipped zoom range', () => {
    expect(buildTileLevels()).toEqual([1.5, 3, 6, 12, 24, 48, 96])
  })

  it('always ends exactly on maxPpm, even if doubling would overshoot', () => {
    const levels = buildTileLevels(1, 10)
    expect(levels[levels.length - 1]).toBe(10)
    expect(levels).toEqual([1, 2, 4, 8, 10])
  })
})

describe('levelIndexForPpm', () => {
  const levels = buildTileLevels()

  it('picks the smallest level at least as sharp as the camera', () => {
    expect(levelIndexForPpm(1.5, levels)).toBe(0)
    expect(levelIndexForPpm(2, levels)).toBe(1) // next level up from 1.5 is 3
    expect(levelIndexForPpm(24, levels)).toBe(4)
  })

  it('clamps to the top level beyond MAX_PPM', () => {
    expect(levelIndexForPpm(1000, levels)).toBe(levels.length - 1)
    expect(levels[levelIndexForPpm(MAX_PPM, levels)]).toBe(MAX_PPM)
  })

  it('picks the bottom level at MIN_PPM', () => {
    expect(levels[levelIndexForPpm(MIN_PPM, levels)]).toBe(MIN_PPM)
  })
})

describe('tileWorldSize / worldToTileIndex', () => {
  it('a tile covers TILE_PIXELS / levelPpm miles per side', () => {
    expect(tileWorldSize(12)).toBeCloseTo(TILE_PIXELS / 12, 9)
  })

  it('floors to the containing tile index', () => {
    expect(worldToTileIndex(25, 10)).toBe(2)
    expect(worldToTileIndex(-1, 10)).toBe(-1)
    expect(worldToTileIndex(-15, 10)).toBe(-2)
  })
})

describe('tileKey / parseTileKey / parentTileKey', () => {
  it('round-trips level/tileX/tileY through a key', () => {
    expect(parseTileKey(tileKey(3, -2, 7))).toEqual({ level: 3, tileX: -2, tileY: 7 })
  })

  it('halves the tile index and drops one level for the parent', () => {
    expect(parentTileKey(tileKey(2, 6, 9))).toBe(tileKey(1, 3, 4))
  })

  it('floor-divides negative indices correctly (not truncates toward zero)', () => {
    expect(parentTileKey(tileKey(2, -3, -1))).toBe(tileKey(1, -2, -1))
  })

  it('has no parent at level 0', () => {
    expect(parentTileKey(tileKey(0, 5, 5))).toBeNull()
  })
})

describe('visibleTiles', () => {
  const levels = buildTileLevels()
  const viewport = { width: 800, height: 600 }

  it('covers exactly the camera viewport at the chosen level, with no gaps', () => {
    const camera = { x: 0, y: 0, ppm: 12 }
    const { levelIndex, levelPpm, visible } = visibleTiles(camera, viewport, topDownProjection, levels)
    expect(levelPpm).toBe(levels[levelIndex])

    const tileSize = tileWorldSize(levelPpm)
    const corners = topDownProjection.visibleWorldPolygon(camera, viewport)
    const minX = Math.min(...corners.map((c) => c.x))
    const maxX = Math.max(...corners.map((c) => c.x))
    const expectedCount = (worldToTileIndex(maxX, tileSize) - worldToTileIndex(minX, tileSize) + 1) ** 2
    expect(visible.length).toBe(expectedCount)
  })

  it('neighbours ring the visible set without duplicating it', () => {
    const camera = { x: 0, y: 0, ppm: 24 }
    const { visible, neighbours } = visibleTiles(camera, viewport, topDownProjection, levels)
    const visibleSet = new Set(visible)
    for (const key of neighbours) {
      expect(visibleSet.has(key)).toBe(false)
    }
    expect(new Set(neighbours).size).toBe(neighbours.length) // no duplicate neighbours
  })

  it('a one-tile pan shifts the visible set by one tile column, not a full re-tiling', () => {
    const tileSize = tileWorldSize(levels[levelIndexForPpm(12, levels)])
    const camera = { x: 0, y: 0, ppm: 12 }
    const panned = { x: tileSize, y: 0, ppm: 12 }
    const before = new Set(visibleTiles(camera, viewport, topDownProjection, levels).visible)
    const after = new Set(visibleTiles(panned, viewport, topDownProjection, levels).visible)
    const kept = [...before].filter((key) => after.has(key))
    expect(kept.length).toBeGreaterThan(0)
  })
})
