import { useCallback, useEffect, useRef, useState } from 'react'
import { loadRulesBrowser } from '../sim/rules.js'
import { createWorld, fromRows, toRows } from '../sim/state.js'
import { unpackWorld } from '../sim/mapgen/pack.js'
import { createTickCaches } from '../sim/tick.js'
import { createSimWorkerClient } from './simWorkerClient.js'
import { createAutosaveScheduler } from './autosave.js'
import * as savesApi from '../api/saves.js'

/**
 * Owns a live, running island for the Inspector (DESIGN 4.2/4.4):
 * loads a save and ticks it in `workers/simWorker.js` (PHASES.md
 * T2.11 moved this off the main thread; before that it called
 * `sim/tick.js` directly here). `worldRef`/`gameStateRef` are now a
 * read-only mirror of the worker's own canonical state, patched only by
 * `applyDirtyPatch()` whenever the worker reports a `dirty` message —
 * nothing else may mutate them, which is what makes "autosave reads
 * from the mirror" (PHASES.md's own wording) literally true rather than
 * just a description of where the data happens to live. `gameDay` and
 * `renderTick` are still the only *reactive* state, for the same reason
 * as before T2.11: cloning every settlement/industry on every tick into
 * `setState` would be wasteful when nothing here needs React to know
 * about the contents, only that a redraw is due.
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
 * hook two *separate* copies of every entity — applying a worker's
 * `dirty` patch to the one the mirror actually reads (`gameState`)
 * would silently never show up on `world`, which the UI reads from too.
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
 * Merges a worker-sent entity array into the mirror's own array,
 * updating existing entities' fields in place (so anything holding a
 * reference to one of them — `caches.settlementsById`'s Map values, for
 * instance — sees the update too, rather than reading a stale object
 * the merge silently replaced) and appending any id not seen before
 * (a newly opened industry; nothing in this sim ever deletes a row
 * outright, so `incoming` is always a superset of `target`'s own ids
 * plus whatever's new).
 *
 * @param {{id: number}[]} target The mirror's own array, mutated in place.
 * @param {{id: number}[]} incoming The worker's current array for the same entity type.
 * @returns {void}
 */
