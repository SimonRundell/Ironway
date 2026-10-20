import { describe, expect, it, vi } from 'vitest'
import { createTileWorkerPool } from './tileWorkerPool.js'

/**
 * A fake worker: records what it was asked to render and lets the test
 * decide when (and whether) it "replies", instead of a real `Worker`
 * which needs a browser.
 *
 * @returns {{postMessage: Function, terminate: Function, reply: (data: object) => void, fail: (message: string) => void, messages: object[]}}
 */
function fakeWorker() {
  const worker = {
    messages: [],
    postMessage: vi.fn((message) => worker.messages.push(message)),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    reply(data) {
      worker.onmessage({ data })
    },
    fail(message) {
      worker.onerror({ message })
    },
  }
  return worker
}

/** @param {object[]} workers @returns {Function} A `createWorker` that hands out `workers` in order. */
function fakeWorkerFactory(workers) {
  let next = 0
  return () => workers[next++]
}

describe('createTileWorkerPool', () => {
  it('dispatches a request immediately when a worker is idle', () => {
    const w1 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]) })
    pool.request('0:0:0', { type: 'render', key: '0:0:0' }, 0)
    expect(w1.postMessage).toHaveBeenCalledWith({ type: 'render', key: '0:0:0' })
    expect(pool.inFlightCount()).toBe(1)
    expect(pool.pendingCount()).toBe(0)
  })

  it('queues a request when every worker is busy, then dispatches it once one frees up', () => {
    const w1 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]) })
    pool.request('a', { key: 'a' }, 0)
    pool.request('b', { key: 'b' }, 0)
    expect(pool.pendingCount()).toBe(1)
    expect(w1.postMessage).toHaveBeenCalledTimes(1)

    w1.reply({ type: 'tile', key: 'a', bitmap: {} })
    expect(pool.pendingCount()).toBe(0)
    expect(w1.postMessage).toHaveBeenCalledTimes(2)
    expect(w1.postMessage).toHaveBeenLastCalledWith({ key: 'b' })
  })

  it('serves higher-priority (lower number) requests first', () => {
    const w1 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]) })
    pool.request('busy', { key: 'busy' }, 0) // occupies the only worker
    pool.request('neighbour', { key: 'neighbour' }, 1)
    pool.request('visible', { key: 'visible' }, 0)

    w1.reply({ type: 'tile', key: 'busy', bitmap: {} })
    expect(w1.postMessage).toHaveBeenLastCalledWith({ key: 'visible' })
  })

  it('never dispatches the same key twice while it is in flight', () => {
    const w1 = fakeWorker()
    const w2 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 2, createWorker: fakeWorkerFactory([w1, w2]) })
    pool.request('a', { key: 'a' }, 0)
    pool.request('a', { key: 'a' }, 0) // repeat while in flight: ignored
    expect(pool.inFlightCount()).toBe(1)
    const totalDispatches = w1.postMessage.mock.calls.length + w2.postMessage.mock.calls.length
    expect(totalDispatches).toBe(1) // dispatched to whichever worker picked it up, but only once
  })

  it('folds a repeat queued request into the existing one, keeping the higher priority', () => {
    const w1 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]) })
    pool.request('busy', { key: 'busy' }, 0)
    pool.request('a', { key: 'a' }, 1) // queued as a neighbour
    pool.request('a', { key: 'a' }, 0) // the same tile just became visible
    expect(pool.pendingCount()).toBe(1) // still one queue entry, not two
    w1.reply({ type: 'tile', key: 'busy', bitmap: {} })
    w1.reply({ type: 'tile', key: 'a', bitmap: {} })
    expect(pool.inFlightCount()).toBe(0)
  })

  it('calls onTile with the key and bitmap on success, and frees the worker for the next request', () => {
    const onTile = vi.fn()
    const w1 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]), onTile })
    pool.request('a', { key: 'a' }, 0)
    const bitmap = { id: 'bitmap-a' }
    w1.reply({ type: 'tile', key: 'a', bitmap })
    expect(onTile).toHaveBeenCalledWith('a', bitmap)
    expect(pool.inFlightCount()).toBe(0)
  })

  it('calls onError with the key when a worker reports a render error (worker errors surface, per the Done-when)', () => {
    const onError = vi.fn()
    const w1 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]), onError })
    pool.request('a', { key: 'a' }, 0)
    w1.reply({ type: 'error', key: 'a', message: 'boom' })
    expect(onError).toHaveBeenCalledWith('a', 'boom')
    expect(pool.inFlightCount()).toBe(0) // the worker is freed, not stuck
  })

  it('calls onError with a null key when a whole worker crashes', () => {
    const onError = vi.fn()
    const w1 = fakeWorker()
    createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]), onError })
    w1.fail('out of memory')
    expect(onError).toHaveBeenCalledWith(null, 'out of memory')
  })

  it('cancel() removes a not-yet-dispatched request', () => {
    const w1 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 1, createWorker: fakeWorkerFactory([w1]) })
    pool.request('busy', { key: 'busy' }, 0)
    pool.request('a', { key: 'a' }, 0)
    pool.cancel('a')
    expect(pool.pendingCount()).toBe(0)
    w1.reply({ type: 'tile', key: 'busy', bitmap: {} })
    expect(w1.postMessage).toHaveBeenCalledTimes(1) // 'a' was never sent
  })

  it('destroy() terminates every worker', () => {
    const w1 = fakeWorker()
    const w2 = fakeWorker()
    const pool = createTileWorkerPool({ workerCount: 2, createWorker: fakeWorkerFactory([w1, w2]) })
    pool.destroy()
    expect(w1.terminate).toHaveBeenCalledOnce()
    expect(w2.terminate).toHaveBeenCalledOnce()
  })
})
