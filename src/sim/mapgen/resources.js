/**
 * Places resource deposits as blobs with size and richness: coal in
 * foothill sedimentary basins, iron in uplands near coal basins, stone
 * in uplands and ridges, clay on floodplains and low valleys. DESIGN.md
 * 5.2 step 11.
 *
 * @module sim/mapgen/resources
 */

import { computeDistanceFromSources, indexOf, neighbours8 } from './grid.js'
import { int, pick, rngFor, shuffle } from '../rng.js'

/** @type {Readonly<{NONE: 0, COAL: 1, IRON: 2, STONE: 3, CLAY: 4}>} The `resource` layer's enum, per DESIGN 5.1. */
export const RESOURCE = Object.freeze({ NONE: 0, COAL: 1, IRON: 2, STONE: 3, CLAY: 4 })

/**
 * Converts a slope ratio from mapgen.json into the quantized byte used
 * by `grid.slope`, matching the scale `generateSlope()` writes in.
 *
 * @param {number} ratio A slope ratio from mapgen.json.
 * @param {{quantizationScale: number}} slopeRules mapgen.json's slope settings.
 * @returns {number} The equivalent slope byte.
 */
function slopeByte(ratio, slopeRules) {
  return ratio * slopeRules.quantizationScale
}

/**
 * Grows a connected blob of up to `targetSize` cells from a starting
 * cell, by repeatedly picking a random frontier cell and claiming one
 * of its unclaimed, eligible 8-connected neighbours. Stops early if the
 * frontier runs out of eligible neighbours (a small or boxed-in site).
 *
 * @param {object} grid The world grid.
 * @param {number} startIndex The blob's starting cell index.
 * @param {number} targetSize The desired cell count.
 * @param {(index: number) => boolean} isEligible Whether a cell can join the blob.
 * @param {Set<number>} claimed Cells already used by any deposit; updated in place.
 * @param {() => number} rng A stream from rngFor().
 * @returns {number[]} The blob's cell indices, including the start.
 */
function growBlob(grid, startIndex, targetSize, isEligible, claimed, rng) {
  claimed.add(startIndex)
  const blobCells = [startIndex]
  const frontier = [startIndex]

  while (blobCells.length < targetSize && frontier.length > 0) {
    const frontierIndex = int(rng, 0, frontier.length - 1)
    const current = frontier[frontierIndex]
    const x = current % grid.width
    const y = Math.floor(current / grid.width)
    let grown = false

    for (const [nx, ny] of neighbours8(grid, x, y)) {
      const ni = indexOf(grid, nx, ny)
      if (claimed.has(ni) || !isEligible(ni)) continue
      claimed.add(ni)
      blobCells.push(ni)
      frontier.push(ni)
      grown = true
      if (blobCells.length >= targetSize) break
    }

    if (!grown) {
      frontier.splice(frontierIndex, 1)
    }
  }

  return blobCells
}

/**
 * Stamps a grown blob's cells onto the resource and richness layers,
 * and builds the deposit record used for the proximity guarantee,
 * tests and the preview script.
 *
 * @param {object} grid The world grid (resource, richness are written).
 * @param {string} type The deposit's type name, for debugging.
 * @param {number} enumValue The `RESOURCE` enum value to stamp.
 * @param {number} centreIndex The blob's starting cell index.
 * @param {number[]} cells The blob's cell indices.
 * @param {number} richness The deposit's richness (0-255), shared by every cell in the blob.
 * @returns {{type: string, centreIndex: number, x: number, y: number, cells: number[], richness: number}}
 */
function makeDeposit(grid, type, enumValue, centreIndex, cells, richness) {
  for (const c of cells) {
    grid.resource[c] = enumValue
    grid.richness[c] = richness
  }
  return {
    type,
    centreIndex,
    x: centreIndex % grid.width,
    y: Math.floor(centreIndex / grid.width),
    cells,
    richness,
  }
}

/**
 * Places deposits of one resource type: a random extra count on top of
 * the configured minimum, sited on cells matching the type's siting
 * rule, each grown into a blob and given a richness value. If the
 * siting rule doesn't leave enough eligible land to reach the minimum
 * (a cramped or unusually shaped island), falls back to any remaining
 * unclaimed land cell so the minimum guarantee always holds.
 *
 * @param {object} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {object} resourceRules mapgen.json's resources settings.
 * @param {string} type The deposit's type name (used in rng keys and debug records).
 * @param {number} enumValue The `RESOURCE` enum value to stamp.
 * @param {number} minCount The guaranteed minimum deposit count.
 * @param {(index: number) => boolean} isEligible The type's siting rule.
 * @param {Set<number>} claimed Cells already used by any deposit; updated in place.
 * @returns {object[]} The placed deposits.
 */
