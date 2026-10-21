import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { fitToIsland, panByScreenDelta, stepInertia, zoomAtPoint, zoomByWheel } from '../render/camera.js'
import { createStressTestRunner } from '../render/debugStressTest.js'
import { drawPlaceholderWorld } from '../render/drawPlaceholderWorld.js'
import { findNearestLink } from '../render/network.js'
import { topDownProjection } from '../render/projection.js'
import { createRenderLoop, resizeCanvasForDpr } from '../render/renderLoop.js'
import { createTileManager } from '../render/tileManager.js'

/** @type {number} How close a click has to land to a link, in world miles, to count as a hit (PHASES.md T2.06's own Done-when: "hit testing returns the nearest link under the cursor"). */
const LINK_HIT_TEST_MAX_MILES = 1.5

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

/**
 * @param {object} props
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} [props.bounds] Island bounds, in miles, for the initial fit-to-island and Home key. Defaults to a 100x100 mile placeholder square.
 * @param {{grid: object, landuseEnum: string[], palette: object, links?: import('../sim/state.js').Link[], settlements?: import('../sim/state.js').Settlement[], classesRules?: {id: string}[]}} [props.world] PHASES.md T2.04: a fully generated world (its grid, `terrain.json`'s `landuseEnum`, `palette.json`) to render real terrain for. Omitted by default, which keeps T2.02/T2.03's flat placeholder world (every tile worker falls back to its own placeholder renderer). `links` (PHASES.md T2.06) draws the road/rail/sea-lane network on the overlay layer and enables click-to-hit-test when `showDebugStats` is on; omitted, no network is drawn. `settlements` and `classesRules` (PHASES.md T2.07) draw settlement blobs/footprints/buildings on the dynamic layer; omitted, no settlements are drawn. Settlement objects are read fresh every frame, so mutating them in place (e.g. after `sim/tick.js`'s `runYears()`) and calling the imperative `markDirty()` (see `ref`) picks up the change without a new `world` object.
 * @param {number} [props.tileMemoryCapMb] The tile cache's memory cap (DESIGN 9.4/9.9, `client.json`'s `render.tileMemoryCapMb`). Defaults to that file's own starter value; a real page will eventually pass the loaded value through instead.
 * @param {boolean} [props.showDebugStats] Shows a small renders/frames/cache counter and a tile-pipeline stress-test button, for T2.02/T2.03's own Done-when verification. Not meant to stay on by default once T2.12 builds the real HUD.
 * @param {import('react').ReactNode} [props.children] Rendered in the HUD slot, above the canvases, as plain DOM/React.
 * @param {import('react').Ref<{markDirty: () => void}>} [ref] Lets a caller force a redraw without touching React state (PHASES.md T2.07's own verification need: advancing the sim mutates `world.settlements` in place, which nothing else would tell the render loop about).
 * @returns {JSX.Element}
 */
const MapView = forwardRef(function MapView({
  bounds = { minX: -50, minY: -50, maxX: 50, maxY: 50 },
  world,
  tileMemoryCapMb = 200,
  showDebugStats = false,
  children,
}, ref) {
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
  const settlementLifecycleRef = useRef(new Map())

  // Worker errors are rare and exceptional, not a per-frame concern, so
  // unlike camera state this is ordinary React state (DESIGN 9.4's
  // "worker errors surface in the UI"). The network hit-test result
  // (debug-only, see onPointerUp) is the same kind of rare, click-driven
  // event, not a per-frame value, so it is ordinary state too.
  const [workerError, setWorkerError] = useState(null)
  const [hitLink, setHitLink] = useState(null)

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
        links: world?.links,
        palette: world?.palette,
        settlements: world?.settlements,
        classesRules: world?.classesRules,
        settlementLifecycle: settlementLifecycleRef.current,
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
      world,
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
    dragRef.current = { startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, lastTimeMs: performance.now(), velocity: { x: 0, y: 0 } }
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
    const drag = dragRef.current
    const velocity = drag?.velocity ?? { x: 0, y: 0 }
    dragRef.current = null
    if (Math.hypot(velocity.x, velocity.y) > INERTIA_STOP_SPEED) {
      inertiaRef.current = { velocity, lastTimestampMs: performance.now() }
      loopMarkDirty()
    } else if (drag && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) {
      // A tap/click rather than a drag or flick (PHASES.md T2.06's own
      // Done-when: "hit testing returns the nearest link under the
      // cursor"). Debug-only for now — a real selection UI is T2.12's
      // job — but the hit-testing function itself is exercised here
      // against real screen coordinates, not just in a unit test.
      if (world?.links) {
        const rect = event.currentTarget.getBoundingClientRect()
        const worldPoint = topDownProjection.screenToWorld(cameraRef.current, viewportRef.current, { x: event.clientX - rect.left, y: event.clientY - rect.top })
        setHitLink(findNearestLink(world.links, worldPoint, LINK_HIT_TEST_MAX_MILES))
      }
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

  // Exposes a redraw trigger to whatever ref the caller passed in (see
  // this component's own doc comment on `ref`): the one thing nothing
  // inside this component can know on its own is "a caller mutated
  // `world.settlements` in place and the canvas needs to catch up".
  useImperativeHandle(ref, () => ({ markDirty: loopMarkDirty }))

  // Debug-only scripted pan and zoom (see render/debugStressTest.js for
  // what it does and why it lives there, not here).
  const runStressTest = createStressTestRunner({
    cameraRef, stressTestRef, tileManagerRef, holeStatsRef, bounds, tileMemoryCapMb, markDirty: loopMarkDirty,
  })

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
            {world?.links && (
              <div>
                {hitLink
                  ? `nearest link: ${hitLink.link.mode} tier ${hitLink.link.tier} (${hitLink.distanceMiles.toFixed(2)}mi away)`
                  : 'click a link to hit-test it'}
              </div>
            )}
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
})

export default MapView
