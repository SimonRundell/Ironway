/**
 * Marks coastal land, casts shelter rays out from the coast, groups
 * sheltered sea into bays, and scores and selects harbour candidates.
 * DESIGN.md 5.2 step 9. Purely derived from the island's shape, rivers
 * and slope; no randomness, so no seed is needed.
 *
 * @module sim/mapgen/coast
 */

import { clampByte, indexOf, isInBounds } from './grid.js'

/** @type {readonly [number, number][]} All 8 neighbour offsets. */
const NEIGHBOUR_OFFSETS_8 = Object.freeze([
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
])

/** @type {readonly [number, number][]} The 4 orthogonal neighbour offsets, for bay flood fill. */
const NEIGHBOUR_OFFSETS_4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

/** @type {Record<string, number>} Bit flags for the `coast` layer (DESIGN 5.1). */
export const COAST_FLAG = Object.freeze({
  COASTAL: 1,
  BEACH: 2,
  CLIFF: 4,
  ESTUARY: 8,
  HARBOUR_CANDIDATE: 16,
})

// 16 evenly-spaced ray directions (every 22.5 degrees), derived from
// exact half-angle identities (cos(22.5 deg) = sqrt(2 + sqrt(2)) / 2,
// sin(22.5 deg) = sqrt(2 - sqrt(2)) / 2) so the directions come from
// Math.sqrt and arithmetic only, never Math.sin/Math.cos, per DESIGN
// 4.5's exact-arithmetic rule.
const SQRT2 = Math.sqrt(2)
const COS45 = SQRT2 / 2
const COS22_5 = Math.sqrt(2 + SQRT2) / 2
const SIN22_5 = Math.sqrt(2 - SQRT2) / 2

/** @type {readonly [number, number][]} 16 unit direction vectors, 22.5 degrees apart. */
const RAY_DIRECTIONS_16 = Object.freeze([
  [1, 0], [COS22_5, SIN22_5], [COS45, COS45], [SIN22_5, COS22_5],
  [0, 1], [-SIN22_5, COS22_5], [-COS45, COS45], [-COS22_5, SIN22_5],
  [-1, 0], [-COS22_5, -SIN22_5], [-COS45, -COS45], [-SIN22_5, -COS22_5],
  [0, -1], [SIN22_5, -COS22_5], [COS45, -COS45], [COS22_5, -SIN22_5],
])

/**
 * Clamps a value to [0, 1].
 *
 * @param {number} value The value to clamp.
 * @returns {number} The clamped value.
 */
function clamp01(value) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Marks the `coast` bit flags (step 9, part 1): coastal land (touches a
 * sea cell), beach or cliff (from slope), and estuary (a river cell
 * that is also coastal).
 *
 * @param {object} grid The world grid (coast is written).
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {void}
 */
function markCoastalFlags(grid, mapgenRules) {
  const { width, height, water, river, slope, coast } = grid
  const cliffSlopeByte = mapgenRules.coast.cliffSlopeRatio * mapgenRules.slope.quantizationScale

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (water[i] !== 0) continue

      let touchesSea = false
      for (const [dx, dy] of NEIGHBOUR_OFFSETS_8) {
        const nx = x + dx
        const ny = y + dy
        if (isInBounds(grid, nx, ny) && water[indexOf(grid, nx, ny)] === 1) {
          touchesSea = true
          break
        }
      }
      if (!touchesSea) continue

      let flags = COAST_FLAG.COASTAL
      flags |= slope[i] < cliffSlopeByte ? COAST_FLAG.BEACH : COAST_FLAG.CLIFF
      if (river[i] > 0) flags |= COAST_FLAG.ESTUARY
      coast[i] = flags
    }
  }
}

/**
 * Multi-source breadth-first distance, in cells, from every sea cell to
 * the nearest non-sea (land or lake) cell. Used to skip ray casting for
 * sea cells too far from any coast to matter.
 *
 * @param {{width: number, height: number, water: Uint8Array}} grid The world grid.
 * @returns {Int32Array} Distance in cells, 0 for non-sea cells.
 */
function computeDistanceToLandCells(grid) {
  const { width, height, water } = grid
  const size = width * height
  const distance = new Int32Array(size).fill(-1)
  const queue = new Int32Array(size)
  let head = 0
  let tail = 0

  for (let i = 0; i < size; i++) {
    if (water[i] !== 1) {
      distance[i] = 0
      queue[tail++] = i
    }
  }

  while (head < tail) {
    const i = queue[head++]
    const x = i % width
    const y = Math.floor(i / width)

    for (const [dx, dy] of NEIGHBOUR_OFFSETS_8) {
      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(grid, nx, ny)) continue
      const ni = indexOf(grid, nx, ny)
      if (distance[ni] === -1) {
        distance[ni] = distance[i] + 1
        queue[tail++] = ni
      }
    }
  }

  return distance
}

