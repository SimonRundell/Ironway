/**
 * Places settlements by score (capital first, then cities, towns,
 * villages and hamlets, each subject to its own minimum spacing),
 * assigns hinterlands into `region`, port tier, rank-size shaped
 * initial population, class split and housing. DESIGN.md 5.4.
 *
 * @module sim/mapgen/settlements
 */

import { computeDistanceFromSources, indexOf, neighbours8 } from './grid.js'
import { int, rngFor } from '../rng.js'
import { COAST_FLAG } from './coast.js'
import { RESOURCE } from './resources.js'
import { floodFillLandmasses } from './island.js'

/** @type {readonly string[]} Placement order: capital first, then descending by size. */
const KIND_ORDER = Object.freeze(['capital', 'city', 'town', 'village', 'hamlet'])

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
 * Builds the buildable-land mask: land cells that are not `rock` and
 * belong to the main landmass. DESIGN 5.2 step 10's own invariant
 * ("everything that is not rock is farmable, buildable or
 * exploitable") covers the rock exclusion; the landmass restriction is
 * this module's own addition, since island.js keeps up to 3 small
 * islets alongside the main landmass (step 4), and those are
 * genuinely cut off from it by sea — a settlement placed there could
 * never be reached from the capital by road, which DESIGN 5.3
 * requires unconditionally. Excluding them here, before any scoring
 * happens, is cheaper and more certain than trying to patch road
 * connectivity around an island with no land route to it.
 *
 * @param {object} grid The world grid.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @returns {Uint8Array} 1 where a settlement may be placed, 0 otherwise.
 */
function computeBuildableMask(grid, terrainRules) {
  const rockIndex = terrainRules.landuseEnum.indexOf('rock')

  const components = floodFillLandmasses(grid)
  components.sort((a, b) => b.length - a.length)
  const mainLandmass = new Uint8Array(grid.landuse.length)
  if (components.length > 0) {
    for (const i of components[0]) mainLandmass[i] = 1
  }

  const mask = new Uint8Array(grid.landuse.length)
  for (let i = 0; i < grid.landuse.length; i++) {
    mask[i] = grid.water[i] === 0 && grid.landuse[i] !== rockIndex && mainLandmass[i] ? 1 : 0
  }
  return mask
}

/**
 * Averages `soil` (fertility) over a square window around every cell,
 * normalised to [0, 1]. DESIGN 5.4 scores placement by "local fertility
 * (10-mile radius)", a smoothed neighbourhood average rather than a
 * single cell's own value.
 *
 * @param {object} grid The world grid.
 * @param {number} radiusCells The averaging window's radius, in cells.
 * @returns {Float64Array} Average fertility in [0, 1] per cell.
 */
function computeFertilityAverage(grid, radiusCells) {
  const { width, height, soil } = grid
  const avg = new Float64Array(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      let count = 0
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          sum += soil[indexOf(grid, nx, ny)]
          count++
        }
      }
      avg[indexOf(grid, x, y)] = count > 0 ? sum / count / 255 : 0
    }
  }

  return avg
}

/**
 * Flags river cells with 2 or more river-flagged 8-neighbours: a
 * confluence or a crossing, per DESIGN 5.4's "confluence or
 * river-crossing bonus".
 *
 * @param {object} grid The world grid.
 * @returns {Uint8Array} 1 where a confluence/crossing sits, 0 otherwise.
 */
function computeConfluenceMask(grid) {
  const { width, height, river } = grid
  const mask = new Uint8Array(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (river[i] === 0) continue

      let riverNeighbours = 0
      for (const [nx, ny] of neighbours8(grid, x, y)) {
        if (river[indexOf(grid, nx, ny)] > 0) riverNeighbours++
      }
      if (riverNeighbours >= 2) mask[i] = 1
    }
  }

  return mask
}

/**
 * Draws one deterministic jitter value per cell, so the greedy
 * highest-score-first placement doesn't produce a visibly grid-aligned
 * pattern (DESIGN 5.4: "Add jitter to avoid grid-aligned patterns").
 * Shared across every kind, keyed only by cell index, so the same cell
 * always jitters the same way regardless of which kind is being placed.
 *
 * @param {string} seed The save's seed.
 * @param {number} size Grid cell count.
 * @param {number} strength Jitter half-width, added to or subtracted from the score.
 * @returns {Float64Array} Jitter values, roughly in [-strength/2, strength/2].
 */
function computeJitter(seed, size, strength) {
  const jitter = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    jitter[i] = (rngFor(seed, 'settlements', 'jitter', i)() - 0.5) * strength
  }
  return jitter
}

