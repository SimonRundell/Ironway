/**
 * Ties tile addressing, the worker pool and the LRU cache together
 * (PHASES.md T2.03, DESIGN 9.4) into the one thing a renderer actually
 * needs each frame: "what tiles does the camera need, and what do I
 * draw for each one right now". `getDrawable()` is DESIGN 9.4's
 * "placeholder blurred parent tile while loading": if a tile itself
 * isn't cached yet, it walks up the pyramid to the nearest cached
 * ancestor instead of returning nothing, so a caller scaling that
 * bitmap up to the child's footprint never shows a blank hole.
 *
 * @module render/tileManager
 */

import { createTileLruCache } from './tileCache.js'
import { createTileWorkerPool } from './tileWorkerPool.js'
import { TILE_PIXELS, buildTileLevels, parentTileKey, parseTileKey, tileWorldSize, visibleTiles } from './tiles.js'

/** @type {number} RGBA bytes per pixel, for sizing the cache's byte accounting. */
const BYTES_PER_PIXEL = 4

/**
 * @param {object} [options]
 * @param {number[]} [options.levels] From `buildTileLevels()`.
 * @param {number} [options.tilePixels]
 * @param {number} [options.capacityBytes]
 * @param {number} [options.workerCount]
 * @param {Function} [options.createWorker] Forwarded to `tileWorkerPool.js`; only ever overridden in tests.
 * @param {() => void} [options.onDirty] Called whenever a requested tile arrives, so the caller can mark its render loop dirty.
 * @param {(key: string|null, message: string) => void} [options.onError]
 * @returns {{ensureVisible: Function, getDrawable: Function, cache: object, destroy: () => void}}
 */
export function createTileManager({
  levels = buildTileLevels(),
  tilePixels = TILE_PIXELS,
  capacityBytes = 200 * 1024 * 1024,
  workerCount = 2,
  createWorker,
  onDirty,
  onError,
} = {}) {
  const cache = createTileLruCache({ capacityBytes })
  const pool = createTileWorkerPool({
    workerCount,
    createWorker,
    onTile: (key, bitmap) => {
      cache.set(key, bitmap, tilePixels * tilePixels * BYTES_PER_PIXEL)
      onDirty?.()
    },
    onError,
  })

  /**
   * @param {string} key
   * @param {number} levelPpm
   * @param {number} priority
   * @returns {void}
   */
  function requestTile(key, levelPpm, priority) {
    if (cache.has(key)) return
    const { level, tileX, tileY } = parseTileKey(key)
    pool.request(key, {
      type: 'render',
      key,
      level,
      tileX,
      tileY,
      tileWorldSize: tileWorldSize(levelPpm, tilePixels),
      tilePixels,
    }, priority)
  }

  return {
    /**
     * Call once per frame the terrain layer needs to redraw. Requests
     * whatever the camera needs that isn't cached yet (visible tiles
     * at priority 0, the neighbour ring at priority 1) and returns the
     * addressing result so the caller knows what to actually draw.
     *
     * @param {import('./projection.js').Camera} camera
     * @param {import('./projection.js').Viewport} viewport
     * @param {{visibleWorldPolygon: Function}} projection
     * @returns {{levelIndex: number, levelPpm: number, visible: string[], neighbours: string[]}}
     */
    ensureVisible(camera, viewport, projection) {
      const result = visibleTiles(camera, viewport, projection, levels, { tilePixels })
      for (const key of result.visible) requestTile(key, result.levelPpm, 0)
      for (const key of result.neighbours) requestTile(key, result.levelPpm, 1)
      return result
    },

    /**
     * The best available bitmap for a tile: itself if cached, else the
     * nearest cached ancestor, scaled up by the caller (DESIGN 9.4's
     * placeholder-while-loading).
     *
     * @param {string} key
     * @returns {{key: string, bitmap: *, levelsUp: number}|null} `null` only when no ancestor at any level is cached yet (a true, hopefully brief, hole).
     */
    getDrawable(key) {
      let current = key
      let levelsUp = 0
      while (current !== null) {
        const bitmap = cache.get(current)
        if (bitmap) return { key: current, bitmap, levelsUp }
        current = parentTileKey(current)
        levelsUp += 1
      }
      return null
    },

    cache,

    /** @returns {void} */
    destroy() {
      pool.destroy()
      cache.clear()
    },
  }
}