/**
 * Casts 16 rays from every sea cell within `shelterRadiusMiles` of land
 * and records the fraction blocked by land within `rayMaxMiles` as the
 * `shelter` layer (step 9, part 2).
 *
 * @param {object} grid The world grid (shelter is written).
 * @param {{shelterRadiusMiles: number, rayMaxMiles: number}} coastParams mapgen.json's coast settings.
 * @param {Int32Array} distanceToLandCells From computeDistanceToLandCells().
 * @returns {void}
 */
function computeShelter(grid, coastParams, distanceToLandCells) {
  const { width, height, water, cellMiles, shelter } = grid
  const shelterRadiusCells = coastParams.shelterRadiusMiles / cellMiles
  const rayMaxSteps = Math.floor(coastParams.rayMaxMiles / cellMiles)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (water[i] !== 1) continue
      if (distanceToLandCells[i] > shelterRadiusCells) continue

      let blocked = 0
      for (const [dx, dy] of RAY_DIRECTIONS_16) {
        for (let step = 1; step <= rayMaxSteps; step++) {
          const sx = Math.floor(x + dx * step + 0.5)
          const sy = Math.floor(y + dy * step + 0.5)
          if (!isInBounds(grid, sx, sy)) break
          if (water[indexOf(grid, sx, sy)] !== 1) {
            blocked++
            break
          }
        }
      }

      shelter[i] = clampByte((blocked / RAY_DIRECTIONS_16.length) * 255)
    }
  }
}

/**
 * Finds connected sea regions whose shelter exceeds `bayShelterThreshold`
 * (4-connected flood fill): the island's bays.
 *
 * @param {{width: number, height: number, water: Uint8Array, shelter: Uint8Array}} grid The world grid.
 * @param {number} bayShelterThreshold mapgen.json's coast.bayShelterThreshold (0 to 1).
 * @returns {number[][]} One array of cell indices per bay.
 */
export function findBayRegions(grid, bayShelterThreshold) {
  const { width, height, water, shelter } = grid
  const size = width * height
  const visited = new Uint8Array(size)
  const thresholdByte = bayShelterThreshold * 255
  const regions = []

  for (let start = 0; start < size; start++) {
    if (water[start] !== 1 || visited[start] || shelter[start] <= thresholdByte) continue

    const region = []
    const stack = [start]
    visited[start] = 1

    while (stack.length > 0) {
      const i = stack.pop()
      region.push(i)

      const x = i % width
      const y = Math.floor(i / width)

      for (const [dx, dy] of NEIGHBOUR_OFFSETS_4) {
        const nx = x + dx
        const ny = y + dy
        if (!isInBounds(grid, nx, ny)) continue
        const ni = indexOf(grid, nx, ny)
        if (water[ni] === 1 && !visited[ni] && shelter[ni] > thresholdByte) {
          visited[ni] = 1
          stack.push(ni)
        }
      }
    }

    regions.push(region)
  }

  return regions
}

/**
 * Looks for the deepest (most negative elevation) sea cell within
 * `shoreDepthSearchRadiusMiles` of a coastal land cell, as a proxy for
 * "is there deep water close to shore". Returns 0 when no sea cell is
 * found nearby or the nearest water is at the surface.
 *
 * @param {object} grid The world grid.
 * @param {number} x Coastal cell's x coordinate.
 * @param {number} y Coastal cell's y coordinate.
 * @param {{shoreDepthSearchRadiusMiles: number, shoreDepthScaleMetres: number}} coastParams mapgen.json's coast settings.
 * @returns {number} A value in [0, 1]; 1 means deep water is close by.
 */
function computeShoreDepthProxy(grid, x, y, coastParams) {
  const radiusCells = Math.floor(coastParams.shoreDepthSearchRadiusMiles / grid.cellMiles)
  let deepest = 0

  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(grid, nx, ny)) continue
      const ni = indexOf(grid, nx, ny)
      if (grid.water[ni] === 1 && grid.elev[ni] < deepest) {
        deepest = grid.elev[ni]
      }
    }
  }

  return clamp01(-deepest / coastParams.shoreDepthScaleMetres)
}

/**
 * Scores every coastal land cell as a potential harbour site (step 9,
 * part 3): shelter (best adjacent sea cell) plus an estuary bonus for
 * a river mouth with enough flow, plus a shore-depth proxy, minus a
 * mudflat penalty on very flat shores with no deep water nearby.
 *
 * @param {object} grid The world grid (read-only).
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {{index: number, x: number, y: number, score: number, isEstuary: boolean, shelter: number}[]}
 *   One entry per coastal land cell.
 */
