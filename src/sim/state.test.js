import { describe, expect, it } from 'vitest'
import { checksum } from './checksum.js'
import {
  createDirtyTracker, createGameState, createSimState, createWorld, fromRows, toRows,
} from './state.js'

/**
 * Builds a small but structurally complete synthetic `GameState` for
 * round-trip testing: one settlement with all three class populations,
 * one industry, one link, economy, company, one history row and one
 * event.
 *
 * @returns {ReturnType<typeof createGameState>}
 */
function buildSyntheticGameState() {
  const settlements = [{
    id: 1,
    name: 'Ashton',
    kind: 'town',
    x: 120.5,
    y: 64,
    portTier: 1,
    housing: 8000,
    regionCells: 42,
    pop: {
      0: { pop: 5000, employed: 4200, confidence: 55.5 },
      1: { pop: 1800, employed: 1700, confidence: 62 },
      2: { pop: 300, employed: 290, confidence: 70 },
    },
    stock: { coal: 120, flour: 40 },
  }]

  const industries = [{
    id: 1,
    typeId: 'coal_mine',
    name: 'Ashton Colliery',
    x: 121,
    y: 63,
    homeSettlementId: 1,
    capacity: 3000,
    utilisation: 0.82,
    richnessLeft: 0.9,
    openedDay: 0,
    closedDay: null,
    monthsLow: 0,
    stock: { coal: 200 },
  }]

  const links = [{
    id: 1,
    aType: 's',
    aId: 1,
    bType: 'i',
    bId: 1,
    mode: 'road',
    tier: 1,
    lengthMi: 3.2,
    gradient: 0.04,
    condition: 1,
    owner: 'public',
    path: [[120.5, 64], [121, 63]],
    recentFlow: {},
  }]

  const economyState = { level: 2, lastChangeDir: 0, lastCheckDay: 0, indicators: { trade: 1.0 } }
  const company = { name: 'Ashton Transport Co', cash: 50000, loans: 0, rankKey: 'novice', stats: { linesBuilt: 0 } }
  const historyMonthly = [{
    monthIndex: 0, popTotal: 7100, popU: 300, popM: 1800, popW: 5000,
    employment: 0.91, confidence: 60, tradeValue: 1250.5, level: 2, extra: {},
  }]
  const eventsLog = [{ id: 1, gameDay: 0, kind: 'founded', subjectType: 's', subjectId: 1, text: 'Ashton founded.' }]

  return createGameState(settlements, industries, links, economyState, company, historyMonthly, eventsLog)
}

describe('createWorld', () => {
  it('assembles every field into one object', () => {
    const world = createWorld(
      { seed: 'ironway-001', generatorVersion: 1, startYear: 1830, difficulty: 'normal', name: 'My Save' },
      null,
      [{ x: 10, y: 20, isEstuary: true, score: 0.8 }],
      { island: 'Avermere', rivers: ['Ash Water'], bays: ['North Bay'], ranges: ['Grey Hills'] },
      [],
      [],
      [],
    )

    expect(world.meta.seed).toBe('ironway-001')
    expect(world.grid).toBeNull()
    expect(world.harbours).toHaveLength(1)
    expect(world.names.island).toBe('Avermere')
    expect(world.settlements).toEqual([])
  })
})

describe('createSimState', () => {
  it('pairs a gameDay and GameState with a fresh dirty tracker', () => {
    const gameState = buildSyntheticGameState()
    const simState = createSimState(45, gameState)

    expect(simState.gameDay).toBe(45)
    expect(simState.gameState).toBe(gameState)
    expect(simState.dirty.dirtyKeys()).toEqual([])
  })
})

describe('createDirtyTracker', () => {
  it('reports only keys that were marked dirty', () => {
    const tracker = createDirtyTracker()
    tracker.markDirty('settlement:1')
    tracker.markDirty('industry:7')

    expect(tracker.isDirty('settlement:1')).toBe(true)
    expect(tracker.isDirty('link:1')).toBe(false)
    expect(tracker.dirtyKeys().sort()).toEqual(['industry:7', 'settlement:1'])
  })

  it('does not report the same key twice when marked more than once', () => {
    const tracker = createDirtyTracker()
    tracker.markDirty('settlement:1')
    tracker.markDirty('settlement:1')
    expect(tracker.dirtyKeys()).toEqual(['settlement:1'])
  })

  it('clear() empties the tracked set', () => {
    const tracker = createDirtyTracker()
    tracker.markDirty('settlement:1')
    tracker.clear()
    expect(tracker.dirtyKeys()).toEqual([])
    expect(tracker.isDirty('settlement:1')).toBe(false)
  })
})

describe('toRows / fromRows', () => {
  it('round-trips a synthetic GameState with an identical checksum', () => {
    const original = buildSyntheticGameState()
    const roundTripped = fromRows(toRows(original))
    expect(checksum(roundTripped)).toBe(checksum(original))
  })

  it('round-trips a GameState with no entities at all', () => {
    const empty = createGameState(
      [], [], [],
      { level: 2, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
      { name: 'Empty Co', cash: 0, loans: 0, rankKey: 'novice', stats: {} },
      [], [],
    )
    const roundTripped = fromRows(toRows(empty))
    expect(checksum(roundTripped)).toBe(checksum(empty))
  })

  it('round-trips a settlement with only some classes populated', () => {
    const partial = createGameState(
      [{
        id: 2, name: 'Oakford', kind: 'hamlet', x: 10, y: 10, portTier: 0, housing: 300, regionCells: 5,
        pop: { 2: { pop: 400, employed: 380, confidence: 50 } },
        stock: {},
      }],
      [], [],
      { level: 2, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
      { name: 'Co', cash: 0, loans: 0, rankKey: 'novice', stats: {} },
      [], [],
    )
    const roundTripped = fromRows(toRows(partial))
    expect(checksum(roundTripped)).toBe(checksum(partial))
    expect(roundTripped.settlements[0].pop[1]).toBeUndefined()
  })

  it('produces row objects with exact SQL column names', () => {
    const rows = toRows(buildSyntheticGameState())

    expect(rows.settlements[0]).toEqual(expect.objectContaining({
      id: 1, name: 'Ashton', kind: 'town', x: 120.5, y: 64, port_tier: 1, housing: 8000, region_cells: 42,
    }))
    expect(rows.settlementPop[0]).toEqual(expect.objectContaining({ settlement_id: 1, class: 0 }))
    expect(rows.industries[0]).toEqual(expect.objectContaining({ type_id: 'coal_mine', home_settlement_id: 1, richness_left: 0.9 }))
    expect(rows.links[0]).toEqual(expect.objectContaining({ a_type: 's', a_id: 1, b_type: 'i', b_id: 1, length_mi: 3.2 }))
    expect(rows.economyState).toEqual(expect.objectContaining({ last_change_dir: 0, last_check_day: 0 }))
    expect(rows.company).toEqual(expect.objectContaining({ rank_key: 'novice' }))
    expect(rows.historyMonthly[0]).toEqual(expect.objectContaining({ month_index: 0, pop_total: 7100, trade_value: 1250.5 }))
    expect(rows.eventsLog[0]).toEqual(expect.objectContaining({ game_day: 0, subject_type: 's', subject_id: 1 }))
  })

  it('carries a null closedDay/subjectId through untouched', () => {
    const state = buildSyntheticGameState()
    const rows = toRows(state)
    expect(rows.industries[0].closed_day).toBeNull()

    const roundTripped = fromRows(rows)
    expect(roundTripped.industries[0].closedDay).toBeNull()
  })
})
