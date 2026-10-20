import { hashString } from '../sim/rng.js'
import { sampleTerrainPixel } from '../render/terrain/sampleTerrain.js'

/**
 * The tile render worker (PHASES.md T2.03/T2.04, DESIGN 9.4): runs off
 * the main thread so painting a tile never blocks input or the render
 * loop.
 *
 * Message protocol: an optional `{type: 'init', ...}` message (the
 * grid layers, coastline SDF, land-use colours and palette from
 * `tileManager.js`'s `buildWorldInitPayload()`) may arrive once,
 * before any render request, and is kept in this module's own state
 * for every subsequent `render` message this worker receives. Render
 * requests are `{type: 'render', key, level, tileX, tileY,
 * tileWorldSize, tilePixels}`; the reply is exactly one of `{type:
 * 'tile', key, bitmap}` (bitmap transferred, not copied) or `{type:
 * 'error', key, message}`.
 *
 * Without an `init` message (no world loaded yet, or a test pool that
 * never sends one), a tile renders as a deterministic placeholder — a
 * colour block, the tile's own address, and a border — exactly as
 * T2.03 shipped it, so the pipeline (worker pool, `ImageBitmap`
 * transfer, caching, the blurred-parent-tile fallback) stays provable
 * end to end even before a save loads.
 *
 * @module workers/tileWorker
 */

/** @type {object|null} Set once by an `init` message; read by every later `render`. */
let world = null

/**
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {{key: string, level: number, tileX: number, tileY: number, tilePixels: number}} request
 * @returns {void}
 */
function renderPlaceholderTile(ctx, { key, level, tileX, tileY, tilePixels }) {
  // A deterministic colour per tile (DESIGN 4.5: no Math.random),
  // purely so adjacent and ancestor tiles are visibly distinguishable
  // while verifying the pipeline — this has no bearing on the real
  // terrain colours rendered once a world has loaded.
  const hue = hashString(key) % 360
  ctx.fillStyle = `hsl(${hue}, 45%, ${32 + level * 6}%)`
  ctx.fillRect(0, 0, tilePixels, tilePixels)

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, tilePixels - 2, tilePixels - 2)

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.font = `${Math.round(tilePixels / 16)}px sans-serif`
  ctx.fillText(`${level}:${tileX}:${tileY}`, tilePixels * 0.08, tilePixels * 0.14)
}

/**
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {{tileX: number, tileY: number, tileWorldSize: number, tilePixels: number}} request
 * @returns {void}
 */
function renderRealTerrainTile(ctx, { tileX, tileY, tileWorldSize, tilePixels }) {
  const grid = { width: world.width, height: world.height, cellMiles: world.cellMiles, elev: world.elev, landuse: world.landuse, soil: world.soil, rain: world.rain }
  const worldOriginX = tileX * tileWorldSize
  const worldOriginY = tileY * tileWorldSize

  const image = ctx.createImageData(tilePixels, tilePixels)
  for (let py = 0; py < tilePixels; py++) {
    const worldY = worldOriginY + ((py + 0.5) / tilePixels) * tileWorldSize
    for (let px = 0; px < tilePixels; px++) {
      const worldX = worldOriginX + ((px + 0.5) / tilePixels) * tileWorldSize
      const { r, g, b } = sampleTerrainPixel({
        grid, sdf: world.sdf, worldX, worldY, landuseColours: world.landuseColours, palette: world.palette,
      })
      const i = (py * tilePixels + px) * 4
      image.data[i] = r
      image.data[i + 1] = g
      image.data[i + 2] = b
      image.data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}

self.onmessage = (event) => {
  const { type } = event.data

  if (type === 'init') {
    world = event.data
    return
  }
  if (type !== 'render') return

  const { key, level, tileX, tileY, tileWorldSize, tilePixels } = event.data

  try {
    const canvas = new OffscreenCanvas(tilePixels, tilePixels)
    const ctx = canvas.getContext('2d')

    if (world) {
      renderRealTerrainTile(ctx, { tileX, tileY, tileWorldSize, tilePixels })
    } else {
      renderPlaceholderTile(ctx, { key, level, tileX, tileY, tilePixels })
    }

    const bitmap = canvas.transferToImageBitmap()
    self.postMessage({ type: 'tile', key, bitmap }, [bitmap])
  } catch (err) {
    self.postMessage({ type: 'error', key, message: err.message })
  }
}