function mergeEntitiesById(target, incoming) {
  const byId = new Map(target.map((entity) => [entity.id, entity]))
  for (const entity of incoming) {
    const existing = byId.get(entity.id)
    if (existing) {
      Object.assign(existing, entity)
    } else {
      target.push(entity)
      byId.set(entity.id, entity)
    }
  }
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
  const [workerCrashed, setWorkerCrashed] = useState(false)
  const [selectedSettlementId, setSelectedSettlementId] = useState(null)

  const worldRef = useRef(null)
  const gameStateRef = useRef(null)
  const rulesRef = useRef(null)
  const cachesRef = useRef(null)
  const versionRef = useRef(null)
  const clientRef = useRef(null)
  const schedulerRef = useRef(null)
  const savedHistoryCountRef = useRef(0)
  const savedEventsCountRef = useRef(0)
  const monthsSinceSaveRef = useRef(0)
  // Mirrors the `gameDay` state so `checkpoint()` can read the latest
  // value without depending on it: the state changes every single
  // simulated day (via `onStep`), and `checkpoint` depending on it
  // directly would give `checkpoint`, then `load`, a new identity every
  // day — re-running the mount effect's whole load flow (and recreating
  // the worker) once a day, not just once per mount.
  const gameDayRef = useRef(0)

  const bumpRenderTick = useCallback(() => setRenderTick((t) => t + 1), [])

  /** @param {number} day @returns {void} Updates both the reactive `gameDay` state and `gameDayRef` together, so every caller only has to remember one function, not two. */
  const setGameDayBoth = useCallback((day) => {
    gameDayRef.current = day
    setGameDay(day)
  }, [])

  /**
   * Sends everything that's changed since the last successful
   * checkpoint, reading entirely off the mirror (`gameStateRef.current`)
   * — nothing else writes to it except `applyDirtyPatch()` below, so
   * this is always whatever the worker most recently reported, never
   * something this hook computed itself. `settlements`/`industries`/
   * `links`/`economyState`/`company` are idempotent upserts (DESIGN
   * 8.2's primary keys), so the *current* full arrays are sent every
   * time; `historyMonthly`/`eventsLog` only send rows added since the
   * last successful checkpoint, capped at the server's own limits.
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
        gameDay: gameDayRef.current,
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

  /**
   * Merges a worker `dirty` message into the mirror, bumps the render
   * tick, and counts the new month(s) toward the next autosave — the
   * worker has no idea autosave cadence exists at all, so that
   * bookkeeping stays here, the same main-thread responsibility it
   * always was.
   *
   * @param {object} patch See `sim/simWorkerCore.js`'s own `MirrorPatch` typedef.
   * @returns {void}
   */
  const applyDirtyPatch = useCallback((patch) => {
    const gameState = gameStateRef.current
    if (!gameState) return

    mergeEntitiesById(gameState.settlements, patch.settlements)
    mergeEntitiesById(gameState.industries, patch.industries)
    mergeEntitiesById(gameState.links, patch.links)
    Object.assign(gameState.economyState, patch.economyState)
    Object.assign(gameState.company, patch.company)
    gameState.historyMonthly.push(...patch.historyMonthlyNew)
    gameState.eventsLog.push(...patch.eventsLogNew)

    setGameDayBoth(patch.gameDay)
    bumpRenderTick()

    if (patch.historyMonthlyNew.length > 0) {
      monthsSinceSaveRef.current += patch.historyMonthlyNew.length
      const every = rulesRef.current?.client?.autosaveEveryGameMonths ?? 3
      if (monthsSinceSaveRef.current >= every) {
        monthsSinceSaveRef.current = 0
        schedulerRef.current?.saveNow()
      }
    }
  }, [bumpRenderTick, setGameDayBoth])

  /**
   * Loads the save, builds the initial mirror, and starts a fresh sim
   * worker. Pulled out of the mount effect (rather than defined inline)
   * so a worker crash's recovery path (see `recover` below) can call
   * exactly the same flow again, reading the server's last checkpoint
   * from scratch — PHASES.md T2.11's own "the game can recover from the
   * last checkpoint" Done-when, made literal rather than a vague retry.
   *
   * @returns {() => void} A cleanup function.
   */
  const load = useCallback(() => {
    let cancelled = false

    /** @param {boolean} hidden @returns {void} */
    function handleVisibilityChange() {
      clientRef.current?.setHidden(document.visibilityState === 'hidden')
    }

    async function run() {
      setStatus('loading')
      setWorkerCrashed(false)
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
        versionRef.current = session.version
        savedHistoryCountRef.current = session.gameState.historyMonthly.length
        savedEventsCountRef.current = session.gameState.eventsLog.length
        monthsSinceSaveRef.current = 0
        // Static lookups only (never mutated), built the same way on the
        // main thread purely for the Inspector's own tables — the
        // worker builds its own, identical copy independently for
        // `runMonth()`'s use, the two never need to be the same object.
        cachesRef.current = createTickCaches(session.world, session.gameState, rules)
        setGameDayBoth(session.gameDay)

        const client = createSimWorkerClient({
          onStep: setGameDayBoth,
          onDirty: applyDirtyPatch,
          onError: (message) => {
            console.error('Sim worker error:', message)
            setWorkerCrashed(true)
            setErrorMessage(message)
            schedulerRef.current?.stop()
          },
        })
        client.init({
          world: session.world,
          gameState: session.gameState,
          rules,
          seed: session.seed,
          gameDay: session.gameDay,
          speed: 0,
        })
        clientRef.current = client
        setSpeedValue(0)

        document.addEventListener('visibilitychange', handleVisibilityChange)

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

    run()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clientRef.current?.destroy()
      clientRef.current = null
      schedulerRef.current?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, applyDirtyPatch, checkpoint])

  // Holds whichever `load()` call's cleanup is currently live, so
  // `recover()` can tear down the crashed run's listener/client/scheduler
  // (via the exact same cleanup `load()` already returns) before
  // starting a fresh one, rather than leaking the old `visibilitychange`
  // listener forever on every crash-and-recover cycle.
  const cleanupRef = useRef(null)

  useEffect(() => {
    cleanupRef.current = load()
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [load])

  const setSpeed = useCallback((newSpeed) => {
    clientRef.current?.setSpeed(newSpeed)
    setSpeedValue(newSpeed)
  }, [])

  /**
   * Re-runs the whole load flow against a freshly created worker,
   * discarding the crashed one and anything the mirror held past the
   * server's last successful checkpoint — the only data a worker crash
   * can't have corrupted, since the server only ever has what a
   * completed `checkpoint()` call sent it.
   *
   * @returns {void}
   */
  const recover = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = load()
  }, [load])

  /**
   * Debug action: closes an open industry immediately, as if it had
   * failed the lifecycle's own closure rule this instant. Routed
   * through the worker (PHASES.md T2.11: it alone may mutate
   * `gameState` now) rather than applied locally; the mirror only
   * updates once the resulting `dirty` message comes back.
   *
   * @param {number} industryId
   * @returns {void}
   */
  const forceClosure = useCallback((industryId) => {
    clientRef.current?.debugAction({ type: 'forceClosure', industryId })
  }, [])

  /**
   * Debug action: adds stock of one cargo to a settlement. Same
   * worker-routed convention as `forceClosure`.
   *
   * @param {number} settlementId
   * @param {string} cargoId
   * @param {number} qty Tonnes to add (must be positive).
   * @returns {void}
   */
  const addStock = useCallback((settlementId, cargoId, qty) => {
    if (!(qty > 0)) return
    clientRef.current?.debugAction({ type: 'addStock', settlementId, cargoId, qty })
  }, [])

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
    workerCrashed,
    recover,
    saveNow: () => schedulerRef.current?.saveNow(),
    selectedSettlementId,
    selectSettlement: setSelectedSettlementId,
    forceClosure,
    addStock,
  }
}
