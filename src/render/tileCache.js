/**
 * An LRU cache for rendered tile bitmaps (PHASES.md T2.03, DESIGN
 * 9.4/9.9: "stored in an LRU cache (memory cap in config)", "tile
 * cache under 400 MB"). Tracks total bytes rather than entry count,
 * since every tile is the same pixel size but T2.04 onward may use
 * different formats; evicts the least-recently-used entries whenever
 * a new one pushes the total over the configured cap.
 *
 * Deliberately storage-agnostic: it calls `.close()` on an evicted
 * bitmap if the value has one (real `ImageBitmap`s do, so their GPU
 * memory is freed immediately rather than waiting on GC), but never
 * assumes it beyond that, so tests can use plain objects.
 *
 * @module render/tileCache
 */

/**
 * @param {object} options
 * @param {number} options.capacityBytes
 * @param {(key: string) => void} [options.onEvict]
 * @returns {{get: (key: string) => *, has: (key: string) => boolean, set: (key: string, value: *, bytes: number) => void, delete: (key: string) => void, clear: () => void, totalBytes: number, size: number}}
 */
export function createTileLruCache({ capacityBytes, onEvict } = {}) {
  /** @type {Map<string, {value: *, bytes: number}>} Insertion order doubles as recency order: re-inserting a key on access moves it to the end. */
  const entries = new Map()
  let totalBytes = 0

  /** @param {string} key @returns {void} */
  function markRecentlyUsed(key) {
    const entry = entries.get(key)
    entries.delete(key)
    entries.set(key, entry)
  }

  /** @param {string} key @returns {void} */
  function evict(key) {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    totalBytes -= entry.bytes
    entry.value?.close?.()
    onEvict?.(key)
  }

  return {
    /** @param {string} key @returns {*} */
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      markRecentlyUsed(key)
      return entry.value
    },

    /** @param {string} key @returns {boolean} */
    has(key) {
      return entries.has(key)
    },

    /**
     * @param {string} key
     * @param {*} value
     * @param {number} bytes
     * @returns {void}
     */
    set(key, value, bytes) {
      if (entries.has(key)) evict(key)
      entries.set(key, { value, bytes })
      totalBytes += bytes

      while (totalBytes > capacityBytes && entries.size > 0) {
        const oldestKey = entries.keys().next().value
        evict(oldestKey)
      }
    },

    /** @param {string} key @returns {void} */
    delete(key) {
      evict(key)
    },

    /** @returns {void} */
    clear() {
      for (const key of [...entries.keys()]) evict(key)
    },

    get totalBytes() {
      return totalBytes
    },

    get size() {
      return entries.size
    },
  }
}
