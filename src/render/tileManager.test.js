import { describe, expect, it, vi } from 'vitest'
import { topDownProjection } from './projection.js'
import { createTileManager } from './tileManager.js'
import { buildTileLevels, parentTileKey, tileKey } from './tiles.js'

/** @returns {{postMessage: Function, terminate: Function, reply: (data: object) => void, onmessage: Function|null}} A fake worker that replies synchronously when told to. */
function fakeWorker() {
  const worker = {
    postMessage: vi.fn((message) => {
      // Synchronous auto-reply with a fake bitmap, keyed by the request, so
      // most tests don't need to manually drive the worker protocol.
      worker.lastMessage = message
    }),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    reply(data) {
      worker.onmessage({ data })
    },
  }
  return worker
}

function fakeWorkerFactory(count = 4) {
  const workers = Array.from({ length: count }, fakeWorker)
  let next = 0
  return { createWorker: () => workers[next++], workers }
}

const VIEWPORT = { width: 800, height: 600 }

describe('createTileManager', () => {
  it('ensureVisible requests every visible tile and returns the addressing result', () => {
    const { createWorker, workers } = fakeWorkerFactory()
    const manager = createTileManager({ createWorker, workerCount: workers.length })
    const camera = { x: 0, y: 0, ppm: 24 }

    const result = manager.ensureVisible(camera, VIEWPORT, topDownProjection)
    expect(result.visible.length).toBeGreaterThan(0)

    const requestedKeys = workers.flatMap((w) => w.postMessage.mock.calls.map((call) => call[0].key))
    for (const key of result.visible) {
      expect(requestedKeys).toContain(key)
    }
  })

  it('does not re-request a tile that is already cached', () => {
    const { createWorker, workers } = fakeWorkerFactory()
    const manager = createTileManager({ createWorker, workerCount: workers.length })
    const camera = { x: 0, y: 0, ppm: 24 }

    const first = manager.ensureVisible(camera, VIEWPORT, topDownProjection)
    // Simulate every visible tile having already arrived.
    for (const key of first.visible) manager.cache.set(key, { id: key }, 1)
    const callsBefore = workers.reduce((sum, w) => sum + w.postMessage.mock.calls.length, 0)

    manager.ensureVisible(camera, VIEWPORT, topDownProjection)
    const callsAfter = workers.reduce((sum, w) => sum + w.postMessage.mock.calls.length, 0)
    expect(callsAfter).toBe(callsBefore) // nothing new requested
  })

  it('getDrawable returns the tile itself once cached', () => {
    const manager = createTileManager({ createWorker: fakeWorkerFactory().createWorker })
    const key = tileKey(2, 3, 4)
    const bitmap = { id: 'self' }
    manager.cache.set(key, bitmap, 1)
    expect(manager.getDrawable(key)).toEqual({ key, bitmap, levelsUp: 0 })
  })

  it('getDrawable falls back to the nearest cached ancestor (the blurred-parent-tile placeholder)', () => {
    const manager = createTileManager({ createWorker: fakeWorkerFactory().createWorker })
    const grandparentKey = tileKey(0, 0, 0)
    const parentKey = tileKey(1, 0, 0)
    const childKey = tileKey(2, 0, 0)
    expect(parentTileKey(parentKey)).toBe(grandparentKey)
    expect(parentTileKey(childKey)).toBe(parentKey)

    const bitmap = { id: 'grandparent' }
    manager.cache.set(grandparentKey, bitmap, 1) // neither the tile nor its direct parent is cached
    expect(manager.getDrawable(childKey)).toEqual({ key: grandparentKey, bitmap, levelsUp: 2 })
  })

  it('getDrawable returns null when no ancestor at any level is cached (a true hole)', () => {
    const manager = createTileManager({ createWorker: fakeWorkerFactory().createWorker })
    expect(manager.getDrawable(tileKey(3, 10, 10))).toBeNull()
  })

  it('calls onDirty when a requested tile arrives', () => {
    const onDirty = vi.fn()
    const { createWorker, workers } = fakeWorkerFactory()
    const manager = createTileManager({ createWorker, workerCount: workers.length, onDirty })
    manager.ensureVisible({ x: 0, y: 0, ppm: 48 }, VIEWPORT, topDownProjection)

    const busyWorker = workers.find((w) => w.postMessage.mock.calls.length > 0)
    const key = busyWorker.postMessage.mock.calls[0][0].key
    busyWorker.reply({ type: 'tile', key, bitmap: { id: key } })

    expect(onDirty).toHaveBeenCalled()
    expect(manager.cache.has(key)).toBe(true)
  })

  it('forwards worker errors via onError (worker errors surface, per the Done-when)', () => {
    const onError = vi.fn()
    const { createWorker, workers } = fakeWorkerFactory()
    const manager = createTileManager({ createWorker, workerCount: workers.length, onError })
    manager.ensureVisible({ x: 0, y: 0, ppm: 48 }, VIEWPORT, topDownProjection)

    const busyWorker = workers.find((w) => w.postMessage.mock.calls.length > 0)
    const key = busyWorker.postMessage.mock.calls[0][0].key
    busyWorker.reply({ type: 'error', key, message: 'tile render failed' })

    expect(onError).toHaveBeenCalledWith(key, 'tile render failed')
  })

  it('the cache never exceeds the configured capacity, even across many ensureVisible calls (the Done-when "cache stays under cap")', () => {
    const { createWorker } = fakeWorkerFactory(4)
    const capacityBytes = 50 * 512 * 512 * 4 // room for 50 tiles
    const manager = createTileManager({ createWorker, workerCount: 4, capacityBytes })
    const levels = buildTileLevels()

    // Sweep the camera across many positions and zoom levels, caching a
    // placeholder bitmap directly for every tile ensureVisible asks for
    // (standing in for a worker reply), to exercise sustained churn
    // without needing real async worker round-trips in this test.
    for (let step = 0; step < 200; step++) {
      const ppm = levels[step % levels.length]
      const camera = { x: step * 3, y: step * 2, ppm }
      const result = manager.ensureVisible(camera, VIEWPORT, topDownProjection)
      for (const key of [...result.visible, ...result.neighbours]) {
        if (!manager.cache.has(key)) manager.cache.set(key, { id: key }, 512 * 512 * 4)
      }
      expect(manager.cache.totalBytes).toBeLessThanOrEqual(capacityBytes)
    }
  })

  it('destroy() terminates every worker and clears the cache', () => {
    const { createWorker, workers } = fakeWorkerFactory()
    const manager = createTileManager({ createWorker, workerCount: workers.length })
    manager.cache.set('a', { id: 'a' }, 1)
    manager.destroy()
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce()
    expect(manager.cache.size).toBe(0)
  })
})
