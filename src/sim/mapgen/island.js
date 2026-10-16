/**
 * Generates the island's shape and terrain relief: the domain-warped
 * mask, base elevation, mountain spines, sea-level selection with
 * landmass filtering, and light erosion. DESIGN.md 5.2 steps 1 to 5.
 *
 * @module sim/mapgen/island
 */

import { hashString, int, rngFor } from '../rng.js'
import { fade, fbm2D, ridgedNoise2D } from '../noise.js'
import { indexOf, isInBounds } from './grid.js'

/** @type {readonly [number, number][]} The 8 discrete compass headings a spine can walk in. */
const SPINE_DIRECTIONS = Object.freeze([
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
])

/** @type {readonly [number, number][]} All 8 neighbour offsets, for erosion and flood fill. */
const NEIGHBOUR_OFFSETS_8 = SPINE_DIRECTIONS

/** @type {readonly [number, number][]} The 4 orthogonal neighbour offsets, for flood fill. */
const NEIGHBOUR_OFFSETS_4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

/**
 * Derives an integer seed for a noise field or sub-stream, the same
 * way rngFor keys its random streams.
 *
 * @param {string} seed The save's seed.
 * @param {...(string|number)} keys Further keys naming this field.
 * @returns {number} An unsigned 32-bit integer seed.
 */
function subSeed(seed, ...keys) {
  return hashString([seed, ...keys].join('|'))
}

/**
 * Clamps a value to [min, max].
 *
 * @param {number} value The value to clamp.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped value.
 */
function clamp(value, min, max) {
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Builds the island mask (step 1): a domain-warped ellipse, 1 at the
 * centre fading smoothly to 0 towards the edge, forced fully to 0
 * within the edge margin so land can never reach the grid border.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {{warpStrength: number}} params mapgen.json's islandMask settings.
 * @param {number} marginCells Hard sea margin, in cells.
 * @returns {Float64Array} Mask values in [0, 1], one per cell.
 */
function buildIslandMask(grid, seed, params, marginCells) {
  const { width, height } = grid
  const mask = new Float64Array(width * height)

  const cx = width / 2
  const cy = height / 2
  const rx = width / 2 - marginCells * 1.5
  const ry = height / 2 - marginCells * 1.5
  const warpStrengthCells = params.warpStrength * ry
  const warpSeed = subSeed(seed, 'mapgen', 'island-mask-warp')
  const freqX = 1 / width
  const freqY = 1 / height

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)

      if (x < marginCells || x >= width - marginCells || y < marginCells || y >= height - marginCells) {
        mask[i] = 0
        continue
      }

      const warpX = x + warpStrengthCells * (fbm2D(warpSeed, x * freqX, y * freqY, 2, 2, 0.5) * 2 - 1)
      const warpY = y + warpStrengthCells * (fbm2D(warpSeed + 1, x * freqX, y * freqY, 2, 2, 0.5) * 2 - 1)

      const nx = (warpX - cx) / rx
      const ny = (warpY - cy) / ry
      const ellipseDist = Math.sqrt(nx * nx + ny * ny)

      if (ellipseDist <= 0.7) {
        mask[i] = 1
      } else if (ellipseDist >= 1.0) {
        mask[i] = 0
      } else {
        mask[i] = 1 - fade((ellipseDist - 0.7) / 0.3)
      }
    }
  }

  return mask
}

/**
 * Builds base elevation (step 2): fBm noise shaped by the island mask.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {{octaves: number, lacunarity: number, gain: number}} params mapgen.json's elevation settings.
 * @param {Float64Array} mask The island mask from buildIslandMask().
 * @returns {Float64Array} Raw relative height per cell (not yet metres).
 */
function buildBaseElevation(grid, seed, params, mask) {
  const { width, height } = grid
  const heightField = new Float64Array(width * height)
  const elevSeed = subSeed(seed, 'mapgen', 'elevation')
  const freqX = 4 / width
  const freqY = 4 / height

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      heightField[i] = fbm2D(elevSeed, x * freqX, y * freqY, params.octaves, params.lacunarity, params.gain) * mask[i]
    }
  }

  return heightField
}

/**
 * Walks a biased random path across the grid, mostly continuing in its
 * current direction with occasional turns, stopping if it nears the
 * margin or reaches its length budget. Directions are one of 8
 * discrete compass headings rather than an angle, so no trig is
 * needed to turn.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {() => number} rng A stream from rngFor().
 * @param {number} startX Starting x coordinate.
 * @param {number} startY Starting y coordinate.
 * @param {number} marginCells Hard sea margin, in cells; the walk stays clear of 2x this.
 * @returns {[number, number][]} The path, in walk order.
 */
