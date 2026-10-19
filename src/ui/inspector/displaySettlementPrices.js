import { computePopulationDemand, computeRelayDemand, computeIndustryDemand, mergeDemand } from '../../sim/economy/demand.js'
import { computeCoverage, computePriceMultiplier, computePrice } from '../../sim/economy/prices.js'
import { scaleIndustryDef } from '../../sim/economy/industryLifecycle.js'

/**
 * Recomputes a settlement's current stock/price table for the
 * Inspector's selected-settlement panel (PHASES.md T1.26). Display
 * only: `tick.js` never persists the demand or price numbers it
 * computes each month (DESIGN 7.1 treats them as ephemeral,
 * recomputed fresh every tick), so showing them here means
 * recomputing the same formulas from the entity's current `stock` —
 * close to, but not byte-identical with, what `runMonth()` last used
 * (this uses the economy level's `revenue` multiplier only, not the
 * `demand` multiplier `tick.js` applies to population demand, a
 * reasonable approximation for a read-only developer view).
 *
 * @module ui/inspector/displaySettlementPrices
 */

/**
 * @typedef {object} DisplayPriceRow
 * @property {string} cargoId
 * @property {number} stock
 * @property {number} demand
 * @property {number} multiplier The price multiplier, in `[pMin, pMax]`.
 * @property {number} price
 */

/**
 * @param {import('../../sim/state.js').Settlement} settlement
 * @param {import('../../sim/state.js').GameState} gameState
 * @param {object} rules The full validated rules bundle.
 * @param {Map<number, string>} classIdByIndex `classes.json` id, keyed by array index.
 * @param {number} monthIndex The 0-based month index (for seasonal demand factors).
 * @param {number} year The calendar year.
 * @returns {DisplayPriceRow[]} Sorted by cargo id.
 */
export function computeSettlementDisplayPrices(settlement, gameState, rules, classIdByIndex, monthIndex, year) {
  const classRows = [...classIdByIndex].map(([index, classId]) => ({
    classId,
    pop: settlement.pop[index]?.pop || 0,
    confidence: settlement.pop[index]?.confidence ?? 50,
  }))
  const populationDemand = computePopulationDemand(classRows, settlement.kind, rules.difficulty.demandMode, rules.economy, 1, monthIndex, year)

  const industryDefById = new Map(rules.industries.map((d) => [d.id, d]))
  const localIndustryDemands = gameState.industries
    .filter((ind) => ind.homeSettlementId === settlement.id && ind.closedDay === null)
    .map((ind) => computeIndustryDemand(scaleIndustryDef(industryDefById.get(ind.typeId), ind.capacity)))

  const totalPop = classRows.reduce((sum, row) => sum + row.pop, 0)
  const cargoIds = rules.cargo.map((c) => c.id)
  const relayDemand = computeRelayDemand(totalPop, cargoIds, rules.economy.flow.relayDemandPerThousandPerMonth)

  const demand = mergeDemand(populationDemand, relayDemand, ...localIndustryDemands)
  const cargoById = new Map(rules.cargo.map((c) => [c.id, c]))
  const revenueMultiplier = rules.economy.levels[gameState.economyState.level].revenue

  const rows = []
  for (const cargoId of new Set([...Object.keys(settlement.stock), ...Object.keys(demand)])) {
    const cargoDef = cargoById.get(cargoId)
    if (!cargoDef) continue
    const stock = settlement.stock[cargoId] || 0
    const cargoDemand = demand[cargoId] || 0
    const coverage = computeCoverage(stock, cargoDemand)
    const multiplier = computePriceMultiplier(coverage, cargoDef.elasticity, rules.economy.price)
    const price = computePrice(cargoDef.basePrice, multiplier, revenueMultiplier)
    rows.push({ cargoId, stock, demand: cargoDemand, multiplier, price })
  }

  return rows.sort((a, b) => a.cargoId.localeCompare(b.cargoId))
}
