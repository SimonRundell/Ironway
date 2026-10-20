import { describe, expect, it } from 'vitest'
import { topDownProjection } from './projection.js'
import {
  MAX_PPM,
  MIN_PPM,
  clampPosition,
  clampPpm,
  easeOutCubic,
  fitToIsland,
  lerpCamera,
  panByScreenDelta,
  stepInertia,
  zoomAtPoint,
  zoomByWheel,
} from './camera.js'

const VIEWPORT = { width: 800, height: 600 }

/**
 * A 2:1 isometric projection, defined only here (DESIGN 9.2.1, T2.00's
 * spike): `screen = centre + M(ppm) * (point - camera)` with
 * `M = [[ppm, -ppm], [ppm/2, ppm/2]]`, and its algebraic inverse. Every
 * shared test below runs against this as well as the shipped
 * `topDownProjection`, to prove `camera.js` never assumes top-down.
 *
 * @type {{worldToScreen: Function, screenToWorld: Function}}
 */
const isoProjection = {
  worldToScreen(camera, viewport, point) {
    const dx = point.x - camera.x
    const dy = point.y - camera.y
    return {
      x: viewport.width / 2 + camera.ppm * (dx - dy),
      y: viewport.height / 2 + (camera.ppm / 2) * (dx + dy),
    }
  },
  screenToWorld(camera, viewport, point) {
    const rx = point.x - viewport.width / 2
    const ry = point.y - viewport.height / 2
    const dx = (rx + 2 * ry) / (2 * camera.ppm)
    const dy = (2 * ry - rx) / (2 * camera.ppm)
    return { x: camera.x + dx, y: camera.y + dy }
  },
}

const PROJECTIONS = [
  ['top-down', topDownProjection],
  ['2:1 isometric', isoProjection],
]

describe.each(PROJECTIONS)('camera transforms against %s', (_name, projection) => {
  it('round-trips screenToWorld(worldToScreen(p)) back to p', () => {
    const camera = { x: 12, y: -8, ppm: 10 }
    const point = { x: 30, y: -20 }
    const screen = projection.worldToScreen(camera, VIEWPORT, point)
    const back = projection.screenToWorld(camera, VIEWPORT, screen)
    expect(back.x).toBeCloseTo(point.x, 6)
    expect(back.y).toBeCloseTo(point.y, 6)
  })

  it('zoomAtPoint keeps the world point under the cursor fixed on screen', () => {
    const camera = { x: 5, y: 5, ppm: 8 }
    const cursor = { x: 600, y: 150 }
    const worldUnderCursor = projection.screenToWorld(camera, VIEWPORT, cursor)

    const zoomedIn = zoomAtPoint(camera, VIEWPORT, cursor, 32, projection)
    const screenAfterZoomIn = projection.worldToScreen(zoomedIn, VIEWPORT, worldUnderCursor)
    expect(screenAfterZoomIn.x).toBeCloseTo(cursor.x, 6)
    expect(screenAfterZoomIn.y).toBeCloseTo(cursor.y, 6)

    const zoomedOut = zoomAtPoint(camera, VIEWPORT, cursor, 2, projection)
    const screenAfterZoomOut = projection.worldToScreen(zoomedOut, VIEWPORT, worldUnderCursor)
    expect(screenAfterZoomOut.x).toBeCloseTo(cursor.x, 6)
    expect(screenAfterZoomOut.y).toBeCloseTo(cursor.y, 6)
  })

  it('zoomAtPoint clamps ppm to [MIN_PPM, MAX_PPM]', () => {
    const camera = { x: 0, y: 0, ppm: 8 }
    expect(zoomAtPoint(camera, VIEWPORT, { x: 400, y: 300 }, 0.001, projection).ppm).toBe(MIN_PPM)
    expect(zoomAtPoint(camera, VIEWPORT, { x: 400, y: 300 }, 1000, projection).ppm).toBe(MAX_PPM)
  })

  it('zoomByWheel zooms in on negative deltaY and out on positive deltaY, anchored to the cursor', () => {
    const camera = { x: 0, y: 0, ppm: 8 }
    const cursor = { x: 500, y: 400 }
    const worldUnderCursor = projection.screenToWorld(camera, VIEWPORT, cursor)

    const zoomedIn = zoomByWheel(camera, VIEWPORT, cursor, -100, projection)
    expect(zoomedIn.ppm).toBeGreaterThan(camera.ppm)
    const screenIn = projection.worldToScreen(zoomedIn, VIEWPORT, worldUnderCursor)
    expect(screenIn.x).toBeCloseTo(cursor.x, 6)
    expect(screenIn.y).toBeCloseTo(cursor.y, 6)

    const zoomedOut = zoomByWheel(camera, VIEWPORT, cursor, 100, projection)
    expect(zoomedOut.ppm).toBeLessThan(camera.ppm)
  })

  it('panByScreenDelta moves whatever was at the viewport centre by exactly the screen delta', () => {
    const camera = { x: 10, y: -5, ppm: 12 }
    const worldAtCentre = projection.screenToWorld(camera, VIEWPORT, { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 })
    const delta = { x: 37, y: -21 }

    const panned = panByScreenDelta(camera, VIEWPORT, delta, projection)
    const screenNow = projection.worldToScreen(panned, VIEWPORT, worldAtCentre)
    expect(screenNow.x).toBeCloseTo(VIEWPORT.width / 2 + delta.x, 6)
    expect(screenNow.y).toBeCloseTo(VIEWPORT.height / 2 + delta.y, 6)
  })

  it('stepInertia decays velocity exponentially and eventually settles', () => {
    let camera = { x: 0, y: 0, ppm: 8 }
    let velocity = { x: 400, y: -200 }
    for (let i = 0; i < 300; i++) {
      ;({ camera, velocity } = stepInertia(camera, VIEWPORT, velocity, 1 / 60, projection))
    }
    expect(Math.hypot(velocity.x, velocity.y)).toBeLessThan(0.01)
  })

  it('stepInertia pans by exactly the distance covered this step', () => {
    const camera = { x: 0, y: 0, ppm: 10 }
    const velocity = { x: 120, y: 60 }
    const dt = 1 / 60
    const { camera: next } = stepInertia(camera, VIEWPORT, velocity, dt, projection, 0)
    const expected = panByScreenDelta(camera, VIEWPORT, { x: velocity.x * dt, y: velocity.y * dt }, projection)
    expect(next.x).toBeCloseTo(expected.x, 9)
    expect(next.y).toBeCloseTo(expected.y, 9)
  })

  it('fitToIsland shows the whole island within the clamped zoom range', () => {
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 }
    const fitted = fitToIsland(VIEWPORT, bounds)
    expect(fitted.x).toBeCloseTo(100, 6)
    expect(fitted.y).toBeCloseTo(50, 6)
    expect(fitted.ppm).toBeGreaterThanOrEqual(MIN_PPM)
    expect(fitted.ppm).toBeLessThanOrEqual(MAX_PPM)
  })
})

