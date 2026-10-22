import { advanceDays } from './clock.js'
import { createTickCaches, runMonth, runYearEnd } from './tick.js'

/**
 * The worker-side sim driver (PHASES.md T2.11, DESIGN 4.2): every
 * stateful thing a running save needs between loading and
 * checkpointing, with no `self`/`postMessage`/DOM reference anywhere in
 * this file, so it can be driven directly by a Vitest test exactly as
 * `src/workers/simWorker.js` drives it for real, and so DESIGN 4.2's
 * "the sim module has no DOM or React imports" promise extends to this
 * module too, not just `tick.js` itself.
 *
 * `src/workers/simWorker.js` is the thin message-protocol wrapper
 * around this: it owns `self.onmessage`/`postMessage` and the worker's
 * own `setInterval`-driven clock loop (Workers have no
 * `requestAnimationFrame`), and calls straight into the functions
 * here for every actual state change.
 *
 * @module sim/simWorkerCore
 */

/**
 * @typedef {object} MirrorPatch
 * @property {number} gameDay
 * @property {import('./state.js').Settlement[]} settlements Full current array (see DECISIONS.md: sent whole, not diffed — virtually every settlement's population/stock/confidence changes every month regardless, so per-entity dirty-diffing buys little for a Phase 1/2-sized island and isn't worth the extra bookkeeping surface yet).
 * @property {import('./state.js').Industry[]} industries Full current array.
 * @property {import('./state.js').Link[]} links Full current array.
 * @property {object} economyState
 * @property {object} company
 * @property {object[]} historyMonthlyNew Only the rows appended since the last patch (append-only, same slicing convention `useGameSession.js`'s own `checkpoint()` already used before T2.11).
 * @property {object[]} eventsLogNew Only the rows appended since the last patch.
 */

/**
 * Builds a worker-side sim session: owns `world`/`gameState`/`caches`
 * and the bookkeeping needed to report only new history/event rows
 * each time, without ever touching `self`, `postMessage` or any DOM
 * global.
 *
 * @param {object} options
 * @param {import('./state.js').World} options.world
 * @param {import('./state.js').GameState} options.gameState
 * @param {object} options.rules The full validated rules bundle.
 * @param {string} options.seed
 * @param {number} options.gameDay The starting `gameDay`.
 * @returns {{
 *   advanceDays: (days: number) => {gameDay: number, dirty: MirrorPatch|null},
 *   applyDebugAction: (action: {type: 'forceClosure', industryId: number}|{type: 'addStock', settlementId: number, cargoId: string, qty: number}) => MirrorPatch,
 *   getSnapshot: () => {gameDay: number, gameState: import('./state.js').GameState},
 *   getDay: () => number,
 * }}
 */
export function createSimWorkerCore({ world, gameState, rules, seed, gameDay }) {
  const caches = createTickCaches(world, gameState, rules)
  let day = gameDay
  let lastHistoryCount = gameState.historyMonthly.length
  let lastEventsCount = gameState.eventsLog.length

  /** @returns {MirrorPatch} */
  function buildPatch() {
    const patch = {
      gameDay: day,
      settlements: gameState.settlements,
      industries: gameState.industries,
      links: gameState.links,
      economyState: gameState.economyState,
      company: gameState.company,
      historyMonthlyNew: gameState.historyMonthly.slice(lastHistoryCount),
      eventsLogNew: gameState.eventsLog.slice(lastEventsCount),
    }
    lastHistoryCount = gameState.historyMonthly.length
    lastEventsCount = gameState.eventsLog.length
    return patch
  }

  return {
    /**
     * Advances the calendar by `days` whole days, running `runMonth()`/
     * `runYearEnd()` on whichever boundaries fall within that span —
     * the exact same `sim/clock.js` hooks `sim/tick.js`'s own
     * `runYears()` uses, so a worker-driven run and a direct
     * `runYears()` call over the same seed are identical by
     * construction, not just by intent (see `simWorkerCore.test.js`'s
     * own checksum proof).
     *
     * @param {number} days
     * @returns {{gameDay: number, dirty: MirrorPatch|null}} `dirty` is `null` if `days` didn't cross a month or year boundary (e.g. 0 days, or fewer days than one month needs while paused/slow).
     */
    advanceDays(days) {
      let changed = false
      day = advanceDays(day, days, {
        onMonth: (d) => {
          runMonth({ world, gameState, rules, seed, gameDay: d, caches })
          changed = true
        },
        onYearEnd: () => {
          runYearEnd(gameState, caches, rules)
          changed = true
        },
      })
      return { gameDay: day, dirty: changed ? buildPatch() : null }
    },

    /**
     * Applies one of `useGameSession.js`'s own debug actions (moved
     * here from the main thread now that the worker is the only thing
     * allowed to mutate `gameState` — see DECISIONS.md) and returns the
     * resulting patch so the caller can push it to the mirror the same
     * way a month tick's `dirty` patch would be.
     *
     * @param {{type: 'forceClosure', industryId: number}|{type: 'addStock', settlementId: number, cargoId: string, qty: number}} action
     * @returns {MirrorPatch}
     */
    applyDebugAction(action) {
      if (action.type === 'forceClosure') {
        const industry = gameState.industries.find((i) => i.id === action.industryId)
        if (industry && industry.closedDay === null) {
          industry.closedDay = day
          gameState.eventsLog.push({
            id: null, gameDay: day, kind: 'industry_closed', subjectType: 'industry', subjectId: industry.id,
            text: `${industry.name}: closed by debug action`,
          })
        }
      } else if (action.type === 'addStock') {
        const settlement = gameState.settlements.find((s) => s.id === action.settlementId)
        if (settlement && action.qty > 0) {
          settlement.stock[action.cargoId] = (settlement.stock[action.cargoId] || 0) + action.qty
        }
      }
      return buildPatch()
    },

    /** @returns {{gameDay: number, gameState: import('./state.js').GameState}} A full snapshot, for an explicit `snapshot` request (checkpoint-time sync, or proving byte-identical determinism). */
    getSnapshot() {
      return { gameDay: day, gameState }
    },

    /** @returns {number} */
    getDay() {
      return day
    },
  }
}
