import { describe, expect, it, vi } from 'vitest'
import { createSimWorkerClient } from './simWorkerClient.js'

/**
 * A fake worker: records what it was asked to do and lets the test
 * decide when (and whether) it "replies" or "crashes", instead of a
 * real `Worker` which needs a browser — the same convention
 * `render/tileWorkerPool.test.js` already uses.
 *
 * @returns {{postMessage: Function, terminate: Function, reply: (data: object) => void, crash: (message: string) => void, messages: object[]}}
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
    crash(message) {
      worker.onerror({ message })
    },
  }
  return worker
}

describe('createSimWorkerClient', () => {
  it('posts an init message with every field of the given payload', () => {
    const worker = fakeWorker()
    const client = createSimWorkerClient({ createWorker: () => worker })

    const payload = { world: { a: 1 }, gameState: { b: 2 }, rules: { c: 3 }, seed: 'ironway-001', gameDay: 0, speed: 1 }
    client.init(payload)

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'init', ...payload })
  })

  it('forwards setSpeed, setHidden, requestSnapshot and debugAction as their own message types', () => {
    const worker = fakeWorker()
    const client = createSimWorkerClient({ createWorker: () => worker })

    client.setSpeed(2)
    client.setHidden(true)
    client.requestSnapshot()
    client.debugAction({ type: 'addStock', settlementId: 1, cargoId: 'coal', qty: 10 })

    expect(worker.messages).toEqual([
      { type: 'setSpeed', speed: 2 },
      { type: 'setHidden', hidden: true },
      { type: 'snapshot' },
      { type: 'debugAction', action: { type: 'addStock', settlementId: 1, cargoId: 'coal', qty: 10 } },
    ])
  })

  it('routes an incoming step message to onStep with just the gameDay', () => {
    const worker = fakeWorker()
    const onStep = vi.fn()
    createSimWorkerClient({ createWorker: () => worker, onStep })

    worker.reply({ type: 'step', gameDay: 42 })

    expect(onStep).toHaveBeenCalledWith(42)
  })

  it('routes an incoming dirty message to onDirty with the full patch', () => {
    const worker = fakeWorker()
    const onDirty = vi.fn()
    createSimWorkerClient({ createWorker: () => worker, onDirty })

    const patch = { type: 'dirty', gameDay: 30, settlements: [], industries: [], links: [], economyState: {}, company: {}, historyMonthlyNew: [], eventsLogNew: [] }
    worker.reply(patch)

    expect(onDirty).toHaveBeenCalledWith(patch)
  })

  it('routes an incoming snapshot message to onSnapshot with gameDay and gameState separated', () => {
    const worker = fakeWorker()
    const onSnapshot = vi.fn()
    createSimWorkerClient({ createWorker: () => worker, onSnapshot })

    const gameState = { settlements: [] }
    worker.reply({ type: 'snapshot', gameDay: 99, gameState })

    expect(onSnapshot).toHaveBeenCalledWith(99, gameState)
  })

  it('routes a caught in-worker error message to onError', () => {
    const worker = fakeWorker()
    const onError = vi.fn()
    createSimWorkerClient({ createWorker: () => worker, onError })

    worker.reply({ type: 'error', message: 'something went wrong' })

    expect(onError).toHaveBeenCalledWith('something went wrong')
  })

  it('reports a whole-worker crash (via onerror) to onError too, same as a caught error message', () => {
    const worker = fakeWorker()
    const onError = vi.fn()
    createSimWorkerClient({ createWorker: () => worker, onError })

    worker.crash('sim worker crashed')

    expect(onError).toHaveBeenCalledWith('sim worker crashed')
  })

  it('falls back to a generic message when a crash event carries none', () => {
    const worker = fakeWorker()
    const onError = vi.fn()
    createSimWorkerClient({ createWorker: () => worker, onError })

    worker.onerror({})

    expect(onError).toHaveBeenCalledWith('sim worker crashed')
  })

  it('destroy() terminates the underlying worker', () => {
    const worker = fakeWorker()
    const client = createSimWorkerClient({ createWorker: () => worker })

    client.destroy()

    expect(worker.terminate).toHaveBeenCalled()
  })
})
