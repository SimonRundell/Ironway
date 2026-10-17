/**
 * In-memory world and simulation state shapes (DESIGN.md 4.4, 8.2):
 * constructors, a dirty-tracking wrapper, and `toRows()`/`fromRows()`
 * mappers that translate between the camelCase shapes used in JS and
 * the exact column names of `api/sql/001_schema.sql`.
 *
 * `World` is everything a generated island produces: the grid (packed
 * separately as a gzipped blob, not row-mapped), harbours and names
 * (derived from the grid, not stored in their own SQL tables), and the
 * settlement/industry/link entities with both their structural fields
 * (name, kind, x, y) and their current dynamic fields (population,
 * stock, condition) in one place, exactly as a client needs to read
 * and render them.
 *
 * `GameState` is the narrower, row-backed subset of that world that
 * `saves/create.php` and `saves/checkpoint.php` actually read and
 * write: settlements, settlement populations, industries, links,
 * economy state, company and history/event logs. `toRows()` and
 * `fromRows()` only cover `GameState`, matching DESIGN 4.4's "entity
 * rows and company row" wording; `gameDay` and `version` live on the
 * `saves` row itself (handled by saves.php, not this module), and the
 * map blob has its own pack/unpack path (fflate), so neither appears
 * here.
 *
 * `SimState` wraps a `GameState` with the current `gameDay` and a
 * dirty tracker: simulation code mutates entities in place through
 * `SimState`, which also marks the entity's key as changed, so a
 * checkpoint can send only what actually changed.
 *
 * @module sim/state
 */

/**
 * @typedef {object} Settlement
 * @property {number} id
 * @property {string} name
 * @property {string} kind One of settlements.json's kind ids (capital, city, town, village, hamlet).
 * @property {number} x World x, in miles.
 * @property {number} y World y, in miles.
 * @property {number} portTier 0 if not a port.
 * @property {number} housing Housing capacity (population it can hold).
 * @property {number} regionCells Count of grid cells in this settlement's hinterland.
 * @property {Record<number, {pop: number, employed: number, confidence: number}>} pop Per-class population, keyed by classId (classes.json array index).
 * @property {Record<string, number>} stock Cargo id to tonnes held.
 */

/**
 * @typedef {object} Industry
 * @property {number} id
 * @property {string} typeId An industries.json id.
 * @property {string} name
 * @property {number} x World x, in miles.
 * @property {number} y World y, in miles.
 * @property {number} homeSettlementId
 * @property {number} capacity Full-output capacity.
 * @property {number} utilisation Current utilisation, 0 to 1.
 * @property {number} richnessLeft Remaining resource richness, 0 to 1 (1 for non-depleting industries).
 * @property {number} openedDay `gameDay` the industry opened.
 * @property {number|null} closedDay `gameDay` the industry closed, or null if still open.
 * @property {number} monthsLow Consecutive months below a viability threshold.
 * @property {Record<string, number>} stock Cargo id to tonnes held.
 */

/**
 * @typedef {object} Link
 * @property {number} id
 * @property {string} aType Single-character entity type at end A (e.g. 's' settlement, 'i' industry, 'w' world/port).
 * @property {number} aId
 * @property {string} bType Single-character entity type at end B.
 * @property {number} bId
 * @property {string} mode `road`, `rail` or `sea`.
 * @property {number} tier Link tier within its mode, per links.json.
 * @property {number} lengthMi Length in miles.
 * @property {number} gradient Steepest gradient ratio along the path.
 * @property {number} condition 0 to 1.
 * @property {string} owner `public` or a company key.
 * @property {number[][]} path Simplified [x, y] waypoints, in miles.
 */

/**
 * @typedef {object} EconomyState
 * @property {number} level Current island economy level.
 * @property {number} lastChangeDir -1, 0 or 1.
 * @property {number} lastCheckDay `gameDay` of the last March/September check.
 * @property {Record<string, number>} indicators Named indicator values.
 */

/**
 * @typedef {object} Company
 * @property {string} name
 * @property {number} cash
 * @property {number} loans
 * @property {string} rankKey A ranks.json id.
 * @property {Record<string, number>} stats
 */

/**
 * @typedef {object} HistoryMonthlyEntry
 * @property {number} monthIndex
 * @property {number} popTotal
 * @property {number} popU
 * @property {number} popM
 * @property {number} popW
 * @property {number} employment
 * @property {number} confidence
 * @property {number} tradeValue
 * @property {number} level
 * @property {Record<string, number>} extra
 */

/**
 * @typedef {object} EventLogEntry
 * @property {number|null} id Null until the server assigns one on insert.
 * @property {number} gameDay
 * @property {string} kind
 * @property {string|null} subjectType
 * @property {number|null} subjectId
 * @property {string} text
 */