describe('resizing keeps the view centre (projection-level guarantee camera.js relies on)', () => {
  it('top-down: the camera position stays under the viewport centre after a resize', () => {
    const camera = { x: 42, y: -17, ppm: 6 }
    const before = topDownProjection.worldToScreen(camera, { width: 800, height: 600 }, { x: 42, y: -17 })
    const after = topDownProjection.worldToScreen(camera, { width: 1400, height: 900 }, { x: 42, y: -17 })
    expect(before).toEqual({ x: 400, y: 300 })
    expect(after).toEqual({ x: 700, y: 450 })
  })
})

describe('clampPpm', () => {
  it('clamps to the default [MIN_PPM, MAX_PPM] range', () => {
    expect(clampPpm(0.1)).toBe(MIN_PPM)
    expect(clampPpm(1000)).toBe(MAX_PPM)
    expect(clampPpm(10)).toBe(10)
  })

  it('accepts a narrower explicit range', () => {
    expect(clampPpm(50, 4, 40)).toBe(40)
  })
})

describe('clampPosition', () => {
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 }

  it('leaves an in-bounds camera unchanged', () => {
    const camera = { x: 50, y: 25, ppm: 8 }
    expect(clampPosition(camera, bounds)).toEqual(camera)
  })

  it('clamps an out-of-bounds camera to the bounds', () => {
    expect(clampPosition({ x: -20, y: 200, ppm: 8 }, bounds)).toEqual({ x: 0, y: 50, ppm: 8 })
  })

  it('allows a margin outside the bounds', () => {
    expect(clampPosition({ x: -20, y: 0, ppm: 8 }, bounds, 10)).toEqual({ x: -10, y: 0, ppm: 8 })
  })
})

describe('easeOutCubic', () => {
  it('starts at 0 and ends at 1', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
  })

  it('is front-loaded (past the midpoint by t=0.5)', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })
})

describe('lerpCamera', () => {
  it('returns the start and end cameras at t=0 and t=1', () => {
    const from = { x: 0, y: 0, ppm: 4 }
    const to = { x: 10, y: -10, ppm: 16 }
    expect(lerpCamera(from, to, 0)).toEqual(from)
    const end = lerpCamera(from, to, 1)
    expect(end.x).toBeCloseTo(to.x, 9)
    expect(end.y).toBeCloseTo(to.y, 9)
    expect(end.ppm).toBeCloseTo(to.ppm, 9)
  })

  it('interpolates ppm in log space, not linearly', () => {
    const from = { x: 0, y: 0, ppm: 4 }
    const to = { x: 0, y: 0, ppm: 16 }
    // Linear interpolation would give 10 at t=0.5; log-space gives sqrt(4*16)=8.
    expect(lerpCamera(from, to, 0.5).ppm).toBeCloseTo(8, 9)
  })
})
