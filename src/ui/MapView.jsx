import { useEffect, useRef } from 'react'
import { fitToIsland, panByScreenDelta, stepInertia, zoomAtPoint, zoomByWheel } from '../render/camera.js'
import { topDownProjection } from '../render/projection.js'
import { createRenderLoop, resizeCanvasForDpr } from '../render/renderLoop.js'

/**
 * The Phase 2 canvas stack (PHASES.md T2.02, DESIGN 9.3): four stacked
 * canvases (terrain, static overlays, dynamic world, labels) plus a
 * React/DOM HUD slot on top. Camera state lives in a ref, never React
 * state, and every pointer/wheel/keyboard handler mutates that ref and
 * calls the render loop's `markDirty()` instead of `setState` — so
 * panning, zooming and inertia never trigger a React re-render, only
 * canvas redraws. `src/render/camera.js` and `projection.js` do every
 * piece of screen maths; this component only wires browser events to
 * them and draws.
 *
 * T2.02 itself only proves the pipeline with a blank placeholder world
 * (a flat sea colour, a coarse mile grid, and a marker at the world
 * origin). Real terrain (T2.03/T2.04), the network layer (T2.06) and
 * settlement sprites (T2.07) replace the placeholder draw calls layer
 * by layer in later tasks without changing anything here.
 *
 * @module ui/MapView
 */

/** @type {number} Screen pixels an arrow-key press pans by. */
const KEY_PAN_PIXELS = 80
/** @type {number} Multiplicative zoom step for +/- keys. */
const KEY_ZOOM_FACTOR = 1.4
/** @type {number} Exponential decay rate per second for drag inertia. */
const INERTIA_FRICTION = 4
/** @type {number} Screen pixels per second below which inertia stops. */
const INERTIA_STOP_SPEED = 2
/** @type {number} World-mile spacing of the placeholder grid. */
const GRID_STEP_MILES = 10

/**
 * @param {object} props
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} [props.bounds] Island bounds, in miles, for the initial fit-to-island and Home key. Defaults to a 100x100 mile placeholder square.
 * @param {boolean} [props.showDebugStats] Shows a small renders/frames counter, for T2.02's own "no React re-render per frame" verification. Not meant to stay on by default once T2.12 builds the real HUD.
 * @param {import('react').ReactNode} [props.children] Rendered in the HUD slot, above the canvases, as plain DOM/React.
 * @returns {JSX.Element}
 */