function walkSpine(grid, rng, startX, startY, marginCells) {
  const path = [[startX, startY]]
  let x = startX
  let y = startY
  let dir = int(rng, 0, 7)
  const length = int(rng, 18, 48)
  const clearance = marginCells * 2

  for (let step = 0; step < length; step++) {
    if (rng() > 0.7) {
      dir = (dir + (int(rng, 0, 2) - 1) + 8) % 8
    }

    const [dx, dy] = SPINE_DIRECTIONS[dir]
    const nx = x + dx
    const ny = y + dy

    if (nx < clearance || nx >= grid.width - clearance || ny < clearance || ny >= grid.height - clearance) {
      break
    }

    x = nx
    y = ny
    path.push([x, y])
  }

  return path
}

/**
 * Raises terrain near a spine's path using ridged noise, shaped by a
 * smooth polynomial falloff from the nearest path point and a
 * parabolic profile that peaks at the spine's midpoint. The falloff is
 * a bump function `(1 - d^2)^2`, standing in for a literal Gaussian:
 * DESIGN.md 4.5 asks for curves to be built from exact arithmetic or
 * polynomial approximations rather than calling Math.exp, which can
 * differ in its last bit between JS engines.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {number} spineIndex Index of this spine, for seed decorrelation.
 * @param {Float64Array} heightField Raw height, mutated in place.
 * @param {[number, number][]} path The spine's walked path.
 * @param {number} influenceRadius How far the ridge's influence reaches, in cells.
 * @returns {void}
 */
function applyRidgeAlongSpine(grid, seed, spineIndex, heightField, path, influenceRadius) {
  if (path.length === 0) {
    return
  }

  const ridgeSeed = subSeed(seed, 'mapgen', 'mountains', 'ridge', spineIndex)
  const profileRng = rngFor(seed, 'mapgen', 'mountains', 'profile', spineIndex)
  const profile = path.map((_, index) => {
    const t = path.length > 1 ? index / (path.length - 1) : 0.5
    const parabola = 4 * t * (1 - t)
    return parabola * (0.7 + 0.6 * profileRng())
  })

  let minX = path[0][0]
  let maxX = path[0][0]
  let minY = path[0][1]
  let maxY = path[0][1]
  for (const [px, py] of path) {
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }

  const left = Math.max(0, minX - influenceRadius)
  const right = Math.min(grid.width - 1, maxX + influenceRadius)
  const top = Math.max(0, minY - influenceRadius)
  const bottom = Math.min(grid.height - 1, maxY + influenceRadius)

  const freqX = 6 / grid.width
  const freqY = 6 / grid.height

  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      let nearestDist = Infinity
      let nearestProfile = 0

      for (let p = 0; p < path.length; p++) {
        const [px, py] = path[p]
        const dx = x - px
        const dy = y - py
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < nearestDist) {
          nearestDist = dist
          nearestProfile = profile[p]
        }
      }

      if (nearestDist >= influenceRadius) {
        continue
      }

      const normalisedDist = nearestDist / influenceRadius
      const bump = 1 - normalisedDist * normalisedDist
      const falloff = bump * bump
      const ridge = ridgedNoise2D(ridgeSeed, x * freqX, y * freqY, 4, 2, 0.5)
      const i = indexOf(grid, x, y)
      heightField[i] += falloff * ridge * nearestProfile * 2
    }
  }
}

/**
 * Adds mountain ranges (step 3): 2 to 4 spines walked as biased random
 * walks through the highest part of the base elevation, each raising
 * nearby terrain with ridged noise.
 *
 * @param {{width: number, height: number}} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {{spineCountMin: number, spineCountMax: number}} params mapgen.json's mountains settings.
 * @param {Float64Array} heightField Raw height from buildBaseElevation(), mutated in place.
 * @param {number} marginCells Hard sea margin, in cells.
 * @returns {void}
 */
function addMountainRanges(grid, seed, params, heightField, marginCells) {
  const { width, height } = grid
  const rng = rngFor(seed, 'mapgen', 'mountains')
  const spineCount = int(rng, params.spineCountMin, params.spineCountMax)
  const influenceRadius = Math.max(8, Math.floor(Math.min(width, height) * 0.12))
  const clearance = marginCells * 2

  const candidates = []
  for (let y = clearance; y < height - clearance; y++) {
    for (let x = clearance; x < width - clearance; x++) {
      const i = indexOf(grid, x, y)
      if (heightField[i] > 0.55) {
        candidates.push([x, y])
      }
    }
  }

  if (candidates.length === 0) {
    return
  }

  for (let s = 0; s < spineCount; s++) {
    const [startX, startY] = candidates[int(rng, 0, candidates.length - 1)]
    const path = walkSpine(grid, rng, startX, startY, marginCells)
    applyRidgeAlongSpine(grid, seed, s, heightField, path, influenceRadius)
  }
}

