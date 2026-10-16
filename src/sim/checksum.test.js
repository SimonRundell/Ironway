import { describe, expect, it } from 'vitest'
import { checksum } from './checksum.js'

describe('checksum', () => {
  it('is a 16-character lowercase hex string', () => {
    const result = checksum({ a: 1 })
    expect(result).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic for the same input', () => {
    const state = { pop: 1000, name: 'Testford', stock: { coal: 12.5, grain: 0 } }
    expect(checksum(state)).toBe(checksum(state))
  })

  it('does not depend on object key order', () => {
    const a = { pop: 1000, name: 'Testford' }
    const b = { name: 'Testford', pop: 1000 }
    expect(checksum(a)).toBe(checksum(b))
  })

  it('changes when the data changes', () => {
    const a = checksum({ pop: 1000 })
    const b = checksum({ pop: 1001 })
    expect(a).not.toBe(b)
  })

  it('distinguishes nested structure from a flattened equivalent', () => {
    const a = checksum({ a: { b: 1 } })
    const b = checksum({ 'a.b': 1 })
    expect(a).not.toBe(b)
  })

  it('handles typed arrays', () => {
    const a = checksum(new Int16Array([1, -2, 3]))
    const b = checksum(new Int16Array([1, -2, 3]))
    const c = checksum(new Int16Array([1, -2, 4]))

    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('distinguishes typed array element type for the same numeric values', () => {
    const a = checksum(new Int16Array([1, 2, 3]))
    const b = checksum(new Uint8Array([1, 2, 3]))
    expect(a).not.toBe(b)
  })

  it('handles a realistic mixed world-state fixture', () => {
    const world = {
      meta: { seed: 'ironway-001', generatorVersion: 1 },
      elev: new Int16Array([10, 20, -5, 300]),
      water: new Uint8Array([0, 0, 1, 2]),
      settlements: [
        { id: 0, name: 'Capital', kind: 'capital', pop: 300000 },
        { id: 1, name: 'Eastport', kind: 'city', pop: 60000 },
      ],
    }

    const a = checksum(world)
    const b = checksum(world)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('rejects values it cannot serialise', () => {
    expect(() => checksum({ fn: () => {} })).toThrow(TypeError)
  })
})