/**
 * Scores every buildable cell as a general settlement site (DESIGN
 * 5.4): local fertility, fresh water (river nearby or coastal),
 * flatness, a confluence/crossing bonus, a harbour bonus (full weight
 * for sitting directly on a harbour-candidate or estuary cell, partial
 * credit for any coastal cell), a resource-proximity bonus, minus a
 * marsh penalty.
 *
 * @param {object} grid The world grid.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {object} settlementsRules The validated settlements.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {Uint8Array} buildable From computeBuildableMask().
 * @param {Float64Array} fertilityAvg From computeFertilityAverage().
 * @returns {Float64Array} A score per cell (0 where not buildable).
 */
function computeSettlementScores(grid, mapgenRules, settlementsRules, terrainRules, buildable, fertilityAvg) {
  const p = settlementsRules.placement
  const { width, height, slope, landuse, coast, river } = grid
  const rockSlopeByte = mapgenRules.soil.rockSlopeRatio * mapgenRules.slope.quantizationScale
  const marshIndex = terrainRules.landuseEnum.indexOf('marsh')

  const freshWaterRadiusCells = p.freshWaterRadiusMiles / grid.cellMiles
  const resourceRadiusCells = p.resourceRadiusMiles / grid.cellMiles
  const distanceToRiver = computeDistanceFromSources(grid, (i) => river[i] > 0)
  const distanceToResource = computeDistanceFromSources(grid, (i) => grid.resource[i] !== RESOURCE.NONE)
  const confluence = computeConfluenceMask(grid)

  const score = new Float64Array(width * height)

  for (let i = 0; i < score.length; i++) {
    if (!buildable[i]) continue

    const isCoastal = (coast[i] & COAST_FLAG.COASTAL) !== 0
    const isPortSite = (coast[i] & (COAST_FLAG.HARBOUR_CANDIDATE | COAST_FLAG.ESTUARY)) !== 0
    const hasFreshWater = river[i] > 0 || distanceToRiver[i] <= freshWaterRadiusCells || isCoastal
    const flatness = clamp01(1 - slope[i] / rockSlopeByte)
    const hasResourceNearby = distanceToResource[i] <= resourceRadiusCells
    const isMarsh = landuse[i] === marshIndex

    let value = fertilityAvg[i] * p.fertilityWeight
      + (hasFreshWater ? p.freshWaterWeight : 0)
      + flatness * p.flatnessWeight
      + (confluence[i] ? p.confluenceBonus : 0)
      + (isPortSite ? p.harbourWeight : isCoastal ? p.harbourWeight * p.coastalBonusFraction : 0)
      + (hasResourceNearby ? p.resourceWeight : 0)

    if (isMarsh) value -= p.marshPenalty

    score[i] = value
  }

  return score
}

/**
 * Scores buildable, coastal cells within `capitalHarbourRadiusMiles` of
 * a harbour-candidate or estuary cell as capital sites (DESIGN 5.4:
 * "coastal or estuary, large fertile hinterland, near central
 * coordinates, near a harbour"). Cells failing either the coastal or
 * the harbour-distance test are not eligible at all, which is what
 * guarantees the capital always lands within DESIGN 5.3's 12-mile
 * requirement, rather than hoping scoring alone favours it.
 *
 * @param {object} grid The world grid.
 * @param {object} settlementsRules The validated settlements.json rules.
 * @param {Uint8Array} buildable From computeBuildableMask().
 * @param {Float64Array} fertilityAvg From computeFertilityAverage().
 * @param {Int32Array} distanceToHarbourOrEstuary From computeDistanceFromSources() over harbour-candidate/estuary cells.
 * @returns {{score: Float64Array, eligible: Uint8Array}}
 */
function computeCapitalScore(grid, settlementsRules, buildable, fertilityAvg, distanceToHarbourOrEstuary) {
  const p = settlementsRules.placement
  const { width, height, coast, cellMiles } = grid
  const capitalRadiusCells = p.capitalHarbourRadiusMiles / cellMiles
  const centreX = width / 2
  const centreY = height / 2
  const maxDist = Math.sqrt(centreX * centreX + centreY * centreY)

  const score = new Float64Array(width * height)
  const eligible = new Uint8Array(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (!buildable[i]) continue
      if ((coast[i] & COAST_FLAG.COASTAL) === 0) continue
      if (distanceToHarbourOrEstuary[i] > capitalRadiusCells) continue

      eligible[i] = 1
      const dx = x - centreX
      const dy = y - centreY
      const centrality = 1 - Math.sqrt(dx * dx + dy * dy) / maxDist
      const harbourCloseness = 1 - distanceToHarbourOrEstuary[i] / capitalRadiusCells

      score[i] = centrality * p.capitalCentralityWeight
        + fertilityAvg[i] * p.capitalFertilityWeight
        + harbourCloseness * p.capitalHarbourWeight
    }
  }

  return { score, eligible }
}