function placeDeposits(grid, seed, resourceRules, type, enumValue, minCount, isEligible, claimed) {
  const p = resourceRules
  const countRng = rngFor(seed, 'resources', type, 'count')
  const targetCount = minCount + int(countRng, 0, p.extraDepositsMax)

  const eligibleCells = []
  for (let i = 0; i < grid.elev.length; i++) {
    if (!claimed.has(i) && isEligible(i)) eligibleCells.push(i)
  }
  const order = shuffle(rngFor(seed, 'resources', type, 'order'), eligibleCells)

  const deposits = []
  let cursor = 0
  while (deposits.length < targetCount && cursor < order.length) {
    const centreIndex = order[cursor++]
    if (claimed.has(centreIndex)) continue

    const targetSize = int(rngFor(seed, 'resources', type, 'size', deposits.length), p.blobSizeMin, p.blobSizeMax)
    const cells = growBlob(grid, centreIndex, targetSize, isEligible, claimed, rngFor(seed, 'resources', type, 'grow', deposits.length))
    const richness = int(rngFor(seed, 'resources', type, 'richness', deposits.length), p.richnessMin, p.richnessMax)
    deposits.push(makeDeposit(grid, type, enumValue, centreIndex, cells, richness))
  }

  if (deposits.length < minCount) {
    const fallback = []
    for (let i = 0; i < grid.elev.length; i++) {
      if (grid.water[i] === 0 && !claimed.has(i)) fallback.push(i)
    }
    const fallbackOrder = shuffle(rngFor(seed, 'resources', type, 'fallback-order'), fallback)

    let fi = 0
    while (deposits.length < minCount && fi < fallbackOrder.length) {
      const centreIndex = fallbackOrder[fi++]
      if (claimed.has(centreIndex)) continue

      const targetSize = int(rngFor(seed, 'resources', type, 'fallback-size', deposits.length), p.blobSizeMin, p.blobSizeMax)
      const cells = growBlob(grid, centreIndex, targetSize, (i) => grid.water[i] === 0, claimed, rngFor(seed, 'resources', type, 'fallback-grow', deposits.length))
      const richness = int(rngFor(seed, 'resources', type, 'fallback-richness', deposits.length), p.richnessMin, p.richnessMax)
      deposits.push(makeDeposit(grid, type, enumValue, centreIndex, cells, richness))
    }
  }

  return deposits
}

/**
 * Straight-line distance, in miles, between two deposits' centre cells.
 *
 * @param {object} grid The world grid.
 * @param {{x: number, y: number}} a The first deposit.
 * @param {{x: number, y: number}} b The second deposit.
 * @returns {number} Distance in miles.
 */
