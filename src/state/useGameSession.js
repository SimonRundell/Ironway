import { useCallback, useEffect, useRef, useState } from 'react'
import { loadRulesBrowser } from '../sim/rules.js'
import { createWorld, fromRows, toRows } from '../sim/state.js'
import { unpackWorld } from '../sim/mapgen/pack.js'
import { createTickCaches, runMonth, runYearEnd } from '../sim/tick.js'
import { createClockRunner } from './clockRunner.js'
import { createAutosaveScheduler } from './autosave.js'
import * as savesApi from '../api/saves.js'

/**
 * Owns a live, running island for the Inspector (DESIGN 4.2/4.4):
 * loads a save, ticks it in the main thread via `sim/tick.js`, and
 * checkpoints it back to the server. `world` and `gameState` are kept
 * as refs (not React state) since `runMonth()` mutates their entities
 * in place every month — wrapping that in `setState` every tick would
 * mean cloning potentially thousands of industries each time. Instead,
 * two small counters (`gameDay`, `renderTick`) are the only reactive
 * state: `gameDay` updates every simulated day (cheap, just a number,
 * batched by React even across several days in one animation frame),
 * `renderTick` only on month boundaries and after a debug action,
 * which is when anything the tables show could actually have changed.
 *
 * @module state/useGameSession
 */

/** @type {number} Matches `api/lib/saves.php`'s `MAX_HISTORY_ROWS_PER_CHECKPOINT`. */
const MAX_HISTORY_ROWS_PER_CHECKPOINT = 50
/** @type {number} Matches `api/lib/saves.php`'s `MAX_EVENTS_PER_CHECKPOINT`. */
const MAX_EVENTS_PER_CHECKPOINT = 300

/**
 * Builds a `World` and a `GameState` that share the exact same
 * settlement/industry/link array references, from one
 * `saves/load.php` response. Deliberately not `sim/loadWorld.js`'s own
 * helpers: those call `fromRows()` independently for `World` and
 * `GameState` each time they're both needed, which would hand this
 * hook two *separate* copies of every entity — mutating the one
 * `runMonth()` actually ticks (`gameState`) would silently never show
 * up on `world`, which the UI would be reading from by mistake.
 *
 * @param {object} loadResponse The decoded body from `api/saves.js`'s `load()`.
 * @param {Uint8Array} mapBytes The raw bytes from `api/saves.js`'s `getMapBlob()`.
 * @returns {{world: import('../sim/state.js').World, gameState: import('../sim/state.js').GameState, gameDay: number, version: number, seed: string}}
 */
function buildSession(loadResponse, mapBytes) {
  const { grid, generatorVersion } = unpackWorld(mapBytes)
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
  const names = { island: save.name, rivers: [], bays: [], ranges: [] }
  const world = createWorld(meta, grid, [], names, gameState.settlements, gameState.industries, gameState.links)

  return { world, gameState, gameDay: save.gameDay, version: save.version, seed: save.seed }
}

/**
 * @param {number} saveId The save to load and run.
 * @returns {object} See the return statement below for the full shape.
 */
