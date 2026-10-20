import { useEffect, useRef, useState } from 'react'
import { MAX_PPM, MIN_PPM, fitToIsland, panByScreenDelta, stepInertia, zoomAtPoint, zoomByWheel } from '../render/camera.js'
import { drawPlaceholderWorld } from '../render/drawPlaceholderWorld.js'
import { topDownProjection } from '../render/projection.js'
import { createRenderLoop, resizeCanvasForDpr } from '../render/renderLoop.js'
import { createTileManager } from '../render/tileManager.js'

/**
 * The Phase 2 canvas stack (PHASES.md T2.02, DESIGN 9.3): four stacked
 * canvases (terrain, static overlays, dynamic world, labels) plus a
 * React/DOM HUD slot on top. Camera state lives in a ref, never React
 * state, and every pointer/wheel/keyboard handler mutates that ref and
 * calls the render loop's `markDirty()` instead of `setState` — so
 * panning, zooming and inertia never trigger a React re-render, only
 * canvas redraws. This component only wires browser events (pointer,
 * wheel, keyboard, resize) to `render/camera.js`; the actual per-frame
 * drawing is `render/drawPlaceholderWorld.js` (T2.03 adds the tile
 * pipeline on top of T2.02's flat placeholder), kept out of this file
 * since it is canvas logic, not a React concern.
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
/** @type {number} Length of the scripted pan-and-zoom stress test (T2.03's own Done-when names a 5-minute scripted run; this is a shorter, interactively-triggered version of the same sweep — see DECISIONS.md). */
const STRESS_TEST_DURATION_MS = 20000

/**
 * @param {object} props
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} [props.bounds] Island bounds, in miles, for the initial fit-to-island and Home key. Defaults to a 100x100 mile placeholder square.
 * @param {number} [props.tileMemoryCapMb] The tile cache's memory cap (DESIGN 9.4/9.9, `client.json`'s `render.tileMemoryCapMb`). Defaults to that file's own starter value; a real page will eventually pass the loaded value through instead.
 * @param {boolean} [props.showDebugStats] Shows a small renders/frames/cache counter and a tile-pipeline stress-test button, for T2.02/T2.03's own Done-when verification. Not meant to stay on by default once T2.12 builds the real HUD.
 * @param {import('react').ReactNode} [props.children] Rendered in the HUD slot, above the canvases, as plain DOM/React.
 * @returns {JSX.Element}
 */
export default function MapView({
  bounds = { minX: -50, minY: -50, maxX: 50, maxY: 50 },
  tileMemoryCapMb = 200,
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
  const tileManagerRef = useRef(null)
  const holeSinceRef = useRef(new Map())
  const holeStatsRef = useRef({ maxMs: 0 })
  const stressTestRef = useRef(null)

  // Worker errors are rare and exceptional, not a per-frame concern, so
  // unlike camera state this is ordinary React state (DESIGN 9.4's
  // "worker errors surface in the UI").
  const [workerError, setWorkerError] = useState(null)

  // Counts React renders of this component. Should stop climbing after
  // mount: every interaction below mutates refs and redraws canvases
  // without ever calling setState.
  statsRef.current.renders += 1

  useEffect(() => {
    const container = containerRef.current
    const canvasList = [terrainRef.current, overlayRef.current, dynamicRef.current, labelsRef.current]
    const canvases = { terrain: terrainRef.current, overlay: overlayRef.current, dynamic: dynamicRef.current, labels: labelsRef.current }

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
      drawPlaceholderWorld({
        timestampMs,
        canvases,
        camera: cameraRef.current,
        viewport: viewportRef.current,
        tileManager: tileManagerRef.current,
        holeSince: holeSinceRef.current,
        holeStats: holeStatsRef.current,
      })

      if (debugRef.current) {
        const cache = tileManagerRef.current.cache
        const cacheMb = (cache.totalBytes / (1024 * 1024)).toFixed(1)
        const capMb = tileMemoryCapMb.toFixed(0)
        debugRef.current.textContent =
          `renders: ${statsRef.current.renders} / frames: ${statsRef.current.frames} / ppm: ${cameraRef.current.ppm.toFixed(1)}` +
          ` / tiles: ${cache.size} (${cacheMb}/${capMb} MB) / max hole: ${holeStatsRef.current.maxMs.toFixed(0)}ms`
      }
    }

    const loop = createRenderLoop({ render: draw })
    markDirtyRef.current = loop.markDirty
    tileManagerRef.current = createTileManager({
      capacityBytes: tileMemoryCapMb * 1024 * 1024,
      onDirty: () => loop.markDirty(),
      onError: (key, message) => setWorkerError({ key, message, at: Date.now() }),
    })
    loop.start()

    /** @returns {void} */
    function resize() {
      const width = container.clientWidth
      const height = container.clientHeight
      viewportRef.current = { width, height }
      for (const canvas of canvasList) {
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
      tileManagerRef.current?.destroy()
      if (stressTestRef.current) cancelAnimationFrame(stressTestRef.current)
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

  /**
   * Debug-only scripted pan and zoom (T2.03's own Done-when names a
   * 5-minute version of this exact sweep; see DECISIONS.md for why
   * this interactive one runs shorter). Sweeps the camera across the
   * whole island and through every tile zoom level, so the tile
   * pipeline's own debug line (cache size, max hole duration) can be
   * watched settle under sustained churn.
   *
   * @returns {void}
   */
  function runStressTest() {
    if (stressTestRef.current || !cameraRef.current) return
    const startedAt = performance.now()
    const restoreCamera = cameraRef.current
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY
    const centreX = (bounds.minX + bounds.maxX) / 2
    const centreY = (bounds.minY + bounds.maxY) / 2
    const logMinPpm = Math.log(MIN_PPM)
    const logMaxPpm = Math.log(MAX_PPM)

    function tick(now) {
      const t = (now - startedAt) / STRESS_TEST_DURATION_MS
      if (t >= 1) {
        stressTestRef.current = null
        cameraRef.current = restoreCamera
        loopMarkDirty()
        const cache = tileManagerRef.current.cache
        console.log(
          `[MapView] stress test complete: max hole ${holeStatsRef.current.maxMs.toFixed(0)}ms, ` +
          `cache ${cache.size} tiles / ${(cache.totalBytes / (1024 * 1024)).toFixed(1)} of ${tileMemoryCapMb} MB`,
        )
        return
      }
      cameraRef.current = {
        x: centreX + Math.sin(t * Math.PI * 6) * width * 0.4,
        y: centreY + Math.sin(t * Math.PI * 4.5) * height * 0.4,
        ppm: Math.exp(logMinPpm + ((Math.sin(t * Math.PI * 8) + 1) / 2) * (logMaxPpm - logMinPpm)),
      }
      loopMarkDirty()
      stressTestRef.current = requestAnimationFrame(tick)
    }
    stressTestRef.current = requestAnimationFrame(tick)
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
        {showDebugStats && (
          <div className="map-view-debug-stats">
            <div ref={debugRef} />
            <button type="button" onClick={runStressTest}>Run tile pipeline stress test</button>
          </div>
        )}
        {workerError && (
          <div className="map-view-error-banner" role="alert">
            Tile worker error{workerError.key ? ` (${workerError.key})` : ''}: {workerError.message}
            <button type="button" onClick={() => setWorkerError(null)}>Dismiss</button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
