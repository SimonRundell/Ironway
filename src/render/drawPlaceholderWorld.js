import { drawIndustriesLayer } from './industries.js'
import { drawNetworkLayer } from './network.js'
import { topDownProjection } from './projection.js'
import { drawSettlementsLayer } from './settlements.js'
import { TILE_PIXELS, tileWorldSize } from './tiles.js'

/**
 * `MapView`'s own per-frame draw call (DESIGN 9.3's four canvas
 * layers), kept here rather than inline in the component because none
 * of it is a React concern: it is pure canvas drawing against plain
 * `<canvas>` elements, camera and tile-manager values. T2.02 drew a
 * flat placeholder world; T2.03 added real tile drawing (including
 * the "placeholder blurred parent tile" fallback), T2.04 made the
 * tiles themselves real terrain (`render/terrain/sampleTerrain.js`,
 * via `workers/tileWorker.js`) whenever a world was loaded, and T2.06
 * added the network layer (roads, rail, sea lanes) to the overlay
 * canvas, on top of its existing debug grid, and T2.07 added the
 * settlements layer (region blobs, footprints, procedural buildings)
 * to the dynamic canvas, and T2.08 added the industries layer (one
 * sprite per industry, smoke/wheels/glow by activity) right after it,
 * both ahead of the origin marker — this function's
 * own job stays the same either way: blit whatever the tile manager
 * has, real or placeholder, and draw whatever overlay/dynamic/label
 * content a loaded world provides. The flat sea fill below only ever
 * shows through a genuine hole, before any tile (or any cached
 * ancestor) has arrived yet. Later tasks add further layers one at a
 * time; the function's shape (one pass per canvas layer) stays the
 * same.
 *
 * @module render/drawPlaceholderWorld
 */

/** @type {number} World-mile spacing of the placeholder overlay grid. */
const GRID_STEP_MILES = 10
/** @type {number} A tile counts as a "hole" (DESIGN 9.4/T2.03's own Done-when) once it has gone this long with nothing at all to draw, not even a placeholder ancestor. */
const HOLE_THRESHOLD_MS = 150

/**
 * @param {object} options
 * @param {number} options.timestampMs The render loop's own frame timestamp.
 * @param {{terrain: HTMLCanvasElement, overlay: HTMLCanvasElement, dynamic: HTMLCanvasElement, labels: HTMLCanvasElement}} options.canvases
 * @param {import('./projection.js').Camera} options.camera
 * @param {import('./projection.js').Viewport} options.viewport
 * @param {ReturnType<import('./tileManager.js').createTileManager>} options.tileManager
 * @param {Map<string, number>} options.holeSince Tile key to the timestamp it first had nothing to draw. Mutated in place; the caller owns its lifetime.
 * @param {{maxMs: number}} options.holeStats Mutated in place: the largest hole duration seen so far, for the caller's own debug readout.
 * @param {import('../sim/state.js').Link[]} [options.links] PHASES.md T2.06: drawn on the overlay layer when a world has loaded. Omitted (the default, no-world placeholder view) draws no network at all.
 * @param {object} [options.palette] The validated `palette.json` rules, needed for the network and settlements layers' styling. Required whenever `links` or `settlements` is given.
 * @param {import('../sim/state.js').Settlement[]} [options.settlements] PHASES.md T2.07: drawn on the dynamic layer when a world has loaded. Omitted draws no settlements at all.
 * @param {{id: string}[]} [options.classesRules] `classes.json`'s `classes` array, needed for the settlements layer's class-mix colouring. Required whenever `settlements` is given.
 * @param {Map<number, Map<number, {bornAt: number, removedAt: number|null}>>} [options.settlementLifecycle] Settlement building fade/abandon tracking (DESIGN 9.5), mutated in place; the caller owns its lifetime, the same convention as `holeSince`. Required whenever `settlements` is given.
 * @param {import('../sim/state.js').Industry[]} [options.industries] PHASES.md T2.08: drawn on the dynamic layer, after settlements, when a world has loaded. Omitted draws no industries at all.
 * @param {number} [options.gameDay] The sim's current day, for the industries layer's construction/derelict lifecycle look. Required whenever `industries` is given.
 * @returns {void}
 */
