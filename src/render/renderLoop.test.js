import { describe, expect, it, vi } from 'vitest'
import { createRenderLoop } from './renderLoop.js'

/**
 * A fake `requestAnimationFrame`/`cancelAnimationFrame` pair that never
 * fires on its own: the test calls `flush()` to run pending callbacks,
 * so frame timing is fully controlled rather than depending on real
 * timers or a DOM.
 *
 * @returns {{requestFrame: Function, cancelFrame: Function, flush: (timestampMs?: number) => void, pendingCount: () => number}}
 */
function createFakeScheduler() {
  let nextId = 1
  const pending = new Map()
  return {
    requestFrame(callback) {
      const id = nextId++
      pending.set(id, callback)
      return id
    },
    cancelFrame(id) {
      pending.delete(id)
    },
    flush(timestampMs = 0) {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback(timestampMs)
    },
    pendingCount: () => pending.size,
  }
}

describe('createRenderLoop', () => {
  it('does not render before start()', () => {
    const scheduler = createFakeScheduler()
    const render = vi.fn()
    const loop = createRenderLoop({ render, requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame })

    loop.markDirty()
    expect(scheduler.pendingCount()).toBe(0)
    expect(render).not.toHaveBeenCalled()
  })

  it('schedules and runs exactly one frame per markDirty() once started', () => {
    const scheduler = createFakeScheduler()
    const render = vi.fn()
    const loop = createRenderLoop({ render, requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame })

    loop.start()
    loop.markDirty()
    expect(scheduler.pendingCount()).toBe(1)
    scheduler.flush(16.6)
    expect(render).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledWith(16.6)
  })

  it('coalesces repeated markDirty() calls within one pending frame into a single render', () => {
    const scheduler = createFakeScheduler()
    const render = vi.fn()
    const loop = createRenderLoop({ render, requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame })

    loop.start()
    loop.markDirty()
    loop.markDirty()
    loop.markDirty()
    expect(scheduler.pendingCount()).toBe(1)
    scheduler.flush()
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing at all while nothing calls markDirty() (the near-zero-CPU idle state)', () => {
    const scheduler = createFakeScheduler()
    const render = vi.fn()
    const loop = createRenderLoop({ render, requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame })

    loop.start()
    expect(scheduler.pendingCount()).toBe(0)
    expect(render).not.toHaveBeenCalled()
  })

  it('schedules a new frame again after the pending one fires', () => {
    const scheduler = createFakeScheduler()
    const render = vi.fn()
    const loop = createRenderLoop({ render, requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame })

    loop.start()
    loop.markDirty()
    scheduler.flush()
    expect(scheduler.pendingCount()).toBe(0)

    loop.markDirty()
    expect(scheduler.pendingCount()).toBe(1)
  })

  it('stop() cancels a pending frame and prevents it from rendering', () => {
    const scheduler = createFakeScheduler()
    const render = vi.fn()
    const loop = createRenderLoop({ render, requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame })

    loop.start()
    loop.markDirty()
    expect(scheduler.pendingCount()).toBe(1)
    loop.stop()
    expect(scheduler.pendingCount()).toBe(0)
  })

  it('markDirty() after stop() does not schedule a frame', () => {
    const scheduler = createFakeScheduler()
    const render = vi.fn()
    const loop = createRenderLoop({ render, requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame })

    loop.start()
    loop.stop()
    loop.markDirty()
    expect(scheduler.pendingCount()).toBe(0)
    expect(render).not.toHaveBeenCalled()
  })

  it('a render() that calls markDirty() again keeps the loop animating (one frame per tick)', () => {
    const scheduler = createFakeScheduler()
    let ticks = 0
    const loop = createRenderLoop({
      render: () => {
        ticks += 1
        if (ticks < 3) loop.markDirty()
      },
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    })

    loop.start()
    loop.markDirty()
    scheduler.flush()
    scheduler.flush()
    scheduler.flush()
    expect(ticks).toBe(3)
    expect(scheduler.pendingCount()).toBe(0)
  })
})