function milesBetween(grid, a, b) {
  const dx = (a.x - b.x) * grid.cellMiles
  const dy = (a.y - b.y) * grid.cellMiles
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Guarantees DESIGN's "coal and iron chain" requirement: at least
 * `minCoalIronPairsWithinProximity` (coal, iron) deposit pairs within
 * `coalIronProximityMiles` of each other. For each unpaired coal
 * deposit (while short of the target), forces a new, small iron
 * deposit onto the best unclaimed land within range, so the guarantee
 * holds even on islands where coal and iron naturally land far apart.
 *
 * @param {object} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {object} resourceRules mapgen.json's resources settings.
 * @param {object[]} coalDeposits Placed coal deposits; read only.
 * @param {object[]} ironDeposits Placed iron deposits; appended to in place.
 * @param {Set<number>} claimed Cells already used by any deposit; updated in place.
 * @returns {void}
 */
function ensureCoalIronProximity(grid, seed, resourceRules, coalDeposits, ironDeposits, claimed) {
  const p = resourceRules
  const proximityMiles = p.coalIronProximityMiles
  const radiusCells = Math.floor(proximityMiles / grid.cellMiles)

  const countPairs = () => {
    let count = 0
    for (const coal of coalDeposits) {
      for (const iron of ironDeposits) {
        if (milesBetween(grid, coal, iron) <= proximityMiles) count++
      }
    }
    return count
  }

  let attempt = 0
  while (countPairs() < p.minCoalIronPairsWithinProximity && attempt < coalDeposits.length) {
    const coal = coalDeposits[attempt]
    attempt++
    if (ironDeposits.some((iron) => milesBetween(grid, coal, iron) <= proximityMiles)) continue

    const candidates = []
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      const y = coal.y + dy
      if (y < 0 || y >= grid.height) continue
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const x = coal.x + dx
        if (x < 0 || x >= grid.width) continue
        if (Math.sqrt(dx * dx + dy * dy) * grid.cellMiles > proximityMiles) continue
        const i = indexOf(grid, x, y)
        if (grid.water[i] !== 0 || claimed.has(i)) continue
        candidates.push(i)
      }
    }
    if (candidates.length === 0) continue

    const centreIndex = pick(rngFor(seed, 'resources', 'proximity-iron', attempt), candidates)
    const targetSize = int(rngFor(seed, 'resources', 'proximity-iron-size', attempt), p.blobSizeMin, p.blobSizeMax)
    const cells = growBlob(grid, centreIndex, targetSize, (i) => grid.water[i] === 0, claimed, rngFor(seed, 'resources', 'proximity-iron-grow', attempt))
    const richness = int(rngFor(seed, 'resources', 'proximity-iron-richness', attempt), p.richnessMin, p.richnessMax)
    ironDeposits.push(makeDeposit(grid, 'iron', RESOURCE.IRON, centreIndex, cells, richness))
  }
}

/**
 * Generates resource deposits end to end (step 11): coal in the
 * foothills, iron in the uplands near coal, stone on steep uplands and
 * ridges, clay on low ground near rivers, then tops up any type short
 * of its guaranteed minimum and guarantees enough coal-iron pairs
 * within chain distance of each other.
 *
 * @param {object} grid A world grid with elev/water/river/slope already
 *   populated; resource and richness are written.
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {{coal: object[], iron: object[], stone: object[], clay: object[]}} Placed deposits by type, for debugging and tests.
 */
export function generateResources(grid, seed, mapgenRules) {
  const p = mapgenRules.resources
  const slopeRules = mapgenRules.slope
  const distanceToRiver = computeDistanceFromSources(grid, (i) => grid.river[i] > 0)
  const clayRiverRadiusCells = p.clayRiverRadiusMiles / grid.cellMiles
  const claimed = new Set()

  const isCoalEligible = (i) => grid.water[i] === 0
    && grid.elev[i] >= p.coalElevationMinMetres && grid.elev[i] <= p.coalElevationMaxMetres
    && grid.slope[i] <= slopeByte(p.coalMaxSlopeRatio, slopeRules)

  const isIronEligible = (i) => grid.water[i] === 0
    && grid.elev[i] >= p.ironElevationMinMetres && grid.elev[i] <= p.ironElevationMaxMetres
    && grid.slope[i] <= slopeByte(p.ironMaxSlopeRatio, slopeRules)

  const isStoneEligible = (i) => grid.water[i] === 0
    && grid.elev[i] >= p.stoneElevationMinMetres
    && grid.slope[i] >= slopeByte(p.stoneMinSlopeRatio, slopeRules)

  const isClayEligible = (i) => grid.water[i] === 0
    && grid.elev[i] <= p.clayMaxElevationMetres
    && grid.slope[i] <= slopeByte(p.clayMaxSlopeRatio, slopeRules)
    && distanceToRiver[i] <= clayRiverRadiusCells

  const coal = placeDeposits(grid, seed, p, 'coal', RESOURCE.COAL, p.minCoalDeposits, isCoalEligible, claimed)
  const iron = placeDeposits(grid, seed, p, 'iron', RESOURCE.IRON, p.minIronDeposits, isIronEligible, claimed)
  const stone = placeDeposits(grid, seed, p, 'stone', RESOURCE.STONE, p.minStoneDeposits, isStoneEligible, claimed)
  const clay = placeDeposits(grid, seed, p, 'clay', RESOURCE.CLAY, p.minClayDeposits, isClayEligible, claimed)

  ensureCoalIronProximity(grid, seed, p, coal, iron, claimed)

  return { coal, iron, stone, clay }
}
