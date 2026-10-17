/**
 * Computes fertility, arable/pastoral suitability and the final
 * land-use classification for every land cell. DESIGN.md 5.2 step 10.
 *
 * @module sim/mapgen/soil
 */

import { clampByte, computeDistanceFromSources, indexOf } from './grid.js'
import { fbm2D } from '../noise.js'
import { hashString } from '../rng.js'
import { COAST_FLAG } from './coast.js'

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
 * A smooth polynomial bump peaking at 1 when `value === centre` and
 * falling to 0 at `centre ± halfWidth`. Used wherever DESIGN asks for
 * a "moderate" or "mid-range" sweet spot rather than a simple
 * more-is-better factor.
 *
 * @param {number} value The value to score.
 * @param {number} centre Where the bump peaks.
 * @param {number} halfWidth Distance from the centre at which the bump reaches 0.
 * @returns {number} A value in [0, 1].
 */
function bump(value, centre, halfWidth) {
  const t = (value - centre) / halfWidth
  const b = 1 - t * t
  return b > 0 ? b * b : 0
}

/**
 * Builds a name-to-index lookup from terrain.json's landuseEnum, so
 * this module never hardcodes the enum's order.
 *
 * @param {string[]} landuseEnum terrain.json's landuseEnum array.
 * @returns {Record<string, number>} Upper-cased name to index, e.g. `{ ROCK: 8 }`.
 */
function buildLanduseIndex(landuseEnum) {
  const index = {}
  for (let i = 0; i < landuseEnum.length; i++) {
    index[landuseEnum[i].toUpperCase()] = i
  }
  return index
}

/**
 * Computes fertility (step 10, part 1) for every land cell: low slope,
 * moderate elevation, moderate rainfall, a floodplain bonus near a
 * river, and a seeded noise component for natural-looking variation.
 * Stored in the `soil` layer (0 to 255); sea and lake cells are left
 * at 0 since fertility is meaningless there.
 *
 * @param {object} grid The world grid (soil is written).
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {void}
 */
function computeFertility(grid, seed, mapgenRules) {
  const p = mapgenRules.soil
  const rockSlopeByte = p.rockSlopeRatio * mapgenRules.slope.quantizationScale
  const { width, height, elev, slope, rain, water, soil } = grid

  const fertilitySeed = hashString([seed, 'soil', 'fertility'].join('|'))
  const freqX = 8 / width
  const freqY = 8 / height

  const distanceToRiver = computeDistanceFromSources(grid, (i) => grid.river[i] > 0)
  const floodplainRadiusCells = p.riverFloodplainRadiusMiles / grid.cellMiles

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (water[i] !== 0) continue

      const elevationFactor = bump(elev[i], p.fertilityIdealElevationMetres, p.fertilityElevationRangeMetres)
      const slopeFactor = clamp01(1 - slope[i] / rockSlopeByte)
      const rainFactor = clamp01(rain[i] / p.fertilityIdealRain)

      let value = elevationFactor * p.fertilityElevationWeight
        + slopeFactor * p.fertilitySlopeWeight
        + rainFactor * p.fertilityRainWeight

      if (distanceToRiver[i] <= floodplainRadiusCells) {
        value += p.riverFloodplainBonus
      }

      const signedNoise = fbm2D(fertilitySeed, x * freqX, y * freqY, 4, 2, 0.5) * 2 - 1
      value += signedNoise * p.fertilityNoiseWeight

      soil[i] = clampByte(clamp01(value) * 255)
    }
  }
}

/**
 * Computes arable and pastoral suitability scores (step 10, part 2) for
 * every land cell. Arable favours low-lying, fertile, moderately
 * rained land; pastoral favours higher ground (closer to the moor
 * line) and wetter land. Stored in the `arable` and `pastoral` layers
 * (0 to 255).
 *
 * Differentiates on relative elevation within the non-rock, non-moor
 * band rather than slope: this generator's terrain is overwhelmingly
 * flat everywhere except right at the rock threshold (erosion keeps
 * gradients gentle, per DESIGN 5.2 step 5), so slope alone almost
 * never varies enough to tell "hilly pasture" apart from "flat
 * farmland" — elevation does.
 *
 * @param {object} grid The world grid (arable and pastoral are written).
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {void}
 */
function computeArablePastoralScores(grid, mapgenRules) {
  const p = mapgenRules.soil
  const { width, height, water, elev, soil, rain, arable, pastoral } = grid

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (water[i] !== 0) continue

      const uplandRatio = clamp01(elev[i] / p.moorElevationMinMetres)
      const lowlandRatio = 1 - uplandRatio
      const fertility01 = soil[i] / 255
      const rainModerate = clamp01(rain[i] / p.fertilityIdealRain)
      const rainHigh = rain[i] / 255

      const arableScore = clamp01(
        lowlandRatio * p.arableElevationWeight
        + fertility01 * p.arableFertilityWeight
        + rainModerate * p.arableRainWeight,
      )
      const pastoralScore = clamp01(
        uplandRatio * p.pastoralElevationWeight
        + fertility01 * p.pastoralFertilityWeight
        + rainHigh * p.pastoralRainWeight,
      )

      arable[i] = clampByte(arableScore * 255)
      pastoral[i] = clampByte(pastoralScore * 255)
    }
  }
}

/**
 * Classifies every cell into the `landuse` enum (step 10, part 3):
 * sea and lake from the water layer; then, for land, rock, moor, marsh,
 * forest, and finally arable/pastoral/mixed from the suitability
 * scores. The chain is exhaustive, so every land cell ends up with a
 * real class, never left at the array's default zero value.
 *
 * @param {object} grid The world grid (landuse is written).
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @returns {void}
 */
