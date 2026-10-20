import { describe, expect, it } from 'vitest'
import { depthKey, screenToWorld, tileTransform, topDownProjection, visibleWorldPolygon, worldToScreen } from './projection.js'

const VIEWPORT = { width: 800, height: 600 }

describe('worldToScreen / screenToWorld', () => {
  it('maps the camera centre to the screen centre', () => {
    const camera = { x: 10, y: -4, ppm: 8 }
    expect(worldToScreen(camera, VIEWPORT, { x: 10, y: -4 })).toEqual({ x: 400, y: 300 })
  })

  it('scales by ppm', () => {
    const camera = { x: 0, y: 0, ppm: 10 }
    expect(worldToScreen(camera, VIEWPORT, { x: 2, y: -3 })).toEqual({ x: 420, y: 270 })
  })

  it('round-trips world -> screen -> world', () => {
    const camera = { x: 123.5, y: -47.25, ppm: 24 }
    const original = { x: 140, y: -30 }
    const screen = worldToScreen(camera, VIEWPORT, original)
    const back = screenToWorld(camera, VIEWPORT, screen)
    expect(back.x).toBeCloseTo(original.x, 9)
    expect(back.y).toBeCloseTo(original.y, 9)
  })

  it('round-trips screen -> world -> screen', () => {
    const camera = { x: -5, y: 9, ppm: 3.5 }
    const original = { x: 650, y: 12 }
    const world = screenToWorld(camera, VIEWPORT, original)
    const back = worldToScreen(camera, VIEWPORT, world)
    expect(back.x).toBeCloseTo(original.x, 9)
    expect(back.y).toBeCloseTo(original.y, 9)
  })

  it('keeps the view centre fixed when the viewport is resized (no camera change)', () => {
    const camera = { x: 10, y: 10, ppm: 8 }
    const before = worldToScreen(camera, { width: 800, height: 600 }, { x: 10, y: 10 })
    const after = worldToScreen(camera, { width: 1200, height: 900 }, { x: 10, y: 10 })
    expect(before).toEqual({ x: 400, y: 300 })
    expect(after).toEqual({ x: 600, y: 450 })
  })
})

describe('visibleWorldPolygon', () => {
  it('is an axis-aligned rectangle matching the viewport size and zoom, in top-down', () => {
    const camera = { x: 0, y: 0, ppm: 10 }
    const [topLeft, topRight, bottomRight, bottomLeft] = visibleWorldPolygon(camera, VIEWPORT)
    expect(topLeft).toEqual({ x: -40, y: -30 })
    expect(topRight).toEqual({ x: 40, y: -30 })
    expect(bottomRight).toEqual({ x: 40, y: 30 })
    expect(bottomLeft).toEqual({ x: -40, y: 30 })
  })

  it('is centred on the camera', () => {
    const camera = { x: 100, y: -50, ppm: 20 }
    const corners = visibleWorldPolygon(camera, VIEWPORT)
    const centreX = corners.reduce((sum, c) => sum + c.x, 0) / corners.length
    const centreY = corners.reduce((sum, c) => sum + c.y, 0) / corners.length
    expect(centreX).toBeCloseTo(camera.x, 9)
    expect(centreY).toBeCloseTo(camera.y, 9)
  })
})

describe('tileTransform', () => {
  it('places a tile\'s world origin at its screen position, scaled by ppm', () => {
    const camera = { x: 0, y: 0, ppm: 16 }
    const matrix = tileTransform(camera, VIEWPORT, { x: 5, y: -2 })
    expect(matrix).toEqual({ a: 16, b: 0, c: 0, d: 16, e: 480, f: 268 })
  })
})

describe('depthKey', () => {
  it('is constant in top-down', () => {
    expect(depthKey({ x: 1, y: 2, z: 3 })).toBe(0)
    expect(depthKey()).toBe(0)
  })
})

describe('topDownProjection', () => {
  it('bundles the same five functions', () => {
    expect(topDownProjection.worldToScreen).toBe(worldToScreen)
    expect(topDownProjection.screenToWorld).toBe(screenToWorld)
    expect(topDownProjection.visibleWorldPolygon).toBe(visibleWorldPolygon)
    expect(topDownProjection.tileTransform).toBe(tileTransform)
    expect(topDownProjection.depthKey).toBe(depthKey)
  })
})