export function drawPlaceholderWorld({ timestampMs, canvases, camera, viewport, tileManager, holeSince, holeStats, links, palette, settlements, classesRules, settlementLifecycle, industries, gameDay }) {
  const { levelPpm, visible } = tileManager.ensureVisible(camera, viewport, topDownProjection)
  const tileSize = tileWorldSize(levelPpm)

  const terrainCtx = canvases.terrain.getContext('2d')
  terrainCtx.save()
  terrainCtx.setTransform(1, 0, 0, 1, 0, 0)
  // Canvas fillStyle cannot read a CSS custom property directly; this
  // matches index.css's --colour-sea by value instead. Only ever shows
  // through a genuine hole (DESIGN 9.4's own Done-when): every tile
  // draws something, real or an upscaled cached ancestor, the moment
  // any ancestor exists at all.
  terrainCtx.fillStyle = '#5f8fa6'
  terrainCtx.fillRect(0, 0, canvases.terrain.width, canvases.terrain.height)
  terrainCtx.imageSmoothingEnabled = true

  for (const key of visible) {
    const drawable = tileManager.getDrawable(key)
    if (!drawable) {
      if (!holeSince.has(key)) holeSince.set(key, timestampMs)
      const openMs = timestampMs - holeSince.get(key)
      if (openMs > holeStats.maxMs) {
        holeStats.maxMs = openMs
        if (openMs > HOLE_THRESHOLD_MS) {
          console.warn(`[MapView] tile ${key} has been a hole for ${openMs.toFixed(0)}ms (DESIGN 9.4's budget is ${HOLE_THRESHOLD_MS}ms)`)
        }
      }
      continue
    }
    holeSince.delete(key)

    const [, tx, ty] = key.split(':').map(Number)
    const worldOrigin = { x: tx * tileSize, y: ty * tileSize }
    const screenOrigin = topDownProjection.worldToScreen(camera, viewport, worldOrigin)
    const screenSize = tileSize * camera.ppm

    if (drawable.levelsUp === 0) {
      terrainCtx.drawImage(drawable.bitmap, screenOrigin.x, screenOrigin.y, screenSize, screenSize)
    } else {
      // The cached bitmap is an ancestor covering 2^levelsUp times this
      // tile's area (DESIGN 9.4's "placeholder blurred parent tile"):
      // crop out just this tile's own sub-region of it and stretch
      // that up, rather than squashing the whole ancestor in, which
      // would show the wrong, zoomed-out content.
      const subdivisions = 2 ** drawable.levelsUp
      const floorMod = (n, m) => ((n % m) + m) % m
      const subX = floorMod(tx, subdivisions)
      const subY = floorMod(ty, subdivisions)
      const sourceSize = TILE_PIXELS / subdivisions
      terrainCtx.drawImage(
        drawable.bitmap,
        subX * sourceSize, subY * sourceSize, sourceSize, sourceSize,
        screenOrigin.x, screenOrigin.y, screenSize, screenSize,
      )
    }
  }
  terrainCtx.restore()

  const overlayCtx = canvases.overlay.getContext('2d')
  overlayCtx.save()
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0)
  overlayCtx.clearRect(0, 0, canvases.overlay.width, canvases.overlay.height)
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

  if (links && palette) {
    drawNetworkLayer({ ctx: overlayCtx, camera, viewport, projection: topDownProjection, links, palette })
  }
  overlayCtx.restore()

  // The origin marker is billboarded (DESIGN 9.2.1, confirmed by the
  // T2.00 spike): its position is projected, but it is drawn with the
  // canvas transform at identity so a future sheared projection could
  // never distort the icon itself.
  const dynamicCtx = canvases.dynamic.getContext('2d')
  dynamicCtx.save()
  dynamicCtx.setTransform(1, 0, 0, 1, 0, 0)
  dynamicCtx.clearRect(0, 0, canvases.dynamic.width, canvases.dynamic.height)

  if (settlements && classesRules && palette) {
    drawSettlementsLayer({
      ctx: dynamicCtx,
      camera,
      viewport,
      projection: topDownProjection,
      settlements,
      classesRules,
      settlementRules: palette.settlements,
      lifecycleMap: settlementLifecycle,
      nowMs: timestampMs,
    })
  }

  if (industries && palette) {
    drawIndustriesLayer({
      ctx: dynamicCtx,
      camera,
      viewport,
      projection: topDownProjection,
      industries,
      industriesRules: palette.industries,
      gameDay: gameDay ?? 0,
      nowMs: timestampMs,
    })
  }

  const originScreen = topDownProjection.worldToScreen(camera, viewport, { x: 0, y: 0 })
  dynamicCtx.fillStyle = '#ffd966'
  dynamicCtx.beginPath()
  dynamicCtx.arc(originScreen.x, originScreen.y, 6, 0, Math.PI * 2)
  dynamicCtx.fill()
  dynamicCtx.restore()

  const labelsCtx = canvases.labels.getContext('2d')
  labelsCtx.save()
  labelsCtx.setTransform(1, 0, 0, 1, 0, 0)
  labelsCtx.clearRect(0, 0, canvases.labels.width, canvases.labels.height)
  labelsCtx.fillStyle = '#fff8ee'
  labelsCtx.font = '12px sans-serif'
  labelsCtx.fillText('Origin (0, 0)', originScreen.x + 10, originScreen.y + 4)
  labelsCtx.restore()
}
