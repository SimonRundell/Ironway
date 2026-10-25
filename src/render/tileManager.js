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
import { buildCoastlineSdf } from './terrain/coastlineSdf.js'
import { buildRiverFields } from './terrain/riverField.js'
import { buildLanduseColourLookup } from './terrain/sampleTerrain.js'
import { createTileWorkerPool } from './tileWorkerPool.js'
import { TILE_PIXELS, buildTileLevels, parentTileKey, parseTileKey, tileWorldSize, visibleTiles } from './tiles.js'

/** @type {number} RGBA bytes per pixel, for sizing the cache's byte accounting. */
const BYTES_PER_PIXEL = 4

/**
 * Builds the one-time payload every tile worker needs to paint real
 * terrain (PHASES.md T2.04/T2.05): the grid layers a pixel sampler
 * reads from, the coastline SDF and river distance/half-width fields
 * (all built once here, not per worker, since they are the same for
 * every worker and every tile), a land-use colour lookup, and
 * `landuseEnum` itself (needed at render time to key fine land cover
 * off the land-use class name, not just its colour). Plain data and
 * typed arrays only, so it structured-clones cleanly to each worker.
 *
 * @param {{grid: object, landuseEnum: string[], palette: object}} world
 * @returns {object} Spread into each worker's `{type: 'init', ...}` message.
 */
function buildWorldInitPayload({ grid, landuseEnum, palette }) {
  const { riverDistance, riverHalfWidth } = buildRiverFields(grid, palette.riverWidth)
  return {
    width: grid.width,
    height: grid.height,
    cellMiles: grid.cellMiles,
    elev: grid.elev,
    landuse: grid.landuse,
    soil: grid.soil,
    rain: grid.rain,
    sdf: buildCoastlineSdf(grid),
    riverDistance,
    riverHalfWidth,
    landuseColours: buildLanduseColourLookup(landuseEnum, palette.landuse),
    landuseEnum,
    palette,
  }
}

/**
 * @param {object} [options]
 * @param {number[]} [options.levels] From `buildTileLevels()`.
 * @param {number} [options.tilePixels]
 * @param {number} [options.capacityBytes]
 * @param {number} [options.workerCount]
 * @param {Function} [options.createWorker] Forwarded to `tileWorkerPool.js`; only ever overridden in tests.
 * @param {{grid: object, landuseEnum: string[], palette: object}} [options.world] PHASES.md T2.04: a fully generated world grid plus the rules a terrain sampler needs (`terrain.json`'s `landuseEnum`, `palette.json`). Omitted when no world has loaded yet — every worker then falls back to its own placeholder renderer, matching T2.03's behaviour exactly.
 * @param {() => void} [options.onDirty] Called whenever a requested tile arrives, so the caller can mark its render loop dirty.
 * @param {(key: string|null, message: string) => void} [options.onError]
 * @returns {{ensureVisible: Function, getDrawable: Function, cache: object, setSeason: (enabled: boolean, monthIndex: number) => void, destroy: () => void}}
 */
export function createTileManager({
  levels = buildTileLevels(),
  tilePixels = TILE_PIXELS,
  capacityBytes = 200 * 1024 * 1024,
  workerCount = 2,
  createWorker,
  world,
  onDirty,
  onError,
} = {}) {
  const cache = createTileLruCache({ capacityBytes })
  const pool = createTileWorkerPool({
    workerCount,
    createWorker,
    initPayload: world ? buildWorldInitPayload(world) : undefined,
    onTile: (key, bitmap) => {
      cache.set(key, bitmap, tilePixels * tilePixels * BYTES_PER_PIXEL)
      onDirty?.()
    },
    onError,
  })

  // PHASES.md T2.13: which calendar month (if any) terrain tiles should
  // render seasonal colour for. Starts disabled so every existing
  // caller that never calls `setSeason()` sees no behaviour change at
  // all — tile requests simply never carry a `monthIndex`.
  let season = { enabled: false, monthIndex: 0 }

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
      monthIndex: season.enabled ? season.monthIndex : undefined,
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

    /**
     * Updates which calendar month (if any) terrain tiles should render
     * seasonal colour for (PHASES.md T2.13: HUD toggle + the sim's
     * current month). A cached tile's bitmap already has last month's
     * (or no) season baked into its pixels — `requestTile()`'s own
     * `cache.has(key)` check means it is never re-requested on its own,
     * so an actual change here clears the whole cache once, forcing
     * every tile the camera currently needs to be redrawn with the new
     * season; calling this with the same `enabled`/`monthIndex` as last
     * time (the common case: once per frame, from `MapView`'s own
     * per-frame draw) is a no-op, not a redraw.
     *
     * @param {boolean} enabled
     * @param {number} monthIndex 0-based calendar month (0 = January). Ignored when `enabled` is `false`.
     * @returns {void}
     */
    setSeason(enabled, monthIndex) {
      const next = { enabled, monthIndex: enabled ? monthIndex : 0 }
      if (next.enabled === season.enabled && next.monthIndex === season.monthIndex) return
      season = next
      cache.clear()
    },

    /** @returns {void} */
    destroy() {
      pool.destroy()
      cache.clear()
    },
  }
}