export default function MapView({
  bounds = { minX: -50, minY: -50, maxX: 50, maxY: 50 },
  showDebugStats = false,
  children,
}) {
  const containerRef = useRef(null)
  const terrainRef = useRef(null)
  const overlayRef = useRef(null)
  const dynamicRef = useRef(null)
  const labelsRef = useRef(null)
  const debugRef = useRef(null)

  const cameraRef = useRef(null)
  const viewportRef = useRef({ width: 0, height: 0 })
  const dragRef = useRef(null)
  const inertiaRef = useRef(null)
  const statsRef = useRef({ renders: 0, frames: 0 })
  const markDirtyRef = useRef(null)

  // Counts React renders of this component. Should stop climbing after
  // mount: every interaction below mutates refs and redraws canvases
  // without ever calling setState.
  statsRef.current.renders += 1

  useEffect(() => {
    const container = containerRef.current
    const canvases = [terrainRef.current, overlayRef.current, dynamicRef.current, labelsRef.current]

    cameraRef.current = fitToIsland(
      { width: container.clientWidth || 800, height: container.clientHeight || 600 },
      bounds,
    )

    /** @param {number} timestampMs @returns {void} */
    function draw(timestampMs) {
      if (inertiaRef.current) {
        const dt = Math.min(0.05, (timestampMs - inertiaRef.current.lastTimestampMs) / 1000)
        inertiaRef.current.lastTimestampMs = timestampMs
        const result = stepInertia(cameraRef.current, viewportRef.current, inertiaRef.current.velocity, dt, topDownProjection, INERTIA_FRICTION)
        cameraRef.current = result.camera
        inertiaRef.current.velocity = result.velocity
        if (Math.hypot(result.velocity.x, result.velocity.y) < INERTIA_STOP_SPEED) {
          inertiaRef.current = null
        } else {
          loop.markDirty()
        }
      }

      statsRef.current.frames += 1
      const camera = cameraRef.current
      const viewport = viewportRef.current

      const terrainCtx = terrainRef.current.getContext('2d')
      terrainCtx.save()
      terrainCtx.setTransform(1, 0, 0, 1, 0, 0)
      // Canvas fillStyle cannot read a CSS custom property directly;
      // this matches index.css's --colour-sea by value instead.
      terrainCtx.fillStyle = '#5f8fa6'
      terrainCtx.fillRect(0, 0, terrainRef.current.width, terrainRef.current.height)
      terrainCtx.restore()

      const overlayCanvas = overlayRef.current
      const overlayCtx = overlayCanvas.getContext('2d')
      overlayCtx.save()
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0)
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
      overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
      overlayCtx.lineWidth = 1
      const corners = topDownProjection.visibleWorldPolygon(camera, viewport)
      const minX = Math.min(...corners.map((c) => c.x))
      const maxX = Math.max(...corners.map((c) => c.x))
      const minY = Math.min(...corners.map((c) => c.y))
      const maxY = Math.max(...corners.map((c) => c.y))
      overlayCtx.beginPath()
      for (let x = Math.floor(minX / GRID_STEP_MILES) * GRID_STEP_MILES; x <= maxX; x += GRID_STEP_MILES) {
        const top = topDownProjection.worldToScreen(camera, viewport, { x, y: minY })
        const bottom = topDownProjection.worldToScreen(camera, viewport, { x, y: maxY })
        overlayCtx.moveTo(top.x, top.y)
        overlayCtx.lineTo(bottom.x, bottom.y)
      }
      for (let y = Math.floor(minY / GRID_STEP_MILES) * GRID_STEP_MILES; y <= maxY; y += GRID_STEP_MILES) {
        const left = topDownProjection.worldToScreen(camera, viewport, { x: minX, y })
        const right = topDownProjection.worldToScreen(camera, viewport, { x: maxX, y })
        overlayCtx.moveTo(left.x, left.y)
        overlayCtx.lineTo(right.x, right.y)
      }
      overlayCtx.stroke()
      overlayCtx.restore()

      // The origin marker is billboarded (DESIGN 9.2.1, confirmed by
      // the T2.00 spike): its position is projected, but it is drawn
      // with the canvas transform at identity so a future sheared
      // projection could never distort the icon itself.
      const dynamicCanvas = dynamicRef.current
      const dynamicCtx = dynamicCanvas.getContext('2d')
      dynamicCtx.save()
      dynamicCtx.setTransform(1, 0, 0, 1, 0, 0)
      dynamicCtx.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height)
      const originScreen = topDownProjection.worldToScreen(camera, viewport, { x: 0, y: 0 })
      dynamicCtx.fillStyle = '#ffd966'
      dynamicCtx.beginPath()
      dynamicCtx.arc(originScreen.x, originScreen.y, 6, 0, Math.PI * 2)
      dynamicCtx.fill()
      dynamicCtx.restore()

      const labelsCanvas = labelsRef.current
      const labelsCtx = labelsCanvas.getContext('2d')
      labelsCtx.save()
      labelsCtx.setTransform(1, 0, 0, 1, 0, 0)
      labelsCtx.clearRect(0, 0, labelsCanvas.width, labelsCanvas.height)
      labelsCtx.fillStyle = '#fff8ee'
      labelsCtx.font = '12px sans-serif'
      labelsCtx.fillText('Origin (0, 0)', originScreen.x + 10, originScreen.y + 4)
      labelsCtx.restore()

      if (debugRef.current) {
        debugRef.current.textContent = `renders: ${statsRef.current.renders} / frames: ${statsRef.current.frames} / ppm: ${camera.ppm.toFixed(1)}`
      }
    }

    const loop = createRenderLoop({ render: draw })
    markDirtyRef.current = loop.markDirty
    loop.start()

    /** @returns {void} */
    function resize() {
      const width = container.clientWidth
      const height = container.clientHeight
      viewportRef.current = { width, height }
      for (const canvas of canvases) {
        resizeCanvasForDpr(canvas, width, height)
      }
      loop.markDirty()
    }
    resize()
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)

    /** @param {WheelEvent} event @returns {void} */
    function onWheel(event) {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      cameraRef.current = zoomByWheel(cameraRef.current, viewportRef.current, screenPoint, event.deltaY, topDownProjection)
      loop.markDirty()
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      resizeObserver.disconnect()
      container.removeEventListener('wheel', onWheel)
      loop.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** @param {import('react').PointerEvent} event @returns {void} */
  function onPointerDown(event) {
    event.currentTarget.setPointerCapture(event.pointerId)
    inertiaRef.current = null
    dragRef.current = { lastX: event.clientX, lastY: event.clientY, lastTimeMs: performance.now(), velocity: { x: 0, y: 0 } }
  }

  /** @param {import('react').PointerEvent} event @returns {void} */
  function onPointerMove(event) {
    const drag = dragRef.current
    if (!drag) return
    const nowMs = performance.now()
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    const dtSeconds = Math.max(0.001, (nowMs - drag.lastTimeMs) / 1000)
    drag.velocity = { x: dx / dtSeconds, y: dy / dtSeconds }
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    drag.lastTimeMs = nowMs
    cameraRef.current = panByScreenDelta(cameraRef.current, viewportRef.current, { x: dx, y: dy }, topDownProjection)
    loopMarkDirty()
  }

  /** @param {import('react').PointerEvent} event @returns {void} */
  function onPointerUp(event) {
    event.currentTarget.releasePointerCapture(event.pointerId)
    const velocity = dragRef.current?.velocity ?? { x: 0, y: 0 }
    dragRef.current = null
    if (Math.hypot(velocity.x, velocity.y) > INERTIA_STOP_SPEED) {
      inertiaRef.current = { velocity, lastTimestampMs: performance.now() }
      loopMarkDirty()
    }
  }

  /** @param {import('react').KeyboardEvent} event @returns {void} */
  function onKeyDown(event) {
    if (!cameraRef.current) return
    const viewport = viewportRef.current
    const centre = { x: viewport.width / 2, y: viewport.height / 2 }
    switch (event.key) {
      case 'ArrowLeft':
        cameraRef.current = panByScreenDelta(cameraRef.current, viewport, { x: KEY_PAN_PIXELS, y: 0 }, topDownProjection)
        break
      case 'ArrowRight':
        cameraRef.current = panByScreenDelta(cameraRef.current, viewport, { x: -KEY_PAN_PIXELS, y: 0 }, topDownProjection)
        break
      case 'ArrowUp':
        cameraRef.current = panByScreenDelta(cameraRef.current, viewport, { x: 0, y: KEY_PAN_PIXELS }, topDownProjection)
        break
      case 'ArrowDown':
        cameraRef.current = panByScreenDelta(cameraRef.current, viewport, { x: 0, y: -KEY_PAN_PIXELS }, topDownProjection)
        break
      case '+':
      case '=':
        cameraRef.current = zoomAtPoint(cameraRef.current, viewport, centre, cameraRef.current.ppm * KEY_ZOOM_FACTOR, topDownProjection)
        break
      case '-':
        cameraRef.current = zoomAtPoint(cameraRef.current, viewport, centre, cameraRef.current.ppm / KEY_ZOOM_FACTOR, topDownProjection)
        break
      case 'Home':
        cameraRef.current = fitToIsland(viewport, bounds)
        break
      default:
        return
    }
    event.preventDefault()
    inertiaRef.current = null
    loopMarkDirty()
  }

  /** The render loop is created inside the mount effect; this indirection lets event handlers reach it without a second ref. @returns {void} */
  function loopMarkDirty() {
    markDirtyRef.current?.()
  }

  return (
    <div
      ref={containerRef}
      className="map-view"
      tabIndex={0}
      role="application"
      aria-label="Island map: drag to pan, wheel to zoom, arrow keys to pan, plus and minus to zoom, Home to fit the island"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <canvas ref={terrainRef} className="map-view-layer" />
      <canvas ref={overlayRef} className="map-view-layer" />
      <canvas ref={dynamicRef} className="map-view-layer" />
      <canvas ref={labelsRef} className="map-view-layer" />
      <div className="map-view-hud">
        {showDebugStats && <div ref={debugRef} className="map-view-debug-stats" />}
        {children}
      </div>
    </div>
  )
}
