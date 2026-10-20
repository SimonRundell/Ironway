// T2.00 projection spike (PHASES.md, DESIGN 9.2.1). Throwaway: outside
// src/, not part of the React app, and nothing here is imported by src/.
// Generates ironway-001, paints land use to an offscreen canvas, and
// draws it two ways (top-down, 2:1 isometric) using a plain affine
// matrix, with links, settlements and a handful of small sprites
// overlaid, to settle which projection T2.01 onward should build on.

import { loadRulesBrowser } from '../../src/sim/rules.js'
import { generateWorld } from '../../src/sim/mapgen/world.js'

const SEED = 'ironway-001'
const DIFFICULTY = 'normal'

/** @type {Record<string, number>} Zoom bands (DESIGN 9.2), one representative ppm per band. */
const BAND_PPM = { region: 3, area: 8, local: 24, detail: 60 }

const SPRITE_FILES = {
  cottage1: 'assets/cottage-1.png',
  cottage2: 'assets/cottage-2.png',
  industry1: 'assets/industry-1.png',
  industry2: 'assets/industry-2.png',
  train: 'assets/train.png',
  wagon: 'assets/wagon.png',
}
const SPRITE_WORLD_SIZE = 0.6 // miles, so sprites scale with zoom like any other world object

const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')
const statusEl = document.getElementById('status')
const statsEl = document.getElementById('stats')
const projectionSelect = document.getElementById('projection')
const bandSelect = document.getElementById('band')
const runPanButton = document.getElementById('runPan')

/** @returns {void} Keeps the canvas filling the window, redrawing on resize. */
function resize() {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  draw()
}
window.addEventListener('resize', resize)

/** @param {string} hex e.g. "#3b6a86". @returns {[number, number, number]} */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Paints the whole grid's land use to an offscreen canvas, one pixel per
 * cell, in world-aligned (cell) space. Drawn once; every frame just
 * transforms and blits this bitmap, matching DESIGN 9.2.1's "terrain
 * tiles are rendered in world-aligned space... only placed on screen
 * through tileTransform".
 *
 * @param {object} grid
 * @param {string[]} landuseEnum terrain.json's landuseEnum, index-matched to grid.landuse values.
 * @param {Record<string, string>} landuseColors palette.json's landuse colours, by name.
 * @returns {HTMLCanvasElement}
 */
function paintTerrain(grid, landuseEnum, landuseColors) {
  const offscreen = document.createElement('canvas')
  offscreen.width = grid.width
  offscreen.height = grid.height
  const octx = offscreen.getContext('2d')
  const image = octx.createImageData(grid.width, grid.height)
  const rgbCache = new Map()
  for (let i = 0; i < grid.width * grid.height; i++) {
    const name = landuseEnum[grid.landuse[i]] ?? 'rock'
    let rgb = rgbCache.get(name)
    if (!rgb) {
      rgb = hexToRgb(landuseColors[name] ?? '#888888')
      rgbCache.set(name, rgb)
    }
    image.data[i * 4] = rgb[0]
    image.data[i * 4 + 1] = rgb[1]
    image.data[i * 4 + 2] = rgb[2]
    image.data[i * 4 + 3] = 255
  }
  octx.putImageData(image, 0, 0)
  return offscreen
}

/**
 * The whole point of the spike: a plain affine matrix per projection: a
 * zoom-only top-down matrix, and a 2:1 isometric shear.
 *
 * @param {'topdown'|'iso'} projection
 * @param {number} ppm Pixels per world mile.
 * @returns {{a: number, b: number, c: number, d: number}}
 */
function matrixFor(projection, ppm) {
  if (projection === 'iso') return { a: ppm, b: ppm * 0.5, c: -ppm, d: ppm * 0.5 }
  return { a: ppm, b: 0, c: 0, d: ppm }
}

/** @returns {{x: number, y: number}} Screen origin for world (0,0) under this matrix and camera. */
function originFor(matrix, camera, width, height) {
  return {
    x: width / 2 - (matrix.a * camera.x + matrix.c * camera.y),
    y: height / 2 - (matrix.b * camera.x + matrix.d * camera.y),
  }
}

/** @returns {[number, number]} World miles projected to a screen point, for billboarded (un-sheared) draws. */
function project(matrix, origin, wx, wy) {
  return [origin.x + matrix.a * wx + matrix.c * wy, origin.y + matrix.b * wx + matrix.d * wy]
}

let world = null
let rules = null
let terrainCanvas = null
let sprites = {}
const camera = { x: 0, y: 0, ppm: BAND_PPM.area }

