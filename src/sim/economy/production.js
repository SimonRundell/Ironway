import { agriProductivityMultiplier } from '../era.js'

/**
 * Monthly production (DESIGN 7.2): hinterland farm output and industry
 * utilisation/output. Every function here is pure — callers supply the
 * current economy-level multiplier, calendar position and stock; none
 * of these functions read a clock or mutate anything in place.
 *
 * @module sim/economy/production
 */

/**
 * @param {number} value
 * @returns {number} `value` clamped to [0, 1].
 */
function clamp01(value) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * @typedef {object} HinterlandSums
 * @property {number} arableSuit Sum of `arable` suitability (0-1 per cell) over this settlement's arable-classified hinterland cells.
 * @property {number} mixedArableSuit The same sum, but over mixed-classified cells (DESIGN 7.2: "mixed cells give about 60 percent of each at half the yields").
 * @property {number} pastoralSuit Sum of `pastoral` suitability (0-1 per cell) over pastoral-classified hinterland cells.
 * @property {number} mixedPastoralSuit The same sum, but over mixed-classified cells.
 * @property {number} forestCount Count of forest-classified hinterland cells (forestry has no per-cell suitability score, unlike farmland).
 */

/**
 * Precomputes each settlement's hinterland land composition from the
 * world grid, once per loaded world: a single pass over every cell,
 * grouped by `grid.region` (the nearest-settlement id DESIGN 5.4
 * assigns). This never changes during Phase 1 (no terraforming), so
 * callers should compute it once after load/creation and reuse it for
 * every subsequent month's `computeFarmOutput()` rather than rescanning
 * the grid monthly.
 *
 * @param {object} grid The world grid (DESIGN 5.1): needs `region`, `landuse`, `arable`, `pastoral`.
 * @param {number[]} settlementIds Every settlement id in the world.
 * @param {{landuseEnum: string[]}} terrainRules The validated `terrain.json` rules.
 * @returns {Map<number, HinterlandSums>} Keyed by settlement id.
 */
export function computeHinterlandSums(grid, settlementIds, terrainRules) {
  const sums = new Map()
  for (const id of settlementIds) {
    sums.set(id, { arableSuit: 0, mixedArableSuit: 0, pastoralSuit: 0, mixedPastoralSuit: 0, forestCount: 0 })
  }

  const arableIndex = terrainRules.landuseEnum.indexOf('arable')
  const mixedIndex = terrainRules.landuseEnum.indexOf('mixed')
  const pastoralIndex = terrainRules.landuseEnum.indexOf('pastoral')
  const forestIndex = terrainRules.landuseEnum.indexOf('forest')

  const { region, landuse, arable, pastoral } = grid
  const size = grid.width * grid.height

  for (let i = 0; i < size; i++) {
    const entry = sums.get(region[i])
    if (!entry) continue // sea cells and any cell outside every hinterland keep region 0, matching no real settlement id.

    const lu = landuse[i]
    if (lu === arableIndex) {
      entry.arableSuit += arable[i] / 255
    } else if (lu === pastoralIndex) {
      entry.pastoralSuit += pastoral[i] / 255
    } else if (lu === mixedIndex) {
      entry.mixedArableSuit += arable[i] / 255
      entry.mixedPastoralSuit += pastoral[i] / 255
    } else if (lu === forestIndex) {
      entry.forestCount += 1
    }
  }

  return sums
}

/**
 * @typedef {object} FarmOutput
 * @property {number} grain
 * @property {number} livestock
 * @property {number} wool
 * @property {number} milk
 * @property {number} timber
 */

/**
 * Computes one settlement's hinterland farm output for one month
 * (DESIGN 7.2 "Farms (hinterland)"). Livestock and milk share
 * pastoral's base output with no seasonal factor; wool shares the same
 * base but gets its own spring seasonal bonus.
 *
 * @param {HinterlandSums} hinterlandSums This settlement's precomputed land composition (`computeHinterlandSums()`).
 * @param {object} economyRules The validated `economy.json` rules.
 * @param {object} erasRules The validated `eras.json` rules.
 * @param {number} year The calendar year (for era productivity).
 * @param {number} monthIndex The 0-based month index (DESIGN 4.1; `sim/clock.js`'s `monthIndexOf()`), for seasonal factors.
 * @param {number} economyProductionMultiplier The current economy level's production multiplier (`economy.json`'s `levels[level].production`).
 * @returns {FarmOutput} Tonnes produced this month, to add to the settlement's stock.
 */
export function computeFarmOutput(hinterlandSums, economyRules, erasRules, year, monthIndex, economyProductionMultiplier) {
  const { yields, seasonal } = economyRules
  const { arableSuit, mixedArableSuit, pastoralSuit, mixedPastoralSuit, forestCount } = hinterlandSums

  const mixedFactor = yields.mixedCellYieldFactor * yields.mixedCellBothFactor
  const scale = agriProductivityMultiplier(erasRules, year) * economyProductionMultiplier

  const grainBase = (arableSuit + mixedArableSuit * mixedFactor) * yields.grainPerArableCellPerMonth
  const pastoralBase = (pastoralSuit + mixedPastoralSuit * mixedFactor) * yields.pastoralOutputPerCellPerMonth
  const timberBase = forestCount * yields.timberPerForestCellPerMonth

  const grainSeasonal = seasonal.grainHarvestPeakMonths.includes(monthIndex) ? seasonal.seasonalPeakFactor : seasonal.seasonalOffPeakFactor
  const woolSeasonal = seasonal.woolSpringPeakMonths.includes(monthIndex) ? seasonal.seasonalPeakFactor : seasonal.seasonalOffPeakFactor

  return {
    grain: grainBase * grainSeasonal * scale,
    livestock: pastoralBase * scale,
    wool: pastoralBase * woolSeasonal * scale,
    milk: pastoralBase * scale,
    timber: timberBase * scale,
  }
}

