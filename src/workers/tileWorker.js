import { hashString } from '../sim/rng.js'

/**
 * The tile render worker (PHASES.md T2.03, DESIGN 9.4): runs off the
 * main thread so painting a tile never blocks input or the render
 * loop. T2.03 builds the pipeline only — this worker's own draw call
 * is a deterministic placeholder (a colour block, the tile's own
 * address, and a border), not real terrain, so the pipeline (worker
 * pool, `ImageBitmap` transfer, caching, the blurred-parent-tile
 * fallback) can be proven end to end. T2.04 replaces the body of this
 * function with real per-pixel terrain; nothing else in the pipeline
 * changes.
 *
 * Message protocol: receives `{type: 'render', key, level, tileX,
 * tileY, tilePixels}`, replies with exactly one of `{type: 'tile',
 * key, bitmap}` (bitmap transferred, not copied) or `{type: 'error',
 * key, message}`.
 *
 * @module workers/tileWorker
 */

self.onmessage = (event) => {
  const { type, key, level, tileX, tileY, tilePixels } = event.data
  if (type !== 'render') return

  try {
    const canvas = new OffscreenCanvas(tilePixels, tilePixels)
    const ctx = canvas.getContext('2d')

    // A deterministic colour per tile (DESIGN 4.5: no Math.random),
    // purely so adjacent and ancestor tiles are visibly distinguishable
    // while verifying the pipeline — this has no bearing on the real
    // terrain colours T2.04 will paint here instead.
    const hue = hashString(key) % 360
    ctx.fillStyle = `hsl(${hue}, 45%, ${32 + level * 6}%)`
    ctx.fillRect(0, 0, tilePixels, tilePixels)

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, tilePixels - 2, tilePixels - 2)

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.font = `${Math.round(tilePixels / 16)}px sans-serif`
    ctx.fillText(`${level}:${tileX}:${tileY}`, tilePixels * 0.08, tilePixels * 0.14)

    const bitmap = canvas.transferToImageBitmap()
    self.postMessage({ type: 'tile', key, bitmap }, [bitmap])
  } catch (err) {
    self.postMessage({ type: 'error', key, message: err.message })
  }
}