export function useGameSession(saveId) {
  const [status, setStatus] = useState('loading') // 'loading' | 'ready' | 'error'
  const [errorMessage, setErrorMessage] = useState('')
  const [speed, setSpeedValue] = useState(0)
  const [gameDay, setGameDay] = useState(0)
  const [renderTick, setRenderTick] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [selectedSettlementId, setSelectedSettlementId] = useState(null)

  const worldRef = useRef(null)
  const gameStateRef = useRef(null)
  const rulesRef = useRef(null)
  const cachesRef = useRef(null)
  const seedRef = useRef(null)
  const versionRef = useRef(null)
  const runnerRef = useRef(null)
  const schedulerRef = useRef(null)
  const savedHistoryCountRef = useRef(0)
  const savedEventsCountRef = useRef(0)
  const monthsSinceSaveRef = useRef(0)

  const bumpRenderTick = useCallback(() => setRenderTick((t) => t + 1), [])

  /**
   * Sends everything that's changed since the last successful
   * checkpoint. `settlements`/`industries`/`links`/`economyState`/
   * `company` are idempotent upserts (DESIGN 8.2's primary keys), so
   * the *current* full arrays are sent every time — simpler than real
   * dirty-tracking and, at these row counts (well under the server's
   * caps), cheap enough not to matter. `historyMonthly`/`eventsLog`
   * are different: history upserts are still idempotent but would
   * exceed the server's per-checkpoint row cap over a long game if
   * resent in full, and `eventsLog` is a plain append-only insert
   * (DESIGN: resending an old event row would duplicate it) — so only
   * the rows added since the last successful checkpoint are sent,
   * capped at the server's own limits (a dev-inspector-acceptable
   * simplification: an extreme month's overflow past the cap is
   * silently dropped from persistence rather than retried forever).
   *
   * @returns {Promise<void>}
   */
  const checkpoint = useCallback(async () => {
    const gameState = gameStateRef.current
    if (!gameState || versionRef.current === null) return

    const rows = toRows(gameState)
    const newHistory = rows.historyMonthly.slice(savedHistoryCountRef.current).slice(0, MAX_HISTORY_ROWS_PER_CHECKPOINT)
    const newEvents = rows.eventsLog.slice(savedEventsCountRef.current).slice(0, MAX_EVENTS_PER_CHECKPOINT)

    try {
      const result = await savesApi.checkpoint({
        id: saveId,
        baseVersion: versionRef.current,
        gameDay: runnerRef.current.getDay(),
        settlements: rows.settlements,
        settlementPop: rows.settlementPop,
        industries: rows.industries,
        links: rows.links,
        economyState: rows.economyState,
        company: rows.company,
        historyMonthly: newHistory,
        eventsLog: newEvents,
      })
      versionRef.current = result.version
      savedHistoryCountRef.current = gameState.historyMonthly.length
      savedEventsCountRef.current = gameState.eventsLog.length
    } catch (err) {
      if (err.response?.status === 409) {
        setConflict(true)
      } else {
        console.error('Checkpoint failed:', err)
      }
    }
  }, [saveId])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setStatus('loading')
      try {
        const [loadResponse, mapBytes, rules] = await Promise.all([
          savesApi.load(saveId),
          savesApi.getMapBlob(saveId),
          loadRulesBrowser(),
        ])
        if (cancelled) return

        const session = buildSession(loadResponse, mapBytes)
        worldRef.current = session.world
        gameStateRef.current = session.gameState
        rulesRef.current = rules
        seedRef.current = session.seed
        versionRef.current = session.version
        savedHistoryCountRef.current = session.gameState.historyMonthly.length
        savedEventsCountRef.current = session.gameState.eventsLog.length
        cachesRef.current = createTickCaches(session.world, session.gameState, rules)
        // The clock runner only calls onDay once a day actually advances, which never happens
        // while paused — without this, a loaded save's date display would be stuck at the
        // default (0) until the player picks a speed, even though the loaded data itself is
        // already from whatever day it was last saved at.
        setGameDay(session.gameDay)

        const runner = createClockRunner({
          startDay: session.gameDay,
          msPerDayAt1x: rules.client?.msPerDayAt1x ?? 500,
          maxDaysPerFrame: rules.client?.maxDaysPerFrame ?? 8,
          pauseOnHidden: rules.client?.pauseOnHidden ?? true,
          hooks: {
            onDay: (day) => setGameDay(day),
            onMonth: (day) => {
              runMonth({
                world: worldRef.current,
                gameState: gameStateRef.current,
                rules: rulesRef.current,
                seed: seedRef.current,
                gameDay: day,
                caches: cachesRef.current,
              })
              setRenderTick((t) => t + 1)

              monthsSinceSaveRef.current += 1
              const every = rules.client?.autosaveEveryGameMonths ?? 3
              if (monthsSinceSaveRef.current >= every) {
                monthsSinceSaveRef.current = 0
                schedulerRef.current?.saveNow()
              }
            },
            onYearEnd: () => runYearEnd(gameStateRef.current, cachesRef.current, rulesRef.current),
          },
        })
        runner.start()
        runnerRef.current = runner

        const scheduler = createAutosaveScheduler({ onSave: () => checkpoint() })
        scheduler.start()
        schedulerRef.current = scheduler

        setStatus('ready')
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err.response?.data?.error?.message ?? err.message)
          setStatus('error')
        }
      }
    }

    load()

    return () => {
      cancelled = true
      runnerRef.current?.stop()
      schedulerRef.current?.stop()
    }
  }, [saveId, checkpoint])

  const setSpeed = useCallback((newSpeed) => {
    runnerRef.current?.setSpeed(newSpeed)
    setSpeedValue(newSpeed)
  }, [])

  /**
   * Debug action: closes an open industry immediately, as if it had
   * failed the lifecycle's own closure rule this instant.
   *
   * @param {number} industryId
   * @returns {void}
   */
  const forceClosure = useCallback((industryId) => {
    const gameState = gameStateRef.current
    const industry = gameState?.industries.find((i) => i.id === industryId)
    if (!industry || industry.closedDay !== null) return

    const day = runnerRef.current.getDay()
    industry.closedDay = day
    gameState.eventsLog.push({
      id: null,
      gameDay: day,
      kind: 'industry_closed',
      subjectType: 'industry',
      subjectId: industry.id,
      text: `${industry.name}: closed by debug action`,
    })
    bumpRenderTick()
  }, [bumpRenderTick])

  /**
   * Debug action: adds stock of one cargo to a settlement.
   *
   * @param {number} settlementId
   * @param {string} cargoId
   * @param {number} qty Tonnes to add (must be positive).
   * @returns {void}
   */
  const addStock = useCallback((settlementId, cargoId, qty) => {
    if (!(qty > 0)) return
    const settlement = gameStateRef.current?.settlements.find((s) => s.id === settlementId)
    if (!settlement) return
    settlement.stock[cargoId] = (settlement.stock[cargoId] || 0) + qty
    bumpRenderTick()
  }, [bumpRenderTick])

  return {
    status,
    errorMessage,
    world: worldRef.current,
    gameState: gameStateRef.current,
    rules: rulesRef.current,
    caches: cachesRef.current,
    gameDay,
    renderTick,
    speed,
    setSpeed,
    conflict,
    dismissConflict: () => setConflict(false),
    saveNow: () => schedulerRef.current?.saveNow(),
    selectedSettlementId,
    selectSettlement: setSelectedSettlementId,
    forceClosure,
    addStock,
  }
}
