import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSetting, setSetting } from './settings.js'

/**
 * A minimal in-memory stand-in for the browser's `localStorage` (this
 * project's test suite runs under plain Node, not jsdom — confirmed by
 * `src/api/client.js`'s own equally untested-under-Node `localStorage`
 * calls — so there is no real `Storage` global to spy on here).
 *
 * @returns {Storage}
 */
function fakeLocalStorage() {
  const store = new Map()
  return {
    getItem: vi.fn((key) => (store.has(key) ? store.get(key) : null)),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    removeItem: vi.fn((key) => store.delete(key)),
    clear: vi.fn(() => store.clear()),
  }
}

describe('settings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('returns the default when a key has never been set', () => {
    expect(getSetting('seasonsEnabled', true)).toBe(true)
    expect(getSetting('seasonsEnabled', false)).toBe(false)
  })

  it('round-trips a value through setSetting/getSetting', () => {
    setSetting('seasonsEnabled', false)
    expect(getSetting('seasonsEnabled', true)).toBe(false)
  })

  it('namespaces keys so they cannot collide with unrelated localStorage usage', () => {
    setSetting('seasonsEnabled', true)
    expect(localStorage.getItem('seasonsEnabled')).toBeNull()
    expect(localStorage.getItem('ironway.settings.seasonsEnabled')).toBe('true')
  })

  it('falls back to the default when the stored value is corrupt JSON', () => {
    localStorage.setItem('ironway.settings.seasonsEnabled', '{not json')
    expect(getSetting('seasonsEnabled', true)).toBe(true)
  })

  it('falls back to the default when localStorage itself throws (private browsing cap, etc.)', () => {
    localStorage.getItem.mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(getSetting('seasonsEnabled', 'fallback')).toBe('fallback')
  })

  it('setSetting swallows a localStorage write failure instead of throwing', () => {
    localStorage.setItem.mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => setSetting('seasonsEnabled', true)).not.toThrow()
  })
})