export function scoreHarbourCandidates(grid, mapgenRules) {
  const coastParams = mapgenRules.coast
  const { width, height, coast, slope, flow } = grid
  const candidates = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if ((coast[i] & COAST_FLAG.COASTAL) === 0) continue

      let bestShelter = 0
      for (const [dx, dy] of NEIGHBOUR_OFFSETS_8) {
        const nx = x + dx
        const ny = y + dy
        if (!isInBounds(grid, nx, ny)) continue
        const ni = indexOf(grid, nx, ny)
        if (grid.water[ni] === 1 && grid.shelter[ni] > bestShelter) {
          bestShelter = grid.shelter[ni]
        }
      }
      const shelterComponent = bestShelter / 255

      const isEstuary = (coast[i] & COAST_FLAG.ESTUARY) !== 0
      const estuaryBonus = isEstuary && flow[i] >= coastParams.portRiverFlowThreshold ? coastParams.estuaryBonus : 0

      const shoreDepthProxy = computeShoreDepthProxy(grid, x, y, coastParams)

      const slopeRatio = slope[i] / mapgenRules.slope.quantizationScale
      const isMudflat = slopeRatio < coastParams.mudflatSlopeRatio && shoreDepthProxy < coastParams.mudflatShoreDepthMax
      const mudflatPenalty = isMudflat ? coastParams.mudflatPenalty : 0

      const score = shelterComponent + estuaryBonus + shoreDepthProxy * coastParams.shoreDepthWeight - mudflatPenalty

      candidates.push({ index: i, x, y, score, isEstuary, shelter: shelterComponent })
    }
  }

  return candidates
}

/**
 * Greedily selects the highest-scoring candidates subject to a minimum
 * spacing (step 9, part 4), then tops up estuary representation if the
 * natural selection did not reach `minEstuaryHarbours`. DESIGN 5.3
 * treats a minimum estuary count as a hard requirement, not an
 * emergent one, but a dense coastline can leave every surviving
 * river-mouth cluster within the spacing radius of some already-chosen
 * plain-shelter site. Rather than relax the spacing rule (which the
 * same validation also requires), a strong estuary candidate evicts
 * the specific non-estuary site blocking it, preserving the spacing
 * invariant for the final list while still reaching the estuary
 * minimum: real estuaries (fresh water, inland trade reach) are
 * strategically valuable independent of shelter alone. Never evicts
 * another estuary. Flags each chosen cell as a harbour candidate on
 * the grid.
 *
 * @param {object} grid The world grid (coast is updated).
 * @param {{index: number, x: number, y: number, score: number, isEstuary: boolean}[]} candidates
 *   From scoreHarbourCandidates().
 * @param {{harbourMinSpacingMiles: number, minEstuaryHarbours: number}} coastParams mapgen.json's coast settings.
 * @returns {object[]} The selected candidates, in descending score order.
 */
export function selectHarbourCandidates(grid, candidates, coastParams) {
  const sorted = candidates.slice().sort((a, b) => b.score - a.score)
  const minSpacingCells = coastParams.harbourMinSpacingMiles / grid.cellMiles

  /**
   * @param {{x: number, y: number}} a First site.
   * @param {{x: number, y: number}} b Second site.
   * @returns {number} Distance between them, in cells.
   */
  function distanceCells(a, b) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  let selected = []

  for (const candidate of sorted) {
    if (!selected.some((chosen) => distanceCells(candidate, chosen) < minSpacingCells)) {
      selected.push(candidate)
    }
  }

  let estuaryCount = selected.reduce((count, c) => count + (c.isEstuary ? 1 : 0), 0)

  if (estuaryCount < coastParams.minEstuaryHarbours) {
    const selectedSet = new Set(selected)

    for (const candidate of sorted) {
      if (estuaryCount >= coastParams.minEstuaryHarbours) break
      if (!candidate.isEstuary || selectedSet.has(candidate)) continue

      const conflicts = selected.filter((chosen) => distanceCells(candidate, chosen) < minSpacingCells)
      if (conflicts.some((c) => c.isEstuary)) continue // never evict another estuary

      const conflictSet = new Set(conflicts)
      for (const conflict of conflicts) {
        selectedSet.delete(conflict)
      }
      selected = selected.filter((c) => !conflictSet.has(c))
      selected.push(candidate)
      selectedSet.add(candidate)
      estuaryCount++
    }
  }

  for (const candidate of selected) {
    grid.coast[candidate.index] |= COAST_FLAG.HARBOUR_CANDIDATE
  }

  return selected
}

/**
 * Generates coast and harbours end to end (step 9): coastal flags,
 * shelter rays, bay regions, harbour scoring and spaced selection.
 *
 * @param {object} grid A world grid with elev/water/river/flow/slope
 *   already populated (island, hydrology and slope steps); coast and
 *   shelter are written.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {{harbourCandidates: object[], bayRegions: number[][]}}
 *   The selected harbour candidates (with scores, for debugging) and
 *   the bay regions found along the way.
 */
export function generateCoast(grid, mapgenRules) {
  markCoastalFlags(grid, mapgenRules)

  const distanceToLandCells = computeDistanceToLandCells(grid)
  computeShelter(grid, mapgenRules.coast, distanceToLandCells)

  const bayRegions = findBayRegions(grid, mapgenRules.coast.bayShelterThreshold)
  const candidates = scoreHarbourCandidates(grid, mapgenRules)
  const harbourCandidates = selectHarbourCandidates(grid, candidates, mapgenRules.coast)

  return { harbourCandidates, bayRegions }
}