/**
 * @typedef {object} ResolvedInput
 * @property {string} cargo Which cargo this input slot will actually draw from.
 * @property {number} qtyAtFullOutput How much of it a full month's output needs.
 */

/**
 * @typedef {object} UtilisationResult
 * @property {number} u Realized utilisation this month (DESIGN 7.2: capped at 1.3, the headroom above the economy level's own maximum 1.2x production multiplier).
 * @property {number} labour The labour term (workers available / workers needed), capped at 1.
 * @property {number} inputsRatio The inputs term (worst-supplied input slot's coverage), capped at 1.
 * @property {number} outputRoom The output-storage term (worst-constrained output cargo's free room), capped at 1.
 * @property {ResolvedInput[]} resolvedInputs Which actual cargo each input slot (including `any` substitution groups) will draw from, for `applyIndustryProduction()`.
 */

/**
 * Computes an industry's utilisation for one month (DESIGN 7.2). An
 * `{any: {cargoA: qty, cargoB: qty}}` input slot resolves to whichever
 * listed option currently has the best stock coverage — the facility
 * runs on whichever substitute it actually has, not a fixed preference
 * order.
 *
 * @param {object} industryDef The industry's `industries.json` definition (`inputs`, `outputs`, `jobs`, `storageMonths`).
 * @param {Record<string, number>} stock The industry's current local stock, keyed by cargo id.
 * @param {number} workersAvailable Workers available to this industry this month (DESIGN 7.7's unemployed pool; supplied by the caller — there is no employment model yet before T1.20).
 * @param {number} economyProductionMultiplier The current economy level's production multiplier.
 * @returns {UtilisationResult}
 */
export function computeIndustryUtilisation(industryDef, stock, workersAvailable, economyProductionMultiplier) {
  const workersNeeded = (industryDef.jobs.working || 0) + (industryDef.jobs.middle || 0) + (industryDef.jobs.upper || 0)
  const labour = workersNeeded > 0 ? Math.min(1, workersAvailable / workersNeeded) : 1

  const resolvedInputs = []
  let inputsRatioRaw = Infinity

  for (const slot of industryDef.inputs) {
    if (slot.any) {
      let bestRatio = -Infinity
      let bestCargo = null
      let bestQty = 0
      for (const [cargo, qty] of Object.entries(slot.any)) {
        const ratio = qty > 0 ? (stock[cargo] || 0) / qty : Infinity
        if (ratio > bestRatio) {
          bestRatio = ratio
          bestCargo = cargo
          bestQty = qty
        }
      }
      resolvedInputs.push({ cargo: bestCargo, qtyAtFullOutput: bestQty })
      inputsRatioRaw = Math.min(inputsRatioRaw, bestRatio)
    } else {
      const ratio = slot.qty > 0 ? (stock[slot.cargo] || 0) / slot.qty : Infinity
      resolvedInputs.push({ cargo: slot.cargo, qtyAtFullOutput: slot.qty })
      inputsRatioRaw = Math.min(inputsRatioRaw, ratio)
    }
  }
  const inputsRatio = clamp01(inputsRatioRaw) // Infinity (no inputs needed) clamps to 1.

  let outputRoomRaw = Infinity
  for (const [cargo, qtyAtFull] of Object.entries(industryDef.outputs)) {
    if (qtyAtFull <= 0) continue
    const cap = industryDef.storageMonths * qtyAtFull
    const current = stock[cargo] || 0
    outputRoomRaw = Math.min(outputRoomRaw, (cap - current) / qtyAtFull)
  }
  const outputRoom = clamp01(outputRoomRaw)

  const rawU = labour * inputsRatio * outputRoom * economyProductionMultiplier
  const u = Math.min(1.3, Math.max(0, rawU))

  return { u, labour, inputsRatio, outputRoom, resolvedInputs }
}

/**
 * Applies one month's production to an industry's local stock:
 * subtracts `u * qtyAtFullOutput` for each resolved input and adds
 * `u * qtyAtFullOutput` for each output (DESIGN 7.2: "production adds
 * `u * outputs`... and removes `u * inputs`"). Stock never goes
 * negative, protecting against floating-point drift at the boundary.
 *
 * @param {Record<string, number>} stock The industry's current local stock.
 * @param {number} u This month's realized utilisation (`computeIndustryUtilisation()`'s `u`).
 * @param {object} industryDef The industry's `industries.json` definition.
 * @param {ResolvedInput[]} resolvedInputs From the same `computeIndustryUtilisation()` call.
 * @returns {Record<string, number>} The next month's stock (a new object; `stock` is not mutated).
 */
export function applyIndustryProduction(stock, u, industryDef, resolvedInputs) {
  const next = { ...stock }

  for (const { cargo, qtyAtFullOutput } of resolvedInputs) {
    next[cargo] = Math.max(0, (next[cargo] || 0) - u * qtyAtFullOutput)
  }

  for (const [cargo, qtyAtFullOutput] of Object.entries(industryDef.outputs)) {
    next[cargo] = (next[cargo] || 0) + u * qtyAtFullOutput
  }

  return next
}