function classifyLanduse(grid, seed, mapgenRules, terrainRules) {
  const p = mapgenRules.soil
  const rockSlopeByte = p.rockSlopeRatio * mapgenRules.slope.quantizationScale
  const marshSlopeByte = p.marshMaxSlopeRatio * mapgenRules.slope.quantizationScale
  const L = buildLanduseIndex(terrainRules.landuseEnum)
  const { width, height, water, elev, slope, rain, soil, arable, pastoral, coast, landuse } = grid

  const distanceToRiverMouth = computeDistanceFromSources(grid, (i) => (coast[i] & COAST_FLAG.ESTUARY) !== 0)
  const marshRadiusCells = p.marshRiverMouthRadiusMiles / grid.cellMiles

  const forestSeed = hashString([seed, 'soil', 'forest'].join('|'))
  const freqX = 10 / width
  const freqY = 10 / height

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)

      if (water[i] === 1) {
        landuse[i] = L.SEA
        continue
      }
      if (water[i] === 2) {
        landuse[i] = L.LAKE
        continue
      }

      if (elev[i] >= p.mountainLineMetres || slope[i] >= rockSlopeByte) {
        landuse[i] = L.ROCK
        continue
      }

      if (elev[i] >= p.moorElevationMinMetres && elev[i] <= p.moorElevationMaxMetres) {
        landuse[i] = L.MOOR
        continue
      }

      const nearRiverMouth = distanceToRiverMouth[i] <= marshRadiusCells
      if (elev[i] <= p.marshMaxElevationMetres && slope[i] <= marshSlopeByte && (nearRiverMouth || rain[i] >= p.marshMinRain)) {
        landuse[i] = L.MARSH
        continue
      }

      const wetness = clamp01(rain[i] / 255)
      const fertilityMidBump = bump(soil[i], p.forestFertilityCentre, p.forestFertilityHalfWidth)
      const forestScore = wetness * fertilityMidBump
      // fbm2D averages several octaves, so its output clusters near 0.5
      // rather than spreading uniformly over [0, 1): it makes a poor
      // probability gate (comparing it against a small threshold almost
      // never succeeds) but a good *spatial perturbation*, giving forest
      // patches soft, noise-shaped edges rather than a hard cutoff.
      const forestNoise = fbm2D(forestSeed, x * freqX, y * freqY, 3, 2, 0.5)
      const perturbedForestScore = forestScore + (forestNoise - 0.5) * p.forestNoiseSpread
      if (rain[i] >= p.forestMinRain && perturbedForestScore > p.forestThreshold) {
        landuse[i] = L.FOREST
        continue
      }

      if (arable[i] > pastoral[i] + p.arablePastoralMargin) {
        landuse[i] = L.ARABLE
      } else if (pastoral[i] > arable[i] + p.arablePastoralMargin) {
        landuse[i] = L.PASTORAL
      } else {
        landuse[i] = L.MIXED
      }
    }
  }
}

/**
 * Promotes the highest pastoral-scoring arable or mixed cells to
 * pastoral when the natural classification falls short of DESIGN's
 * minimum share. Some islands are simply too flat and dry for the
 * suitability scores to produce enough separation on their own (a
 * handful of seeds generate wide, low-lying, wet terrain where almost
 * everything scores as arable or marsh): this guarantees the minimum
 * deterministically by promoting the best available candidates, the
 * same pattern used for T1.05's estuary-harbour guarantee, rather than
 * leaving it to chance.
 *
 * @param {object} grid The world grid (landuse is adjusted in place).
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @returns {void}
 */
function ensureMinimumPastoralShare(grid, mapgenRules, terrainRules) {
  const L = buildLanduseIndex(terrainRules.landuseEnum)
  const { landuse, pastoral } = grid
  const minFraction = mapgenRules.validation.minPastoralPercent / 100

  let landCount = 0
  let pastoralCount = 0
  for (let i = 0; i < landuse.length; i++) {
    if (landuse[i] === L.SEA || landuse[i] === L.LAKE) continue
    landCount++
    if (landuse[i] === L.PASTORAL) pastoralCount++
  }

  const needed = Math.ceil(minFraction * landCount) - pastoralCount
  if (needed <= 0) return

  const candidates = []
  for (let i = 0; i < landuse.length; i++) {
    if (landuse[i] === L.ARABLE || landuse[i] === L.MIXED) candidates.push(i)
  }
  candidates.sort((a, b) => pastoral[b] - pastoral[a])

  for (let k = 0; k < needed && k < candidates.length; k++) {
    landuse[candidates[k]] = L.PASTORAL
  }
}

/**
 * Generates soil and land use end to end (step 10): fertility, arable
 * and pastoral scores, the land-use classification, then a guarantee
 * that pastoral meets DESIGN's minimum share on every seed.
 *
 * @param {object} grid A world grid with elev/water/river/rain/slope/coast
 *   already populated; soil, arable, pastoral and landuse are written.
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @returns {void}
 */
export function generateSoil(grid, seed, mapgenRules, terrainRules) {
  computeFertility(grid, seed, mapgenRules)
  computeArablePastoralScores(grid, mapgenRules)
  classifyLanduse(grid, seed, mapgenRules, terrainRules)
  ensureMinimumPastoralShare(grid, mapgenRules, terrainRules)
}