/**
 * Greedily selects up to `count` cells for one kind: highest
 * score-plus-jitter first, skipping any cell already claimed by a
 * previous kind and any cell closer than `minSpacingMiles` to a cell
 * already selected for this same kind (DESIGN 5.4 lists spacing
 * per kind, so two different kinds may sit closer to each other than
 * either's own minimum). Mirrors coast.js's harbour candidate
 * selection.
 *
 * @param {object} grid The world grid.
 * @param {Float64Array} score From computeSettlementScores() (or computeCapitalScore() for the capital).
 * @param {Float64Array} jitter From computeJitter().
 * @param {Uint8Array} buildable From computeBuildableMask().
 * @param {Set<number>} claimed Cell indices already used by any settlement; updated in place.
 * @param {number} count How many to select.
 * @param {number|null} minSpacingMiles Minimum spacing within this kind, or null for no limit (the capital).
 * @returns {number[]} Selected cell indices, best-scoring first.
 */
function selectSettlements(grid, score, jitter, buildable, claimed, count, minSpacingMiles) {
  const candidates = []
  for (let i = 0; i < score.length; i++) {
    if (buildable[i] && !claimed.has(i)) candidates.push(i)
  }
  candidates.sort((a, b) => (score[b] + jitter[b]) - (score[a] + jitter[a]))

  const minSpacingCells = minSpacingMiles != null ? minSpacingMiles / grid.cellMiles : 0
  const selected = []

  for (const i of candidates) {
    if (selected.length >= count) break
    if (claimed.has(i)) continue

    if (minSpacingCells > 0) {
      const x = i % grid.width
      const y = Math.floor(i / grid.width)
      let tooClose = false
      for (const j of selected) {
        const jx = j % grid.width
        const jy = Math.floor(j / grid.width)
        const dx = x - jx
        const dy = y - jy
        if (Math.sqrt(dx * dx + dy * dy) < minSpacingCells) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue
    }

    selected.push(i)
    claimed.add(i)
  }

  return selected
}

/**
 * Splits a settlement's population across classes using
 * settlements.json's `classSplitPercent`, rounding each class and then
 * nudging the largest class by any leftover so the parts sum exactly
 * to the whole population.
 *
 * @param {number} population The settlement's total population.
 * @param {Record<string, number>} splitPercent e.g. `{upper: 12, middle: 38, working: 50}`.
 * @param {Record<string, number>} classIndexByName Class id to classes.json array index.
 * @param {object[]} classesRules The validated classes.json rules (the `classes` array).
 * @returns {Record<number, {pop: number, employed: number, confidence: number}>} Keyed by classId.
 */
function splitPopulationByClass(population, splitPercent, classIndexByName, classesRules) {
  const entries = Object.entries(splitPercent)
  const rounded = entries.map(([, pct]) => Math.round((population * pct) / 100))
  const diff = population - rounded.reduce((sum, v) => sum + v, 0)

  if (diff !== 0) {
    let largest = 0
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i] > rounded[largest]) largest = i
    }
    rounded[largest] += diff
  }

  const pop = {}
  entries.forEach(([className], i) => {
    const classIndex = classIndexByName[className]
    const classDef = classesRules[classIndex]
    const classPop = rounded[i]
    pop[classIndex] = { pop: classPop, employed: Math.round(classPop * classDef.participation), confidence: 50 }
  })

  return pop
}

/**
 * Assigns every land cell within some settlement's hinterland radius
 * to the settlement with the smallest size-weighted distance (raw
 * distance divided by that settlement's own `hinterlandRadiusMiles`,
 * so a bigger settlement's pull reaches further at the same raw
 * distance), writing `region`. A cell outside every placed
 * settlement's radius is left at 0 (no settlement). Because every
 * qualifying cell is visited and assigned in the same pass, there is
 * no way for a cell inside some settlement's radius to be skipped.
 *
 * @param {object} grid The world grid (region is written).
 * @param {{id: number, index: number, hinterlandRadiusMiles: number}[]} placed Placed settlements.
 * @returns {void}
 */
function assignHinterlands(grid, placed) {
  const { width, height, cellMiles, region, water } = grid

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (water[i] !== 0) continue

      let best = null
      let bestEffectiveDistance = Infinity

      for (const s of placed) {
        const sx = (s.index % width) * cellMiles
        const sy = Math.floor(s.index / width) * cellMiles
        const dx = x * cellMiles - sx
        const dy = y * cellMiles - sy
        const rawDistanceMiles = Math.sqrt(dx * dx + dy * dy)
        if (rawDistanceMiles > s.hinterlandRadiusMiles) continue

        const effectiveDistance = rawDistanceMiles / s.hinterlandRadiusMiles
        if (effectiveDistance < bestEffectiveDistance) {
          bestEffectiveDistance = effectiveDistance
          best = s
        }
      }

      if (best) {
        region[i] = best.id
        best.regionCells++
      }
    }
  }
}

