import { getLinkCapacity } from './flows.js'

/**
 * Imports, exports and port tier growth (DESIGN 7.9). Imports land in
 * a port's own local stock — they reach any inland node (a mill town
 * wanting cotton, say) only through the ordinary domestic flow
 * algorithm already built in T1.18, which is why this module never
 * looks past the port itself: it is not a special-cased long-haul
 * delivery mechanism, just another source adding to one node's stock,
 * the same way T1.16's farm output does.
 *
 * @module sim/economy/trade
 */

/**
 * @param {string} cargoId
 * @param {number} year
 * @param {Array<{id: string, eraFrom: number}>} cargoCatalogue The validated `cargo.json` list.
 * @returns {boolean} Whether this cargo has reached its era yet.
 */
function isCargoEraAvailable(cargoId, year, cargoCatalogue) {
  const cargoDef = cargoCatalogue.find((c) => c.id === cargoId)
  return cargoDef !== undefined && year >= cargoDef.eraFrom
}

/**
 * @typedef {object} TradeResult
 * @property {number} quantity Tonnes moved.
 * @property {number} price Price per tonne used for this trade.
 * @property {number} value `quantity * price`.
 */

/**
 * Computes one port's import of one cargo for one month (DESIGN 7.9):
 * up to `importCap(portTier, cargo, year)` tonnes, at a fixed world
 * price — not gated by any local demand at the port itself. A port
 * with portTier 0 is not a port at all (`sim/state.js`'s own
 * convention) and never imports anything.
 *
 * @param {string} cargoId
 * @param {number} portTier 1-3 (0 means "not a port").
 * @param {number} year The calendar year.
 * @param {Array<{id: string, eraFrom: number, basePrice: number, importable: boolean}>} cargoCatalogue The validated `cargo.json` list.
 * @param {object} worldTradeRules `eras.json`'s `worldTrade` block.
 * @returns {TradeResult} Zero quantity/value if this cargo isn't importable, not yet in its era, or this isn't a port.
 */
export function computeImport(cargoId, portTier, year, cargoCatalogue, worldTradeRules) {
  const cargoDef = cargoCatalogue.find((c) => c.id === cargoId)
  const worldTradeDef = worldTradeRules[cargoId]

  if (portTier <= 0 || !cargoDef?.importable || !worldTradeDef?.importCapPerPortTierPerMonth || !isCargoEraAvailable(cargoId, year, cargoCatalogue)) {
    return { quantity: 0, price: 0, value: 0 }
  }

  const quantity = worldTradeDef.importCapPerPortTierPerMonth[portTier]
  const price = cargoDef.basePrice * worldTradeDef.worldPriceFactor
  return { quantity, price, value: quantity * price }
}

/**
 * Computes one port's export of one cargo for one month (DESIGN 7.9):
 * up to `exportCap(portTier, cargo, year)` tonnes, limited by whatever
 * stock is actually available at the port, at the world price with
 * the current economy level's revenue multiplier applied (DESIGN's
 * own explicit wording: "a price from eras.json with the economy
 * level applied" — unlike imports, which get no such multiplier; see
 * DECISIONS.md).
 *
 * @param {string} cargoId
 * @param {number} portTier 1-3 (0 means "not a port").
 * @param {number} year The calendar year.
 * @param {number} availableStock The port's current stock of this cargo.
 * @param {Array<{id: string, eraFrom: number, basePrice: number, exportable: boolean}>} cargoCatalogue The validated `cargo.json` list.
 * @param {object} worldTradeRules `eras.json`'s `worldTrade` block.
 * @param {number} economyRevenueMultiplier The current economy level's revenue multiplier.
 * @returns {TradeResult} Zero quantity/value if this cargo isn't exportable, not yet in its era, this isn't a port, or there's no stock.
 */
export function computeExport(cargoId, portTier, year, availableStock, cargoCatalogue, worldTradeRules, economyRevenueMultiplier) {
  const cargoDef = cargoCatalogue.find((c) => c.id === cargoId)
  const worldTradeDef = worldTradeRules[cargoId]

  if (portTier <= 0 || !cargoDef?.exportable || !worldTradeDef?.exportCapPerPortTierPerMonth || !isCargoEraAvailable(cargoId, year, cargoCatalogue)) {
    return { quantity: 0, price: 0, value: 0 }
  }

  const cap = worldTradeDef.exportCapPerPortTierPerMonth[portTier]
  const quantity = Math.max(0, Math.min(cap, availableStock))
  const price = cargoDef.basePrice * worldTradeDef.worldPriceFactor * economyRevenueMultiplier
  return { quantity, price, value: quantity * price }
}

/**
 * Computes one month's trade balance (DESIGN 7.9: "value exported
 * minus value imported... feeds the economy score").
 *
 * @param {TradeResult[]} imports Every import this month, any number of ports/cargoes.
 * @param {TradeResult[]} exports Every export this month, any number of ports/cargoes.
 * @returns {number} Export value minus import value (positive is a trade surplus).
 */
export function computeTradeBalance(imports, exports) {
  const totalImportValue = imports.reduce((sum, i) => sum + i.value, 0)
  const totalExportValue = exports.reduce((sum, e) => sum + e.value, 0)
  return totalExportValue - totalImportValue
}

/**
 * @typedef {object} PortTierGrowthResult
 * @property {number} monthsAboveThreshold The updated streak counter, to pass into next month's call.
 * @property {number} nextTier The port's tier after this month (unchanged, or +1 once the streak completes).
 */

/**
 * Evaluates one month's port tier growth (DESIGN 7.9: "port tier rises
 * when throughput stays high"). Throughput is measured against the
 * port's own generic freight capacity for its mode and tier (the same
 * `getLinkCapacity()` lookup `flows.js` already uses for its world
 * link, Appendix C's table) rather than any one cargo's own cap, since
 * a port typically handles many different cargoes at once and DESIGN
 * gives no per-cargo throughput rule for tier growth specifically.
 *
 * @param {number} monthsAboveThreshold The streak coming into this month (0 if this is the first month, or the streak reset last time it dipped).
 * @param {number} currentTier The port's tier before this month (1-3).
 * @param {number} totalThroughputTonnes This month's combined import+export tonnage at this port.
 * @param {{mode: string, tier: number}} worldLink The port's own world link (for its capacity lookup).
 * @param {object} linksRules The validated `links.json` rules.
 * @param {object} portRules `economy.json`'s `ports` block.
 * @returns {PortTierGrowthResult}
 */
export function evaluatePortTierGrowth(monthsAboveThreshold, currentTier, totalThroughputTonnes, worldLink, linksRules, portRules) {
  const capacity = getLinkCapacity(worldLink, linksRules)
  const throughputRatio = capacity > 0 ? totalThroughputTonnes / capacity : 0
  const sustained = throughputRatio >= portRules.tierGrowthThroughputThreshold

  if (!sustained) {
    return { monthsAboveThreshold: 0, nextTier: currentTier }
  }

  const nextStreak = monthsAboveThreshold + 1
  if (nextStreak >= portRules.tierGrowthSustainedMonths && currentTier < 3) {
    return { monthsAboveThreshold: 0, nextTier: currentTier + 1 }
  }

  return { monthsAboveThreshold: nextStreak, nextTier: currentTier }
}