/**
 * @typedef {object} GameState The row-backed subset of a World: everything `toRows()`/`fromRows()` cover.
 * @property {Settlement[]} settlements
 * @property {Industry[]} industries
 * @property {Link[]} links
 * @property {EconomyState} economyState
 * @property {Company} company
 * @property {HistoryMonthlyEntry[]} historyMonthly
 * @property {EventLogEntry[]} eventsLog
 */

/**
 * @typedef {object} HarbourCandidate A derived, non-row-mapped harbour site; see sim/mapgen/coast.js.
 * @property {number} x
 * @property {number} y
 * @property {boolean} isEstuary
 * @property {number} score
 */

/**
 * @typedef {object} WorldNames Derived, non-row-mapped names for non-entity features; see sim/names.js.
 * @property {string} island
 * @property {string[]} rivers
 * @property {string[]} bays
 * @property {string[]} ranges
 */

/**
 * @typedef {object} WorldMeta
 * @property {string} seed
 * @property {number} generatorVersion
 * @property {number} startYear
 * @property {string} difficulty
 * @property {string} name The save's display name.
 */

/**
 * @typedef {object} World The full in-memory island: everything a client holds once loaded.
 * @property {WorldMeta} meta
 * @property {object|null} grid The generated WorldGrid (see sim/mapgen/grid.js), or null before load/generation.
 * @property {HarbourCandidate[]} harbours
 * @property {WorldNames} names
 * @property {Settlement[]} settlements
 * @property {Industry[]} industries
 * @property {Link[]} links
 */

/**
 * Builds a `World`. Every field must be supplied; callers pass `[]`,
 * `null` or an empty object explicitly rather than relying on a
 * default, so it is always clear in the caller's code what stage of
 * loading or generation produced this value.
 *
 * @param {WorldMeta} meta
 * @param {object|null} grid
 * @param {HarbourCandidate[]} harbours
 * @param {WorldNames} names
 * @param {Settlement[]} settlements
 * @param {Industry[]} industries
 * @param {Link[]} links
 * @returns {World}
 */
export function createWorld(meta, grid, harbours, names, settlements, industries, links) {
  return { meta, grid, harbours, names, settlements, industries, links }
}

/**
 * Builds a `GameState`.
 *
 * @param {Settlement[]} settlements
 * @param {Industry[]} industries
 * @param {Link[]} links
 * @param {EconomyState} economyState
 * @param {Company} company
 * @param {HistoryMonthlyEntry[]} historyMonthly
 * @param {EventLogEntry[]} eventsLog
 * @returns {GameState}
 */
export function createGameState(settlements, industries, links, economyState, company, historyMonthly, eventsLog) {
  return { settlements, industries, links, economyState, company, historyMonthly, eventsLog }
}

/**
 * Creates a dirty tracker: a small wrapper around a `Set` of entity
 * keys, used so a checkpoint can send only what actually changed since
 * the last one. Keys are caller-chosen strings, by convention
 * `"${type}:${id}"` (e.g. `"settlement:3"`) or `"${type}:${id}:${subId}"`
 * for a composite-keyed row (e.g. `"settlementPop:3:1"`).
 *
 * @returns {{markDirty: (key: string) => void, isDirty: (key: string) => boolean, dirtyKeys: () => string[], clear: () => void}}
 */
export function createDirtyTracker() {
  const dirty = new Set()

  return {
    markDirty(key) {
      dirty.add(key)
    },
    isDirty(key) {
      return dirty.has(key)
    },
    dirtyKeys() {
      return [...dirty]
    },
    clear() {
      dirty.clear()
    },
  }
}

/**
 * Creates a `SimState`: a `GameState` plus the current `gameDay` and a
 * dirty tracker. Simulation code should mutate entities in place and
 * call `markDirty()` for every touched key, rather than copying data
 * out of `gameState` and back in.
 *
 * @param {number} gameDay
 * @param {GameState} gameState
 * @returns {{gameDay: number, gameState: GameState, dirty: ReturnType<typeof createDirtyTracker>}}
 */
export function createSimState(gameDay, gameState) {
  return { gameDay, gameState, dirty: createDirtyTracker() }
}

/**
 * Converts a `GameState` into row arrays/objects matching
 * `api/sql/001_schema.sql`'s column names exactly, ready to send to
 * `saves/create.php` or `saves/checkpoint.php`. JSON columns (`stock`,
 * `indicators`, `stats`, `extra`, `path`) are kept as plain JS values;
 * the PHP layer encodes them to JSON text at the database boundary.
 *
 * @param {GameState} gameState
 * @returns {object} Rows keyed by table name (settlements, settlementPop, industries, links, economyState, company, historyMonthly, eventsLog).
 */
