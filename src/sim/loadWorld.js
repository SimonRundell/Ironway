import { createWorld, fromRows } from './state.js'
import { unpackWorld } from './mapgen/pack.js'

/**
 * Reconstructs a `GameState` from a saves/load.php response. The
 * response's own keys (settlements, settlementPop, industries, links,
 * economyState, company, historyMonthly, eventsLog) already match
 * fromRows()'s expected shape — no reshaping needed.
 *
 * @param {object} loadResponse The decoded body from api/saves.js's load().
 * @returns {import('./state.js').GameState}
 */
export function buildGameStateFromLoadResponse(loadResponse) {
  return fromRows(loadResponse)
}

/**
 * Reconstructs a `World` from a saves/load.php response plus the
 * separately-fetched map blob. `harbours` and the river/bay/range name
 * lists are not reconstructed: DESIGN's own schema never persists them
 * (see DECISIONS.md T1.08) — they are generation-time-only data, not a
 * regression introduced by loading. The island's own name *is*
 * recovered: `generateWorld()` sets `world.meta.name` to the
 * procedurally generated island name (sim/mapgen/world.js), which
 * travels through create.php straight into `saves.name` and back out
 * through `save.name` here — no separate field needed.
 *
 * @param {object} loadResponse The decoded body from api/saves.js's load().
 * @param {Uint8Array} mapBlobBytes The raw bytes from api/saves.js's getMapBlob().
 * @returns {{world: import('./state.js').World, gameDay: number, version: number}}
 */
export function buildWorldFromLoadResponse(loadResponse, mapBlobBytes) {
  const { grid, generatorVersion } = unpackWorld(mapBlobBytes)
  const gameState = fromRows(loadResponse)
  const save = loadResponse.save

  const meta = {
    seed: save.seed,
    attempt: save.attempt,
    generatorVersion,
    startYear: save.startYear,
    difficulty: save.difficulty,
    name: save.name,
  }

  const names = {
    island: save.name,
    rivers: [],
    bays: [],
    ranges: [],
  }

  const world = createWorld(meta, grid, [], names, gameState.settlements, gameState.industries, gameState.links)

  return { world, gameDay: save.gameDay, version: save.version }
}