/**
 * Finds all 4-connected land components (cells where water === 0).
 * Uses an explicit stack rather than recursion, since a single
 * landmass can be thousands of cells.
 *
 * @param {{width: number, height: number, water: Uint8Array}} grid The world grid.
 * @returns {number[][]} One array of cell indices per connected component.
 */
export function floodFillLandmasses(grid) {
  const { width, height, water } = grid
  const size = width * height
  const visited = new Uint8Array(size)
  const components = []

  for (let start = 0; start < size; start++) {
    if (water[start] !== 0 || visited[start]) {
      continue
    }

    const component = []
    const stack = [start]
    visited[start] = 1

    while (stack.length > 0) {
      const i = stack.pop()
      component.push(i)

      const x = i % width
      const y = Math.floor(i / width)

      for (const [dx, dy] of NEIGHBOUR_OFFSETS_4) {
        const nx = x + dx
        const ny = y + dy
        if (!isInBounds(grid, nx, ny)) continue
        const ni = indexOf(grid, nx, ny)
        if (water[ni] === 0 && !visited[ni]) {
          visited[ni] = 1
          stack.push(ni)
        }
      }
    }

    components.push(component)
  }

  return components
}

/**
 * Selects sea level and filters landmasses (step 4): picks a
 * percentile of the height field so land covers a seed-chosen fraction
 * of the grid within the configured band, keeps only the single
 * largest connected landmass plus a few small islets, and writes the
 * final water and elev layers.
 *
 * @param {object} grid The world grid (water and elev are written).
 * @param {Float64Array} heightField Raw height from the earlier steps.
 * @param {string} seed The save's seed.
 * @param {{landFractionMin: number, landFractionMax: number, maxIslets: number, maxIsletCells: number}} params
 * @param {number} marginCells Hard sea margin, in cells; always forced to sea.
 * @returns {void}
 */
function applySeaLevelAndLandmassFilter(grid, heightField, seed, params, marginCells) {
  const { width, height, water, elev } = grid
  const size = width * height
  const rng = rngFor(seed, 'mapgen', 'sea-level')

  const targetLandFraction = params.landFractionMin + rng() * (params.landFractionMax - params.landFractionMin)

  const sorted = Float64Array.from(heightField).sort()
  const thresholdIndex = clamp(Math.floor((1 - targetLandFraction) * size), 0, size - 1)
  const seaLevelThreshold = sorted[thresholdIndex]

  for (let i = 0; i < size; i++) {
    water[i] = heightField[i] >= seaLevelThreshold ? 0 : 1
  }

  // The margin is always sea, regardless of height, so land never
  // reaches the grid edge even if the percentile threshold is low.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < marginCells || x >= width - marginCells || y < marginCells || y >= height - marginCells) {
        water[indexOf(grid, x, y)] = 1
      }
    }
  }

  const components = floodFillLandmasses(grid)
  components.sort((a, b) => b.length - a.length)

  const kept = new Set()
  if (components.length > 0) {
    kept.add(components[0]) // the single major landmass
  }

  let isletsKept = 0
  for (let c = 1; c < components.length; c++) {
    const component = components[c]
    if (component.length < params.maxIsletCells && isletsKept < params.maxIslets) {
      kept.add(component)
      isletsKept++
    }
  }

  for (const component of components) {
    if (!kept.has(component)) {
      for (const i of component) {
        water[i] = 1
      }
    }
  }

  // Final elevation in metres, scaled so the chosen sea level sits at
  // 0: land rises towards a high reference point, sea deepens towards
  // a low reference point. Land is always >= 1 and sea always <= -1,
  // so water and elev never disagree about which cells are land.
  //
  // The high/low references are percentiles of the land/sea height
  // distributions, not the literal min/max. A single lucky noise spike
  // at the literal max would otherwise stretch the whole land range
  // and drag the bulk of a mountain mass below any fixed threshold
  // (e.g. the 900m rock line); cells beyond the reference simply clamp
  // to the top/bottom of the output range instead.
  const landHeights = []
  const seaHeights = []
  for (let i = 0; i < size; i++) {
    if (water[i] === 0) {
      landHeights.push(heightField[i])
    } else {
      seaHeights.push(heightField[i])
    }
  }
  landHeights.sort((a, b) => a - b)
  seaHeights.sort((a, b) => a - b)

  const highReference = landHeights.length > 0
    ? landHeights[clamp(Math.floor(landHeights.length * 0.98), 0, landHeights.length - 1)]
    : seaLevelThreshold + 1e-6
  const lowReference = seaHeights.length > 0
    ? seaHeights[clamp(Math.floor(seaHeights.length * 0.02), 0, seaHeights.length - 1)]
    : seaLevelThreshold - 1e-6

  const landRange = Math.max(highReference - seaLevelThreshold, 1e-6)
  const seaRange = Math.max(seaLevelThreshold - lowReference, 1e-6)

  for (let i = 0; i < size; i++) {
    if (water[i] === 0) {
      const magnitude = Math.floor(((heightField[i] - seaLevelThreshold) / landRange) * 1300 + 0.5)
      elev[i] = clamp(magnitude, 1, 1300)
    } else {
      const magnitude = Math.floor((Math.max(0, seaLevelThreshold - heightField[i]) / seaRange) * 200 + 0.5)
      elev[i] = -clamp(magnitude, 1, 200)
    }
  }
}

