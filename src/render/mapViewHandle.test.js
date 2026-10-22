import { describe, expect, it, vi } from 'vitest'
import { createMapViewHandle, stepJumpAnimation } from './mapViewHandle.js'

describe('createMapViewHandle', () => {
  it('markDirty calls the given function', () => {
    const markDirty = vi.fn()
    const handle = createMapViewHandle({ cameraRef: { current: null }, jumpAnimRef: { current: null }, viewportRef: { current: {} }, markDirty, jumpDurationMs: 500 })
    handle.markDirty()
    expect(markDirty).toHaveBeenCalled()
  })

  it('getCamera/getViewport read straight through to the refs', () => {
    const cameraRef = { current: { x: 1, y: 2, ppm: 3 } }
    const viewportRef = { current: { width: 800, height: 600 } }
    const handle = createMapViewHandle({ cameraRef, jumpAnimRef: { current: null }, viewportRef, markDirty: () => {}, jumpDurationMs: 500 })
    expect(handle.getCamera()).toBe(cameraRef.current)
    expect(handle.getViewport()).toBe(viewportRef.current)
  })

  it('setCamera replaces the camera immediately and clears any in-progress jump', () => {
    const cameraRef = { current: { x: 0, y: 0, ppm: 1.5 } }
    const jumpAnimRef = { current: { from: {}, to: {}, startMs: 0, durationMs: 500 } }
    const markDirty = vi.fn()
    const handle = createMapViewHandle({ cameraRef, jumpAnimRef, viewportRef: { current: {} }, markDirty, jumpDurationMs: 500 })

    handle.setCamera({ x: 10, y: 20, ppm: 5 })

    expect(cameraRef.current).toEqual({ x: 10, y: 20, ppm: 5 })
    expect(jumpAnimRef.current).toBeNull()
    expect(markDirty).toHaveBeenCalled()
  })

  it('jumpTo starts an animation from the current camera to the target point, defaulting ppm to the current zoom', () => {
    const cameraRef = { current: { x: 0, y: 0, ppm: 8 } }
    const jumpAnimRef = { current: null }
    const markDirty = vi.fn()
    const handle = createMapViewHandle({ cameraRef, jumpAnimRef, viewportRef: { current: {} }, markDirty, jumpDurationMs: 500 })

    handle.jumpTo({ x: 100, y: 200 })

    expect(jumpAnimRef.current.from).toBe(cameraRef.current)
    expect(jumpAnimRef.current.to).toEqual({ x: 100, y: 200, ppm: 8 })
    expect(jumpAnimRef.current.durationMs).toBe(500)
    expect(markDirty).toHaveBeenCalled()
  })

  it('jumpTo accepts an explicit target ppm', () => {
    const cameraRef = { current: { x: 0, y: 0, ppm: 8 } }
    const jumpAnimRef = { current: null }
    const handle = createMapViewHandle({ cameraRef, jumpAnimRef, viewportRef: { current: {} }, markDirty: () => {}, jumpDurationMs: 500 })

    handle.jumpTo({ x: 100, y: 200 }, 20)

    expect(jumpAnimRef.current.to.ppm).toBe(20)
  })

  it('jumpTo is a no-op before the camera has been initialised', () => {
    const jumpAnimRef = { current: null }
    const markDirty = vi.fn()
    const handle = createMapViewHandle({ cameraRef: { current: null }, jumpAnimRef, viewportRef: { current: {} }, markDirty, jumpDurationMs: 500 })

    handle.jumpTo({ x: 1, y: 2 })

    expect(jumpAnimRef.current).toBeNull()
    expect(markDirty).not.toHaveBeenCalled()
  })
})

describe('stepJumpAnimation', () => {
  it('interpolates the camera partway through the animation (eased, not linear) and keeps it running', () => {
    const cameraRef = { current: null }
    const jumpAnimRef = { current: { from: { x: 0, y: 0, ppm: 2 }, to: { x: 100, y: 0, ppm: 2 }, startMs: 1000, durationMs: 1000 } }
    const markDirty = vi.fn()

    stepJumpAnimation({ jumpAnimRef, cameraRef, timestampMs: 1500, markDirty })

    // easeOutCubic(0.5) = 1 - 0.5^3 = 0.875, not a linear 0.5 — the eased
    // progress front-loads the motion, same as every other animated
    // transition in this project (DESIGN 9.2's own "short eased animation").
    expect(cameraRef.current.x).toBeCloseTo(87.5, 5)
    expect(jumpAnimRef.current).not.toBeNull()
    expect(markDirty).toHaveBeenCalled()
  })

  it('finishes at the target and clears the animation once duration has elapsed', () => {
    const cameraRef = { current: null }
    const jumpAnimRef = { current: { from: { x: 0, y: 0, ppm: 2 }, to: { x: 100, y: 50, ppm: 10 }, startMs: 1000, durationMs: 1000 } }
    const markDirty = vi.fn()

    stepJumpAnimation({ jumpAnimRef, cameraRef, timestampMs: 2000, markDirty })

    expect(cameraRef.current.x).toBeCloseTo(100, 10)
    expect(cameraRef.current.y).toBeCloseTo(50, 10)
    expect(cameraRef.current.ppm).toBeCloseTo(10, 10) // lerpCamera interpolates ppm in log space (exp/log round-trip), not bit-exact at t=1.
    expect(jumpAnimRef.current).toBeNull()
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('clamps a timestamp past the animation end instead of overshooting', () => {
    const cameraRef = { current: null }
    const jumpAnimRef = { current: { from: { x: 0, y: 0, ppm: 2 }, to: { x: 100, y: 50, ppm: 10 }, startMs: 1000, durationMs: 1000 } }

    stepJumpAnimation({ jumpAnimRef, cameraRef, timestampMs: 5000, markDirty: () => {} })

    expect(cameraRef.current.x).toBeCloseTo(100, 10)
    expect(cameraRef.current.y).toBeCloseTo(50, 10)
    expect(cameraRef.current.ppm).toBeCloseTo(10, 10)
  })
})
