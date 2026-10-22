import { useEffect, useRef } from 'react'

/**
 * The minimap (PHASES.md T2.12, DESIGN 9.8: "minimap with viewport
 * rectangle"). A small canvas showing the island's land/sea silhouette
 * (sampled once from `world.grid.water` at a coarse stride — cheap and
 * cached, since the shape never changes) and every settlement as a dot
 * (also static), redrawn from a cached bitmap every frame with only the
 * camera's own viewport rectangle actually recomputed live. Dragging
 * (or a single click) on it pans the main camera straight there via
 * `MapView`'s own `setCamera()` imperative method — PHASES.md's own
 * Done-when: "the minimap viewport rectangle tracks the camera and is
 * draggable".
 *
 * @module ui/play/Minimap
 */

const WIDTH = 220
const HEIGHT = 130
/** @type {number} Grid-cell stride when sampling the land/sea silhouette — the minimap is tiny, so every cell would be wasted detail. */
const SAMPLE_STRIDE = 2

/**
 * @param {object} props
 * @param {object} props.grid `World.grid`.
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} props.bounds Island bounds, in miles.
 * @param {import('../../sim/state.js').Settlement[]} props.settlements
 * @param {import('react').RefObject<object>} props.mapViewRef `MapView`'s own ref, for `getCamera()`/`getViewport()`/`setCamera()`.
 * @returns {JSX.Element}
 */
export default function Minimap({ grid, bounds, settlements, mapViewRef }) {
  const canvasRef = useRef(null)
  const bitmapRef = useRef(null)
  const draggingRef = useRef(false)

  /** @returns {{scale: number, offsetX: number, offsetY: number}} The uniform world-miles-to-minimap-pixels transform, centred within `WIDTH`x`HEIGHT`. */
  function layout() {
    const worldWidth = bounds.maxX - bounds.minX
    const worldHeight = bounds.maxY - bounds.minY
    const scale = Math.min(WIDTH / worldWidth, HEIGHT / worldHeight)
    const offsetX = (WIDTH - worldWidth * scale) / 2
    const offsetY = (HEIGHT - worldHeight * scale) / 2
    return { scale, offsetX, offsetY }
  }

  /** @param {number} x @param {number} y @returns {{x: number, y: number}} World miles to minimap canvas pixels. */
  function worldToMinimap(x, y) {
    const { scale, offsetX, offsetY } = layout()
    return { x: offsetX + (x - bounds.minX) * scale, y: offsetY + (y - bounds.minY) * scale }
  }

  /** @param {number} px @param {number} py @returns {{x: number, y: number}} Minimap canvas pixels to world miles. */
  function minimapToWorld(px, py) {
    const { scale, offsetX, offsetY } = layout()
    return { x: bounds.minX + (px - offsetX) / scale, y: bounds.minY + (py - offsetY) / scale }
  }

  // Builds the cached land/sea + settlement-dot bitmap once per world
  // (grid and settlement positions never change identity — only
  // population, which this silhouette doesn't need).
  useEffect(() => {
    const bitmapCanvas = document.createElement('canvas')
    bitmapCanvas.width = WIDTH
    bitmapCanvas.height = HEIGHT
    const ctx = bitmapCanvas.getContext('2d')

    ctx.fillStyle = '#3b6a86'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)

    ctx.fillStyle = '#9c8a6a'
    for (let gy = 0; gy < grid.height; gy += SAMPLE_STRIDE) {
      for (let gx = 0; gx < grid.width; gx += SAMPLE_STRIDE) {
        const i = gy * grid.width + gx
        if (grid.water[i] !== 0) continue
        const { x, y } = worldToMinimap(gx * grid.cellMiles, gy * grid.cellMiles)
        ctx.fillRect(x, y, 1.5, 1.5)
      }
    }

    ctx.fillStyle = '#fff8ee'
    for (const settlement of settlements) {
      const { x, y } = worldToMinimap(settlement.x, settlement.y)
      ctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5)
    }

    bitmapRef.current = bitmapCanvas
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, settlements])

  // The viewport rectangle is the only genuinely live part — a small
  // rAF loop here is the cheapest way to track a camera that lives in
  // `MapView`'s own ref and changes on every pan/zoom frame, without
  // `MapView` having to broadcast every change to a listener.
  useEffect(() => {
    let rafId = null

    function frame() {
      const canvas = canvasRef.current
      const bitmap = bitmapRef.current
      const camera = mapViewRef.current?.getCamera()
      const viewport = mapViewRef.current?.getViewport()
      if (canvas && bitmap) {
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, WIDTH, HEIGHT)
        ctx.drawImage(bitmap, 0, 0)

        if (camera && viewport && camera.ppm > 0) {
          const halfWorldWidth = viewport.width / 2 / camera.ppm
          const halfWorldHeight = viewport.height / 2 / camera.ppm
          const topLeft = worldToMinimap(camera.x - halfWorldWidth, camera.y - halfWorldHeight)
          const bottomRight = worldToMinimap(camera.x + halfWorldWidth, camera.y + halfWorldHeight)
          ctx.strokeStyle = '#ffd966'
          ctx.lineWidth = 1.5
          ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
        }
      }
      rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)

    return () => cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** @param {import('react').PointerEvent} event @returns {void} */
  function panToEvent(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    const worldPoint = minimapToWorld(event.clientX - rect.left, event.clientY - rect.top)
    const camera = mapViewRef.current?.getCamera()
    if (camera) mapViewRef.current.setCamera({ x: worldPoint.x, y: worldPoint.y, ppm: camera.ppm })
  }

  /** @param {import('react').PointerEvent} event @returns {void} */
  function onPointerDown(event) {
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = true
    panToEvent(event)
  }

  /** @param {import('react').PointerEvent} event @returns {void} */
  function onPointerMove(event) {
    if (draggingRef.current) panToEvent(event)
  }

  /** @param {import('react').PointerEvent} event @returns {void} */
  function onPointerUp(event) {
    event.currentTarget.releasePointerCapture(event.pointerId)
    draggingRef.current = false
  }

  return (
    <canvas
      ref={canvasRef}
      className="hud-minimap"
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label="Minimap: drag to pan the main view"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}
