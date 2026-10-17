/**
 * The top-level map generation entry point (DESIGN.md 5.2 step 14):
 * runs the full pipeline (steps 1-13, T1.03-T1.11), validates the
 * result, and retries with a derived seed on failure, up to
 * mapgen.json's `validation.maxAttempts`.
 *
 * @module sim/mapgen/world
 */

import { createWorldGrid, indexOf } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { generateCoast } from './coast.js'
import { generateSoil } from './soil.js'
import { generateResources } from './resources.js'
import { generateSettlements } from './settlements.js'
import { generateLinks } from './links.js'
import { generateIndustries } from './industries.js'
import { validateWorld } from './validate.js'
import { GENERATOR_VERSION } from './pack.js'
import { createNameGenerator } from '../names.js'
import { createWorld } from '../state.js'

/** @type {readonly [number, number][]} All 8 neighbour offsets, for the rock-range flood fill. */
const NEIGHBOUR_OFFSETS_8 = Object.freeze([
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
])

/**
 * Finds 8-connected components of cells matching `match`, for naming
 * bays and mountain ranges from the grid (no discrete entity exists
 * for either, unlike settlements).
 *
 * @param {object} grid The world grid.
 * @param {(index: number) => boolean} match Which cells belong to a component.
 * @returns {number[][]} One array of cell indices per component.
 */
