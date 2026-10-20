import { describe, expect, it, vi } from 'vitest'
import { createTileLruCache } from './tileCache.js'

/** @param {string} id @returns {{id: string, close: import('vitest').Mock}} A fake bitmap, standing in for a real `ImageBitmap`. */
function fakeBitmap(id) {
  return { id, close: vi.fn() }
}

describe('createTileLruCache', () => {
  it('stores and retrieves a value', () => {
    const cache = createTileLruCache({ capacityBytes: 1000 })
    const bitmap = fakeBitmap('a')
    cache.set('a', bitmap, 100)
    expect(cache.get('a')).toBe(bitmap)
    expect(cache.has('a')).toBe(true)
    expect(cache.size).toBe(1)
    expect(cache.totalBytes).toBe(100)
  })

  it('returns undefined for a missing key without throwing', () => {
    const cache = createTileLruCache({ capacityBytes: 1000 })
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.has('missing')).toBe(false)
  })

  it('evicts the least-recently-used entry when the cap is exceeded', () => {
    const cache = createTileLruCache({ capacityBytes: 250 })
    cache.set('a', fakeBitmap('a'), 100)
    cache.set('b', fakeBitmap('b'), 100)
    cache.set('c', fakeBitmap('c'), 100) // pushes total to 300 > 250, 'a' (oldest) must go
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.totalBytes).toBeLessThanOrEqual(250)
  })

  it('calls close() on an evicted bitmap', () => {
    const cache = createTileLruCache({ capacityBytes: 150 })
    const a = fakeBitmap('a')
    cache.set('a', a, 100)
    cache.set('b', fakeBitmap('b'), 100) // evicts 'a'
    expect(a.close).toHaveBeenCalledOnce()
  })

  it('reading an entry marks it most-recently-used, protecting it from the next eviction', () => {
    const cache = createTileLruCache({ capacityBytes: 250 })
    cache.set('a', fakeBitmap('a'), 100)
    cache.set('b', fakeBitmap('b'), 100)
    cache.get('a') // 'a' is now more recently used than 'b'
    cache.set('c', fakeBitmap('c'), 100) // must evict 'b', not 'a'
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
  })

  it('never exceeds the cap even under sustained churn (the Done-when "cache stays under cap" guarantee)', () => {
    const cache = createTileLruCache({ capacityBytes: 1000 })
    for (let i = 0; i < 500; i++) {
      cache.set(`tile-${i}`, fakeBitmap(String(i)), 137)
      expect(cache.totalBytes).toBeLessThanOrEqual(1000)
    }
  })

  it('re-setting an existing key replaces it and closes the old value exactly once', () => {
    const cache = createTileLruCache({ capacityBytes: 1000 })
    const first = fakeBitmap('a-v1')
    cache.set('a', first, 100)
    cache.set('a', fakeBitmap('a-v2'), 150)
    expect(first.close).toHaveBeenCalledOnce()
    expect(cache.totalBytes).toBe(150)
    expect(cache.size).toBe(1)
  })

  it('delete() removes an entry, frees its bytes and closes its bitmap', () => {
    const cache = createTileLruCache({ capacityBytes: 1000 })
    const a = fakeBitmap('a')
    cache.set('a', a, 100)
    cache.delete('a')
    expect(cache.has('a')).toBe(false)
    expect(cache.totalBytes).toBe(0)
    expect(a.close).toHaveBeenCalledOnce()
  })

  it('clear() closes every bitmap and resets totals', () => {
    const cache = createTileLruCache({ capacityBytes: 1000 })
    const a = fakeBitmap('a')
    const b = fakeBitmap('b')
    cache.set('a', a, 100)
    cache.set('b', b, 200)
    cache.clear()
    expect(a.close).toHaveBeenCalledOnce()
    expect(b.close).toHaveBeenCalledOnce()
    expect(cache.size).toBe(0)
    expect(cache.totalBytes).toBe(0)
  })

  it('calls onEvict with the evicted key', () => {
    const onEvict = vi.fn()
    const cache = createTileLruCache({ capacityBytes: 100, onEvict })
    cache.set('a', fakeBitmap('a'), 100)
    cache.set('b', fakeBitmap('b'), 100)
    expect(onEvict).toHaveBeenCalledWith('a')
  })

  it('tolerates values with no close() method', () => {
    const cache = createTileLruCache({ capacityBytes: 100 })
    cache.set('a', { id: 'plain' }, 100)
    expect(() => cache.set('b', { id: 'plain2' }, 100)).not.toThrow()
  })
})
