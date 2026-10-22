import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from './rules.js'
import { generateWorld } from './mapgen/world.js'
import { createGameState } from './state.js'
import { checksum } from './checksum.js'
import { runYears } from './tick.js'
import { createSimWorkerCore } from './simWorkerCore.js'

/**
 * PHASES.md T2.11's own "Done when": sim results driven through the
 * worker-side core are byte-identical (checksum) to the main-thread
 * `runYears()` path. `self`/`postMessage` live only in
 * `workers/simWorker.js`, never here, so this drives the exact same
 * logic the real worker calls, with no Worker/DOM needed at all.
 */

const SEED = 'ironway-001'
const DIFFICULTY_ID = 'normal'
const DAYS_PER_YEAR = 360

let rules

beforeAll(async () => {
  rules = await loadRulesNode('public/data')
})

/** @returns {{world: import('./state.js').World, gameState: import('./state.js').GameState}} A freshly generated world and a fresh starting GameState built from it — a new object graph every call, even for the same seed, so two independent runs never share mutable state. */
function freshGame(seed) {
  const { world } = generateWorld(seed, DIFFICULTY_ID, rules)
  const difficultyDef = rules.difficulty.find((d) => d.id === DIFFICULTY_ID)

  const gameState = createGameState(
    world.settlements,
    world.industries,
    world.links,
    { level: rules.economy.startingEconomyLevel, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
    { name: 'Test Co', cash: difficultyDef.startingCash, loans: 0, rankKey: 'novice', stats: {} },
    [],
    [],
  )

  return { world, gameState }
}

describe('createSimWorkerCore: byte-identical to the main-thread runYears() path', () => {
  it('produces the same checksum as runYears() over the same seed and day count', () => {
    const mainThread = freshGame(SEED)
    runYears({ world: mainThread.world, gameState: mainThread.gameState, rules, seed: SEED, gameDay: 0 }, 2)
    const mainThreadChecksum = checksum(mainThread.gameState)

    const worker = freshGame(SEED)
    const core = createSimWorkerCore({ world: worker.world, gameState: worker.gameState, rules, seed: SEED, gameDay: 0 })
    core.advanceDays(2 * DAYS_PER_YEAR)
    const workerChecksum = checksum(worker.gameState)

    expect(workerChecksum).toBe(mainThreadChecksum)
  }, 30000)

  it('produces the same checksum whether the worker core is driven in one call or many small ones', () => {
    const oneCall = freshGame(SEED)
    const oneCallCore = createSimWorkerCore({ world: oneCall.world, gameState: oneCall.gameState, rules, seed: SEED, gameDay: 0 })
    oneCallCore.advanceDays(DAYS_PER_YEAR)

    const manyCalls = freshGame(SEED)
    const manyCallsCore = createSimWorkerCore({ world: manyCalls.world, gameState: manyCalls.gameState, rules, seed: SEED, gameDay: 0 })
    // The real worker's own clock loop advances by whatever `computeAdvanceStep()`
    // produces each tick — rarely a whole year at once — so this is the
    // closer-to-real-usage shape, not just a convenience for the test.
    for (let i = 0; i < DAYS_PER_YEAR; i += 7) {
      manyCallsCore.advanceDays(Math.min(7, DAYS_PER_YEAR - i))
    }

    expect(checksum(manyCalls.gameState)).toBe(checksum(oneCall.gameState))
  }, 30000)
})

describe('createSimWorkerCore: protocol-level behaviour', () => {
  it('reports no dirty patch for a span that crosses no month or year boundary', () => {
    const { world, gameState } = freshGame(SEED)
    const core = createSimWorkerCore({ world, gameState, rules, seed: SEED, gameDay: 0 })

    const result = core.advanceDays(5) // DAYS_PER_MONTH is 30; day 5 crosses nothing.
    expect(result.gameDay).toBe(5)
    expect(result.dirty).toBeNull()
  })

  it('reports a dirty patch on a month boundary, carrying exactly the new history row', () => {
    const { world, gameState } = freshGame(SEED)
    const core = createSimWorkerCore({ world, gameState, rules, seed: SEED, gameDay: 0 })

    const result = core.advanceDays(30)
    expect(result.dirty).not.toBeNull()
    expect(result.dirty.gameDay).toBe(30)
    expect(result.dirty.historyMonthlyNew).toHaveLength(1)
    expect(result.dirty.settlements.length).toBe(gameState.settlements.length)
    expect(result.dirty.industries.length).toBe(gameState.industries.length)
    expect(result.dirty.links.length).toBe(gameState.links.length)
  })

  it('never repeats an already-reported history or events row across two patches', () => {
    const { world, gameState } = freshGame(SEED)
    const core = createSimWorkerCore({ world, gameState, rules, seed: SEED, gameDay: 0 })

    const first = core.advanceDays(30)
    const second = core.advanceDays(30)

    expect(first.dirty.historyMonthlyNew).toHaveLength(1)
    expect(second.dirty.historyMonthlyNew).toHaveLength(1)
    expect(second.dirty.historyMonthlyNew[0]).not.toBe(first.dirty.historyMonthlyNew[0])
    expect(gameState.historyMonthly).toHaveLength(2)
  })

  it('getDay() and getSnapshot() agree with the running gameDay', () => {
    const { world, gameState } = freshGame(SEED)
    const core = createSimWorkerCore({ world, gameState, rules, seed: SEED, gameDay: 0 })

    core.advanceDays(45)
    expect(core.getDay()).toBe(45)
    const snapshot = core.getSnapshot()
    expect(snapshot.gameDay).toBe(45)
    expect(snapshot.gameState).toBe(gameState)
  })

  describe('applyDebugAction', () => {
    it('forceClosure closes an open industry and logs an event, returning a patch', () => {
      const { world, gameState } = freshGame(SEED)
      const core = createSimWorkerCore({ world, gameState, rules, seed: SEED, gameDay: 10 })
      const industry = gameState.industries.find((i) => i.closedDay === null)

      const patch = core.applyDebugAction({ type: 'forceClosure', industryId: industry.id })

      expect(industry.closedDay).toBe(10)
      expect(patch.eventsLogNew).toHaveLength(1)
      expect(patch.eventsLogNew[0].kind).toBe('industry_closed')
      expect(patch.eventsLogNew[0].subjectId).toBe(industry.id)
    })

    it('forceClosure on an already-closed industry is a no-op', () => {
      const { world, gameState } = freshGame(SEED)
      const core = createSimWorkerCore({ world, gameState, rules, seed: SEED, gameDay: 10 })
      const industry = gameState.industries[0]
      industry.closedDay = 1

      const patch = core.applyDebugAction({ type: 'forceClosure', industryId: industry.id })

      expect(industry.closedDay).toBe(1)
      expect(patch.eventsLogNew).toHaveLength(0)
    })

    it('addStock adds the given quantity of cargo to a settlement', () => {
      const { world, gameState } = freshGame(SEED)
      const core = createSimWorkerCore({ world, gameState, rules, seed: SEED, gameDay: 0 })
      const settlement = gameState.settlements[0]
      const before = settlement.stock.coal || 0

      core.applyDebugAction({ type: 'addStock', settlementId: settlement.id, cargoId: 'coal', qty: 50 })

      expect(settlement.stock.coal).toBe(before + 50)
    })
  })
})