function findComponents(grid, match) {
  const { width, height } = grid
  const size = width * height
  const visited = new Uint8Array(size)
  const components = []

  for (let start = 0; start < size; start++) {
    if (!match(start) || visited[start]) continue

    const component = []
    const stack = [start]
    visited[start] = 1

    while (stack.length > 0) {
      const i = stack.pop()
      component.push(i)
      const x = i % width
      const y = Math.floor(i / width)

      for (const [dx, dy] of NEIGHBOUR_OFFSETS_8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const ni = indexOf(grid, nx, ny)
        if (match(ni) && !visited[ni]) {
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
 * Names the island itself, every bay region (from generateCoast) and
 * every sizeable connected rock component (a stand-in for a discrete
 * "mountain range" entity, which nothing else in the pipeline
 * extracts). DESIGN 5.7 asks for all of these; nothing before T1.12
 * had a point in the pipeline where bay/range *locations* were known
 * together with a name generator.
 *
 * @param {object} grid The world grid.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {number[][]} bayRegions From generateCoast().
 * @param {ReturnType<import('../names.js').createNameGenerator>} nameGen A name generator for this seed.
 * @returns {import('../state.js').WorldNames}
 */
function buildWorldNames(grid, terrainRules, bayRegions, nameGen) {
  const rockIndex = terrainRules.landuseEnum.indexOf('rock')
  const MIN_RANGE_CELLS = 10

  const rangeComponents = findComponents(grid, (i) => grid.landuse[i] === rockIndex)
    .filter((c) => c.length >= MIN_RANGE_CELLS)

  return {
    island: nameGen.islandName(),
    rivers: [], // no discrete river entity exists yet to attach a name to; see DECISIONS.md T1.12.
    bays: bayRegions.map(() => nameGen.bayName()),
    ranges: rangeComponents.map(() => nameGen.rangeName()),
  }
}

/**
 * Renumbers a second list of links to continue after the first list's
 * highest id, so merging two independently-generated link lists (the
 * main network and colliery tramways) never collides.
 *
 * @param {import('../state.js').Link[]} mainLinks The primary link list, ids kept as-is.
 * @param {import('../state.js').Link[]} extraLinks A second list to append, ids renumbered.
 * @returns {import('../state.js').Link[]} The combined list.
 */
function mergeLinks(mainLinks, extraLinks) {
  const maxId = mainLinks.reduce((max, l) => Math.max(max, l.id), 0)
  const renumbered = extraLinks.map((l, i) => ({ ...l, id: maxId + i + 1 }))
  return [...mainLinks, ...renumbered]
}

/**
 * Runs one generation attempt end to end: every pipeline step from
 * the island mask through industries, with the seed this attempt
 * actually uses.
 *
 * @param {string} effectiveSeed This attempt's seed (the save's own seed, or a derived retry seed).
 * @param {object} rules The validated rules bundle (mapgen, terrain, settlements, classes, names, industries).
 * @param {number} startYear The save's start year, for industry era gating.
 * @param {number} populationScale difficulty.json's `startingPopulationScale`.
 * @returns {object} Everything validateWorld() and the final World need.
 */
function runOneAttempt(effectiveSeed, rules, startYear, populationScale) {
  const { mapgen: mapgenRules, terrain: terrainRules, settlements: settlementsRules, classes: classesRules, names: namesRules, industries: industriesCatalogue } = rules

  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  generateIsland(grid, effectiveSeed, mapgenRules)
  generateRain(grid, mapgenRules.climate)
  const { flowTo } = generateHydrology(grid, mapgenRules.hydrology)
  generateSlope(grid, mapgenRules.slope)
  const { harbourCandidates, bayRegions } = generateCoast(grid, mapgenRules)
  generateSoil(grid, effectiveSeed, mapgenRules, terrainRules)
  const deposits = generateResources(grid, effectiveSeed, mapgenRules)

  const nameGen = createNameGenerator(effectiveSeed, namesRules)
  const settlements = generateSettlements(grid, effectiveSeed, mapgenRules, settlementsRules, terrainRules, classesRules, nameGen, populationScale)
  const mainLinks = generateLinks(grid, effectiveSeed, mapgenRules, terrainRules, settlements)
  const { industries, tramwayLinks } = generateIndustries(grid, effectiveSeed, mapgenRules, industriesCatalogue, terrainRules, settlements, deposits, startYear, mainLinks)
  const links = mergeLinks(mainLinks, tramwayLinks)

  const names = buildWorldNames(grid, terrainRules, bayRegions, nameGen)

  return { grid, flowTo, harbourCandidates, settlements, links, industries, deposits, names }
}

/**
 * Generates a complete, validated `World` (DESIGN 5.2 step 14):
 * repeats `runOneAttempt()` with a seed derived from `seed + attempt`
 * until `validateWorld()` passes or `maxAttempts` is used up.
 *
 * @param {string} seed The save's seed, as entered or chosen by the player.
 * @param {string} difficultyId A difficulty.json id (e.g. "normal").
 * @param {object} rules The validated rules bundle (mapgen, terrain, settlements, classes, names, industries, difficulty).
 * @param {number} [startYear] The save's start year (default 1830, DESIGN's own game start).
 * @returns {{world: import('../state.js').World, attempt: number, generationTimeMs: number}}
 * @throws {Error} If no attempt validates within `maxAttempts`.
 */
export function generateWorld(seed, difficultyId, rules, startYear = 1830) {
  const difficultyDef = rules.difficulty.find((d) => d.id === difficultyId)
  if (!difficultyDef) {
    throw new Error(`generateWorld: unknown difficulty "${difficultyId}".`)
  }

  const maxAttempts = rules.mapgen.validation.maxAttempts
  let lastErrors = []

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const effectiveSeed = attempt === 0 ? seed : `${seed}-${attempt}`
    const start = Date.now()

    const result = runOneAttempt(effectiveSeed, rules, startYear, difficultyDef.startingPopulationScale)
    const generationTimeMs = Date.now() - start

    const { valid, errors } = validateWorld({
      grid: result.grid,
      flowTo: result.flowTo,
      harbourCandidates: result.harbourCandidates,
      settlements: result.settlements,
      links: result.links,
      deposits: result.deposits,
      generationTimeMs,
      mapgenRules: rules.mapgen,
      terrainRules: rules.terrain,
      settlementsRules: rules.settlements,
    })

    if (valid) {
      const world = createWorld(
        {
          seed,
          attempt,
          generatorVersion: GENERATOR_VERSION,
          startYear,
          difficulty: difficultyId,
          name: result.names.island,
        },
        result.grid,
        result.harbourCandidates,
        result.names,
        result.settlements,
        result.industries,
        result.links,
      )
      return { world, attempt, generationTimeMs }
    }

    lastErrors = errors
  }

  throw new Error(`generateWorld: seed "${seed}" failed to validate after ${maxAttempts} attempts. Last errors: ${lastErrors.join('; ')}`)
}