/**
 * Generates settlements end to end (DESIGN 5.4): places the capital,
 * then cities, towns, villages and hamlets by score with per-kind
 * spacing; assigns hinterlands into `region`; sets port tier for any
 * settlement sitting on a harbour candidate or estuary; gives each a
 * rank-size shaped initial population (within its kind, biggest first,
 * since the placement order already is best-score-first), split by
 * class, with housing at `initialHousingCapacityFactor` of population.
 *
 * @param {object} grid A world grid with soil/slope/coast/river/resource
 *   already populated; region is written.
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {object} settlementsRules The validated settlements.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {object[]} classesRules The validated classes.json rules (the `classes` array).
 * @param {ReturnType<import('../names.js').createNameGenerator>} nameGen A name generator for this seed.
 * @returns {import('../state.js').Settlement[]}
 */
export function generateSettlements(grid, seed, mapgenRules, settlementsRules, terrainRules, classesRules, nameGen) {
  const p = settlementsRules.placement
  const kindsById = {}
  settlementsRules.kinds.forEach((kind) => { kindsById[kind.id] = kind })

  const buildable = computeBuildableMask(grid, terrainRules)
  const fertilityRadiusCells = Math.round(p.fertilityRadiusMiles / grid.cellMiles)
  const fertilityAvg = computeFertilityAverage(grid, fertilityRadiusCells)
  const score = computeSettlementScores(grid, mapgenRules, settlementsRules, terrainRules, buildable, fertilityAvg)
  const jitter = computeJitter(seed, grid.width * grid.height, p.jitterStrength)
  const distanceToHarbourOrEstuary = computeDistanceFromSources(
    grid,
    (i) => (grid.coast[i] & (COAST_FLAG.HARBOUR_CANDIDATE | COAST_FLAG.ESTUARY)) !== 0,
  )

  const claimed = new Set()
  const placedByKind = {}
  let nextId = 1

  const { score: capitalScore, eligible: capitalEligible } = computeCapitalScore(
    grid, settlementsRules, buildable, fertilityAvg, distanceToHarbourOrEstuary,
  )
  const capitalPicks = selectSettlements(grid, capitalScore, jitter, capitalEligible, claimed, 1, null)
  placedByKind.capital = capitalPicks.map((index) => ({ id: nextId++, kindId: 'capital', index, hinterlandRadiusMiles: kindsById.capital.hinterlandRadiusMiles, regionCells: 0 }))

  for (const kindId of ['city', 'town', 'village', 'hamlet']) {
    const kind = kindsById[kindId]
    const count = int(rngFor(seed, 'settlements', kindId, 'count'), kind.count.min, kind.count.max)
    const picks = selectSettlements(grid, score, jitter, buildable, claimed, count, kind.minSpacingMiles)
    placedByKind[kindId] = picks.map((index) => ({ id: nextId++, kindId, index, hinterlandRadiusMiles: kind.hinterlandRadiusMiles, regionCells: 0 }))
  }

  const placed = KIND_ORDER.flatMap((kindId) => placedByKind[kindId] ?? [])

  for (const list of Object.values(placedByKind)) {
    const kind = kindsById[list[0]?.kindId]
    if (!kind) continue
    const { min, max } = kind.initialPopulation
    const count = list.length

    list.forEach((s, i) => {
      if (count === 1) {
        s.population = int(rngFor(seed, 'settlements', s.kindId, 'population', i), min, max)
      } else {
        const rankT = (count - i) / count
        const popFraction = p.popFractionFloor + (1 - p.popFractionFloor) * rankT
        s.population = Math.round(min + (max - min) * popFraction)
      }
    })
  }

  assignHinterlands(grid, placed)

  const classIndexByName = {}
  classesRules.forEach((c, i) => { classIndexByName[c.id] = i })

  const settlements = placed.map((s) => {
    const x = (s.index % grid.width) * grid.cellMiles
    const y = Math.floor(s.index / grid.width) * grid.cellMiles
    const isCoastal = (grid.coast[s.index] & COAST_FLAG.COASTAL) !== 0
    const isPortSite = (grid.coast[s.index] & (COAST_FLAG.HARBOUR_CANDIDATE | COAST_FLAG.ESTUARY)) !== 0
    const portTier = isPortSite ? p.portTierByKind[s.kindId] : 0
    const splitKey = s.kindId === 'city' ? (isPortSite ? 'city_trading' : 'city_industrial') : s.kindId
    const pop = splitPopulationByClass(s.population, settlementsRules.classSplitPercent[splitKey], classIndexByName, classesRules)

    return {
      id: s.id,
      name: nameGen.settlementName(isCoastal),
      kind: s.kindId,
      x,
      y,
      portTier,
      housing: Math.round(s.population * settlementsRules.initialHousingCapacityFactor),
      regionCells: s.regionCells,
      pop,
      stock: {},
    }
  })

  return settlements
}