/** @returns {void} Draws one frame at the current camera/projection/band. */
function draw() {
  if (!world) return
  const projection = projectionSelect.value
  const matrix = matrixFor(projection, camera.ppm)
  const origin = originFor(matrix, camera, canvas.width, canvas.height)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = rules.palette.landuse.sea
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Terrain: the offscreen bitmap is in cell space, so its own matrix
  // is the mile matrix scaled by cellMiles (cells -> miles -> screen).
  ctx.imageSmoothingEnabled = false
  const cellMiles = world.grid.cellMiles
  ctx.setTransform(matrix.a * cellMiles, matrix.b * cellMiles, matrix.c * cellMiles, matrix.d * cellMiles, origin.x, origin.y)
  ctx.drawImage(terrainCanvas, 0, 0)

  // Links: straight polylines stay correct under the full affine
  // transform (a line through a linear map is still a line), so these
  // are drawn with the transform active, in world miles.
  ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, origin.x, origin.y)
  for (const link of world.links) {
    const colour = link.mode === 'sea' ? rules.palette.seaLane
      : link.mode === 'rail' ? (rules.palette.railByTier[link.tier] ?? '#444')
      : (rules.palette.roadByTier[link.tier] ?? '#888')
    ctx.strokeStyle = colour
    ctx.lineWidth = Math.max(0.02, 0.06 / (camera.ppm / 8))
    ctx.beginPath()
    link.path.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    ctx.stroke()
  }

  // Settlements and sprites are billboarded: their *position* goes
  // through the projection, but they are drawn screen-aligned so an
  // isometric shear never distorts the icon artwork itself. A real
  // iso game billboards sprites for exactly this reason; this spike
  // exists partly to surface that requirement for T2.01/T2.07.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  for (const settlement of world.settlements) {
    const [sx, sy] = project(matrix, origin, settlement.x, settlement.y)
    const radius = settlement.kind === 'capital' ? 6 : settlement.kind === 'city' ? 5 : settlement.kind === 'town' ? 3.5 : 2.2
    ctx.fillStyle = settlement.kind === 'capital' ? '#ffd966' : '#eee'
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.fill()
  }

  const spriteSizePx = SPRITE_WORLD_SIZE * camera.ppm
  for (const placement of spritePlacements) {
    const img = sprites[placement.sprite]
    if (!img || !img.complete) continue
    const [sx, sy] = project(matrix, origin, placement.x, placement.y)
    ctx.drawImage(img, sx - spriteSizePx / 2, sy - spriteSizePx / 2, spriteSizePx, spriteSizePx)
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

let spritePlacements = []

/** @returns {void} Picks real settlements/industries/a link midpoint to anchor the 6 sprites on. */
function placeSprites() {
  const openIndustries = world.industries.filter((i) => i.closedDay === null)
  const villages = world.settlements.filter((s) => s.kind === 'village' || s.kind === 'hamlet')
  const placements = []
  if (villages[0]) placements.push({ sprite: 'cottage1', x: villages[0].x, y: villages[0].y })
  if (villages[1]) placements.push({ sprite: 'cottage2', x: villages[1].x, y: villages[1].y })
  if (openIndustries[0]) placements.push({ sprite: 'industry1', x: openIndustries[0].x, y: openIndustries[0].y })
  if (openIndustries[1]) placements.push({ sprite: 'industry2', x: openIndustries[1].x, y: openIndustries[1].y })
  const railLink = world.links.find((l) => l.mode === 'rail' && l.path.length > 1) ?? world.links.find((l) => l.path.length > 1)
  if (railLink) {
    const mid = railLink.path[Math.floor(railLink.path.length / 2)]
    placements.push({ sprite: 'train', x: mid[0], y: mid[1] })
    const near = railLink.path[Math.max(0, Math.floor(railLink.path.length / 2) - 2)]
    placements.push({ sprite: 'wagon', x: near[0], y: near[1] })
  }
  spritePlacements = placements
}

/** @returns {Promise<void>} Loads the six sprite PNGs. */
async function loadSprites() {
  const entries = await Promise.all(Object.entries(SPRITE_FILES).map(([key, src]) => new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve([key, img])
    img.src = src
  })))
  sprites = Object.fromEntries(entries)
}

/** @returns {void} Centres the camera on the capital (falling back to the grid centre). */
function centreCamera() {
  const capital = world.settlements.find((s) => s.kind === 'capital')
  if (capital) {
    camera.x = capital.x
    camera.y = capital.y
  } else {
    camera.x = (world.grid.width * world.grid.cellMiles) / 2
    camera.y = (world.grid.height * world.grid.cellMiles) / 2
  }
}

bandSelect.addEventListener('change', () => {
  camera.ppm = BAND_PPM[bandSelect.value]
  draw()
})
projectionSelect.addEventListener('change', draw)

/**
 * Scripted pan (Done-when: "record frame time during a scripted pan"):
 * sweeps the camera across the island for ~3 seconds at the current
 * band/projection, recording each frame's delta time.
 *
 * @returns {void}
 */
function runScriptedPan() {
  const durationMs = 3000
  const startX = camera.x
  const sweepMiles = (world.grid.width * world.grid.cellMiles) * 0.3
  const start = performance.now()
  const frameTimes = []
  let last = start

  function frame(now) {
    frameTimes.push(now - last)
    last = now
    const t = (now - start) / durationMs
    if (t >= 1) {
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
      const max = Math.max(...frameTimes)
      statsEl.textContent = `scripted pan: ${frameTimes.length} frames, avg ${avg.toFixed(2)}ms (${(1000 / avg).toFixed(0)} fps), worst ${max.toFixed(2)}ms`
      console.log('[T2.00 spike] scripted pan', { projection: projectionSelect.value, band: bandSelect.value, frames: frameTimes.length, avgMs: avg, maxMs: max })
      camera.x = startX
      draw()
      return
    }
    camera.x = startX + Math.sin(t * Math.PI * 2) * sweepMiles
    draw()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
runPanButton.addEventListener('click', runScriptedPan)

async function main() {
  statusEl.textContent = `loading rules...`
  rules = await loadRulesBrowser()
  statusEl.textContent = `generating ${SEED}...`
  await loadSprites()
  const t0 = performance.now()
  world = generateWorld(SEED, DIFFICULTY, rules).world
  const genMs = performance.now() - t0
  terrainCanvas = paintTerrain(world.grid, rules.terrain.landuseEnum, rules.palette.landuse)
  centreCamera()
  placeSprites()
  resize()
  statusEl.textContent = `${SEED}: ${world.settlements.length} settlements, ${world.industries.length} industries, ${world.links.length} links, generated in ${genMs.toFixed(0)}ms`
}

main().catch((err) => {
  statusEl.textContent = `error: ${err.message}`
  console.error(err)
})