export function toRows(gameState) {
  const settlements = gameState.settlements.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    x: s.x,
    y: s.y,
    port_tier: s.portTier,
    housing: s.housing,
    region_cells: s.regionCells,
    stock: s.stock,
  }))

  const settlementPop = []
  for (const s of gameState.settlements) {
    for (const [classId, p] of Object.entries(s.pop)) {
      settlementPop.push({
        settlement_id: s.id,
        class: Number(classId),
        pop: p.pop,
        employed: p.employed,
        confidence: p.confidence,
      })
    }
  }

  const industries = gameState.industries.map((ind) => ({
    id: ind.id,
    type_id: ind.typeId,
    name: ind.name,
    x: ind.x,
    y: ind.y,
    home_settlement_id: ind.homeSettlementId,
    capacity: ind.capacity,
    utilisation: ind.utilisation,
    richness_left: ind.richnessLeft,
    opened_day: ind.openedDay,
    closed_day: ind.closedDay,
    months_low: ind.monthsLow,
    stock: ind.stock,
  }))

  const links = gameState.links.map((link) => ({
    id: link.id,
    a_type: link.aType,
    a_id: link.aId,
    b_type: link.bType,
    b_id: link.bId,
    mode: link.mode,
    tier: link.tier,
    length_mi: link.lengthMi,
    gradient: link.gradient,
    condition: link.condition,
    owner: link.owner,
    path: link.path,
  }))

  const economyState = {
    level: gameState.economyState.level,
    last_change_dir: gameState.economyState.lastChangeDir,
    last_check_day: gameState.economyState.lastCheckDay,
    indicators: gameState.economyState.indicators,
  }

  const company = {
    name: gameState.company.name,
    cash: gameState.company.cash,
    loans: gameState.company.loans,
    rank_key: gameState.company.rankKey,
    stats: gameState.company.stats,
  }

  const historyMonthly = gameState.historyMonthly.map((h) => ({
    month_index: h.monthIndex,
    pop_total: h.popTotal,
    pop_u: h.popU,
    pop_m: h.popM,
    pop_w: h.popW,
    employment: h.employment,
    confidence: h.confidence,
    trade_value: h.tradeValue,
    level: h.level,
    extra: h.extra,
  }))

  const eventsLog = gameState.eventsLog.map((e) => ({
    id: e.id,
    game_day: e.gameDay,
    kind: e.kind,
    subject_type: e.subjectType,
    subject_id: e.subjectId,
    text: e.text,
  }))

  return { settlements, settlementPop, industries, links, economyState, company, historyMonthly, eventsLog }
}

/**
 * Inverts `toRows()`: rebuilds a `GameState` from row arrays/objects
 * with SQL column names. Settlement populations are regrouped from
 * the flat `settlementPop` rows back onto each settlement's `pop` map.
 *
 * @param {object} rows As returned by `toRows()` (or decoded from the API).
 * @returns {GameState}
 */
export function fromRows(rows) {
  const popBySettlement = new Map()
  for (const row of rows.settlementPop) {
    if (!popBySettlement.has(row.settlement_id)) {
      popBySettlement.set(row.settlement_id, {})
    }
    popBySettlement.get(row.settlement_id)[row.class] = {
      pop: row.pop,
      employed: row.employed,
      confidence: row.confidence,
    }
  }

  const settlements = rows.settlements.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    x: row.x,
    y: row.y,
    portTier: row.port_tier,
    housing: row.housing,
    regionCells: row.region_cells,
    pop: popBySettlement.get(row.id) ?? {},
    stock: row.stock,
  }))

  const industries = rows.industries.map((row) => ({
    id: row.id,
    typeId: row.type_id,
    name: row.name,
    x: row.x,
    y: row.y,
    homeSettlementId: row.home_settlement_id,
    capacity: row.capacity,
    utilisation: row.utilisation,
    richnessLeft: row.richness_left,
    openedDay: row.opened_day,
    closedDay: row.closed_day,
    monthsLow: row.months_low,
    stock: row.stock,
  }))

  const links = rows.links.map((row) => ({
    id: row.id,
    aType: row.a_type,
    aId: row.a_id,
    bType: row.b_type,
    bId: row.b_id,
    mode: row.mode,
    tier: row.tier,
    lengthMi: row.length_mi,
    gradient: row.gradient,
    condition: row.condition,
    owner: row.owner,
    path: row.path,
  }))

  const economyState = {
    level: rows.economyState.level,
    lastChangeDir: rows.economyState.last_change_dir,
    lastCheckDay: rows.economyState.last_check_day,
    indicators: rows.economyState.indicators,
  }

  const company = {
    name: rows.company.name,
    cash: rows.company.cash,
    loans: rows.company.loans,
    rankKey: rows.company.rank_key,
    stats: rows.company.stats,
  }

  const historyMonthly = rows.historyMonthly.map((row) => ({
    monthIndex: row.month_index,
    popTotal: row.pop_total,
    popU: row.pop_u,
    popM: row.pop_m,
    popW: row.pop_w,
    employment: row.employment,
    confidence: row.confidence,
    tradeValue: row.trade_value,
    level: row.level,
    extra: row.extra,
  }))

  const eventsLog = rows.eventsLog.map((row) => ({
    id: row.id,
    gameDay: row.game_day,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    text: row.text,
  }))

  return { settlements, industries, links, economyState, company, historyMonthly, eventsLog }
}
