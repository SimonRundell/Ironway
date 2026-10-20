/**
 * Tile addressing (PHASES.md T2.03, DESIGN 9.4): a pyramid of 512 px
 * tiles, one level per `ppm` doubling between `camera.js`'s zoom
 * range. Pure functions only — no canvas, no worker, no cache — so the
 * maths that decides which tiles exist and which are on screen can be
 * tested without a browser.
 *
 * @module render/tiles
 */

import { MAX_PPM, MIN_PPM } from './camera.js'

/** @type {number} DESIGN 9.4's tile size, in pixels, per side. */
export const TILE_PIXELS = 512

/**
 * Builds the tile pyramid's zoom levels: `minPpm`, doubled, up to and
 * including `maxPpm` (DESIGN 9.4: "zoom levels aligned to ppm steps of
 * 2x"). With the shipped range (1.5 to 96) this is seven levels:
 * 1.5, 3, 6, 12, 24, 48, 96.
 *
 * @param {number} [minPpm]
 * @param {number} [maxPpm]
 * @returns {number[]} Ascending list of level ppm values.
 */
export function buildTileLevels(minPpm = MIN_PPM, maxPpm = MAX_PPM) {
  const levels = []
  let ppm = minPpm
  while (ppm < maxPpm) {
    levels.push(ppm)
    ppm *= 2
  }
  levels.push(maxPpm)
  return levels
}

/**
 * Picks the pyramid level for a camera's current zoom: the smallest
 * level whose own ppm is at least the camera's, so a tile is never
 * drawn larger than its native resolution (only ever slightly
 * downscaled). Clamps to the top level once the camera exceeds it.
 *
 * @param {number} ppm Camera pixels-per-mile.
 * @param {number[]} levels From `buildTileLevels()`.
 * @returns {number} Index into `levels`.
 */
export function levelIndexForPpm(ppm, levels) {
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] >= ppm) return i
  }
  return levels.length - 1
}

/**
 * @param {number} levelPpm
 * @param {number} [tilePixels]
 * @returns {number} World-mile length of one tile's side at this level.
 */
export function tileWorldSize(levelPpm, tilePixels = TILE_PIXELS) {
  return tilePixels / levelPpm
}

/**
 * @param {number} level
 * @param {number} tileX
 * @param {number} tileY
 * @returns {string}
 */
export function tileKey(level, tileX, tileY) {
  return `${level}:${tileX}:${tileY}`
}

/**
 * @param {string} key From `tileKey()`.
 * @returns {{level: number, tileX: number, tileY: number}}
 */
export function parseTileKey(key) {
  const [level, tileX, tileY] = key.split(':').map(Number)
  return { level, tileX, tileY }
}

/**
 * The tile directly above this one in the pyramid: half the index,
 * one level coarser (standard power-of-two tile-pyramid parentage).
 * `>>` is a 32-bit arithmetic shift, which floor-divides correctly
 * even for negative tile indices (tiles west or north of the origin).
 *
 * @param {string} key
 * @returns {string|null} `null` for a level-0 key, which has no parent.
 */
export function parentTileKey(key) {
  const { level, tileX, tileY } = parseTileKey(key)
  if (level <= 0) return null
  return tileKey(level - 1, tileX >> 1, tileY >> 1)
}

/**
 * @param {number} worldCoordinate
 * @param {number} tileSizeMiles
 * @returns {number} The tile index containing this world coordinate.
 */
export function worldToTileIndex(worldCoordinate, tileSizeMiles) {
  return Math.floor(worldCoordinate / tileSizeMiles)
}

/**
 * The tiles a camera needs right now (DESIGN 9.4/T2.03's own "request
 * prioritisation"): every tile actually on screen, plus a one-tile
 * ring of neighbours just outside it so panning has a head start on
 * the next tiles before they are visible.
 *
 * @param {import('./projection.js').Camera} camera
 * @param {import('./projection.js').Viewport} viewport
 * @param {{visibleWorldPolygon: Function}} projection
 * @param {number[]} levels From `buildTileLevels()`.
 * @param {{tilePixels?: number, ringSize?: number}} [options]
 * @returns {{levelIndex: number, levelPpm: number, visible: string[], neighbours: string[]}}
 */
export function visibleTiles(camera, viewport, projection, levels, { tilePixels = TILE_PIXELS, ringSize = 1 } = {}) {
  const levelIndex = levelIndexForPpm(camera.ppm, levels)
  const levelPpm = levels[levelIndex]
  const tileSize = tileWorldSize(levelPpm, tilePixels)

  const corners = projection.visibleWorldPolygon(camera, viewport)
  const minX = Math.min(...corners.map((c) => c.x))
  const maxX = Math.max(...corners.map((c) => c.x))
  const minY = Math.min(...corners.map((c) => c.y))
  const maxY = Math.max(...corners.map((c) => c.y))

  const innerMinX = worldToTileIndex(minX, tileSize)
  const innerMaxX = worldToTileIndex(maxX, tileSize)
  const innerMinY = worldToTileIndex(minY, tileSize)
  const innerMaxY = worldToTileIndex(maxY, tileSize)

  const visible = []
  for (let ty = innerMinY; ty <= innerMaxY; ty++) {
    for (let tx = innerMinX; tx <= innerMaxX; tx++) {
      visible.push(tileKey(levelIndex, tx, ty))
    }
  }

  const visibleSet = new Set(visible)
  const neighbours = []
  for (let ty = innerMinY - ringSize; ty <= innerMaxY + ringSize; ty++) {
    for (let tx = innerMinX - ringSize; tx <= innerMaxX + ringSize; tx++) {
      const key = tileKey(levelIndex, tx, ty)
      if (!visibleSet.has(key)) neighbours.push(key)
    }
  }

  return { levelIndex, levelPpm, visible, neighbours }
}
