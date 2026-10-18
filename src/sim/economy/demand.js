/**
 * Monthly demand (DESIGN 7.3): population demand (by class, with
 * confidence-spending and seasonal coal factors), industry input
 * demand (at planned full output, independent of realized
 * utilisation), and the `basic`/`complex` demand mode split. Every
 * function is pure: callers supply the current economy level's demand
 * multiplier, calendar position and class populations.
 *
 * @module sim/economy/demand
 */

/** @type {readonly string[]} Settlement kinds DESIGN 7.3 calls "town size or larger". */
const TOWN_OR_LARGER = Object.freeze(['capital', 'city', 'town'])

/**
 * @param {number} value
 * @returns {number} `value` clamped to [0, 100].
 */
function clampConfidence(value) {
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

/**
 * The class confidence spending factor (DESIGN 7.3): 0.7 at confidence
 * 0, 1.0 at 50, 1.2 at 100, linearly interpolated between those three
 * points.
 *
 * @param {number} confidence A class's confidence, 0-100.
 * @param {{atConfidence0: number, atConfidence50: number, atConfidence100: number}} factors `economy.json`'s `confidenceSpendingFactor`.
 * @returns {number} The spending multiplier.
 */
export function confidenceSpendingFactor(confidence, factors) {
  const c = clampConfidence(confidence)
  if (c <= 50) {
    return factors.atConfidence0 + (factors.atConfidence50 - factors.atConfidence0) * (c / 50)
  }
  return factors.atConfidence50 + (factors.atConfidence100 - factors.atConfidence50) * ((c - 50) / 50)
}

/**
 * @param {string} cargo A cargo id.
 * @param {Record<string, {eraFrom?: number}>} demandTable `economy.json`'s `demandPerThousandPerMonth`.
 * @param {number} year The calendar year.
 * @returns {boolean} Whether this cargo is demanded at all yet (DESIGN 7.3: cars "from 1900").
 */
function isCargoAvailable(cargo, demandTable, year) {
  const eraFrom = demandTable[cargo].eraFrom
  return eraFrom === undefined || year >= eraFrom
}

/**
 * @param {string} cargo A cargo id.
 * @param {number} monthIndex The 0-based month index.
 * @param {object} seasonal `economy.json`'s `seasonal` block.
 * @returns {number} The seasonal demand factor for this cargo this month (only coal varies).
 */
function seasonalDemandFactor(cargo, monthIndex, seasonal) {
  return cargo === 'coal' ? seasonal.coalDemandFactorByMonth[monthIndex] : 1
}

/**
 * @typedef {object} SettlementPopRow
 * @property {string} classId A `classes.json` id ('working', 'middle', 'upper').
 * @property {number} pop Population in this class.
 * @property {number} confidence This class's confidence, 0-100.
 */

/**
 * Computes one settlement's population demand for one month (DESIGN
 * 7.3). In `complex` mode, demand is the real per-class sum: a class
 * with zero population contributes zero demand for cargoes it alone
 * would buy. In `basic` mode, a settlement of town size or larger
 * instead demands every consumer cargo using its *total* population
 * against the sum of all three classes' rates — deliberately
 * independent of which classes that population happens to split
 * across (DESIGN 7.3: "regardless of population mix"); villages and
 * hamlets always use the real per-class calculation, in either mode.
 *
 * @param {SettlementPopRow[]} classRows This settlement's `settlement_pop` rows.
 * @param {string} settlementKind The settlement's kind id.
 * @param {'basic'|'complex'} demandMode `difficulty.json`'s `demandMode`.
 * @param {object} economyRules The validated `economy.json` rules.
 * @param {number} economyDemandMultiplier The current economy level's demand multiplier.
 * @param {number} monthIndex The 0-based month index (for the seasonal coal factor).
 * @param {number} year The calendar year (for cargo era gating).
 * @returns {Record<string, number>} Tonnes demanded this month, keyed by cargo id.
 */
export function computePopulationDemand(classRows, settlementKind, demandMode, economyRules, economyDemandMultiplier, monthIndex, year) {
  const { demandPerThousandPerMonth, confidenceSpendingFactor: spendingFactors, seasonal } = economyRules
  const cargoes = Object.keys(demandPerThousandPerMonth)
  const demand = {}

  const useBlended = demandMode === 'basic' && TOWN_OR_LARGER.includes(settlementKind)

  if (useBlended) {
    const totalPop = classRows.reduce((sum, row) => sum + row.pop, 0)
    const weightedConfidence = totalPop > 0
      ? classRows.reduce((sum, row) => sum + row.confidence * row.pop, 0) / totalPop
      : 50
    const spendFactor = confidenceSpendingFactor(weightedConfidence, spendingFactors)

    for (const cargo of cargoes) {
      if (!isCargoAvailable(cargo, demandPerThousandPerMonth, year)) {
        demand[cargo] = 0
        continue
      }
      const rateTable = demandPerThousandPerMonth[cargo]
      const combinedRate = (rateTable.working || 0) + (rateTable.middle || 0) + (rateTable.upper || 0)
      const seasonalFactor = seasonalDemandFactor(cargo, monthIndex, seasonal)
      demand[cargo] = (totalPop / 1000) * combinedRate * spendFactor * seasonalFactor * economyDemandMultiplier
    }
    return demand
  }

  for (const cargo of cargoes) demand[cargo] = 0

  for (const row of classRows) {
    const spendFactor = confidenceSpendingFactor(row.confidence, spendingFactors)
    for (const cargo of cargoes) {
      if (!isCargoAvailable(cargo, demandPerThousandPerMonth, year)) continue
      const rate = demandPerThousandPerMonth[cargo][row.classId] || 0
      const seasonalFactor = seasonalDemandFactor(cargo, monthIndex, seasonal)
      demand[cargo] += (row.pop / 1000) * rate * spendFactor * seasonalFactor * economyDemandMultiplier
    }
  }

  return demand
}

/**
 * Computes an industry's input demand for one month at its *planned*
 * utilisation (DESIGN 7.3: "the monthly input need at the planned
 * utilisation"), which this project takes to mean full output (u = 1)
 * — the industry always wants enough input to run flat out; whether it
 * actually gets to is `computeIndustryUtilisation()`'s job, computed
 * separately from the realized stock this demand number feeds into
 * (DESIGN 7.1 lists production, step 3, before consumption/demand,
 * step 4). An `{any: {...}}` substitution slot demands every listed
 * option at its own full quantity, since either one could satisfy the
 * industry and the market should see demand pressure for both.
 *
 * @param {object} industryDef The industry's `industries.json` definition.
 * @returns {Record<string, number>} Tonnes demanded this month, keyed by cargo id.
 */
export function computeIndustryDemand(industryDef) {
  const demand = {}

  for (const slot of industryDef.inputs) {
    if (slot.any) {
      for (const [cargo, qty] of Object.entries(slot.any)) {
        demand[cargo] = (demand[cargo] || 0) + qty
      }
    } else {
      demand[slot.cargo] = (demand[slot.cargo] || 0) + slot.qty
    }
  }

  return demand
}

/**
 * Adds one node's per-cargo demand contributions together (DESIGN
 * 7.3's `monthlyDemand[node][cargo]`: the sum of population, industry
 * and — from T1.19 — construction demand).
 *
 * @param {...Record<string, number>} demands Any number of per-cargo demand objects.
 * @returns {Record<string, number>} The summed demand, keyed by cargo id.
 */
export function mergeDemand(...demands) {
  const merged = {}
  for (const demand of demands) {
    for (const [cargo, qty] of Object.entries(demand)) {
      merged[cargo] = (merged[cargo] || 0) + qty
    }
  }
  return merged
}