/**
 * One pass of steepest-descent erosion: each land cell whose drop to
 * its lowest neighbour exceeds `talusMetres` moves a share of that
 * drop downhill. All moves are computed from one snapshot and applied
 * together afterwards, so the result does not depend on scan order.
 * With `talusMetres` 0 this is a simple stand-in for stream-power
 * erosion (acts on any downhill slope); with it above 0 it is thermal
 * erosion (acts only on locally steep edges).
 *
 * @param {{width: number, height: number, elev: Int16Array, water: Uint8Array}} grid The world grid.
 * @param {number} talusMetres Minimum drop to a neighbour before material moves.
 * @param {number} transferFraction Share of the excess drop moved per pass.
 * @returns {void}
 */
function steepestDescentPass(grid, talusMetres, transferFraction) {
  const { width, height, elev, water } = grid
  const size = width * height
  const delta = new Int32Array(size)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (water[i] !== 0) continue

      let lowestIndex = -1
      let lowestElev = elev[i]

      for (const [dx, dy] of NEIGHBOUR_OFFSETS_8) {
        const nx = x + dx
        const ny = y + dy
        if (!isInBounds(grid, nx, ny)) continue
        const ni = indexOf(grid, nx, ny)
        // Sea neighbours are never a valid erosion target: material
        // eroding off the coast is lost to the sea rather than being
        // tracked as underwater sediment, so sea elev (and the
        // land/sea split in water[]) never drifts from this pass.
        if (water[ni] !== 0) continue
        if (elev[ni] < lowestElev) {
          lowestElev = elev[ni]
          lowestIndex = ni
        }
      }

      if (lowestIndex === -1) continue

      const drop = elev[i] - lowestElev
      if (drop > talusMetres) {
        const amount = Math.floor(drop * transferFraction)
        if (amount > 0) {
          delta[i] -= amount
          delta[lowestIndex] += amount
        }
      }
    }
  }

  for (let i = 0; i < size; i++) {
    elev[i] += delta[i]
  }
}

/**
 * Applies light erosion (step 5): a thermal pass (levels out locally
 * steep edges above a talus angle) followed by a gentler stream-power
 * pass (smooths valleys and coastal plains even below the talus
 * angle), repeated for the given number of passes. Only ever touches
 * land cells; sea stays exactly as step 4 left it.
 *
 * @param {{width: number, height: number, elev: Int16Array, water: Uint8Array}} grid The world grid.
 * @param {number} passes Number of erosion passes to run.
 * @returns {void}
 */
function applyErosion(grid, passes) {
  for (let p = 0; p < passes; p++) {
    steepestDescentPass(grid, 15, 0.1) // thermal: only above the talus angle
    steepestDescentPass(grid, 0, 0.02) // stream power: any downhill slope, gentler
  }

  const size = grid.width * grid.height
  for (let i = 0; i < size; i++) {
    if (grid.water[i] === 0 && grid.elev[i] < 1) {
      grid.elev[i] = 1
    }
  }
}

/**
 * Generates the island's shape and relief end to end: mask, base
 * elevation, mountains, sea level and landmass filtering, then light
 * erosion. DESIGN.md 5.2 steps 1 to 5.
 *
 * @param {object} grid A world grid from createWorldGrid(); water and elev are written.
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {object} The same grid, for chaining.
 */
export function generateIsland(grid, seed, mapgenRules) {
  const marginCells = Math.max(1, Math.floor(mapgenRules.islandMask.marginMiles / grid.cellMiles))

  const mask = buildIslandMask(grid, seed, mapgenRules.islandMask, marginCells)
  const heightField = buildBaseElevation(grid, seed, mapgenRules.elevation, mask)
  addMountainRanges(grid, seed, mapgenRules.mountains, heightField, marginCells)
  applySeaLevelAndLandmassFilter(grid, heightField, seed, mapgenRules.seaLevel, marginCells)

  const passes = int(rngFor(seed, 'mapgen', 'erosion-passes'), mapgenRules.erosion.passesMin, mapgenRules.erosion.passesMax)
  applyErosion(grid, passes)

  return grid
}
