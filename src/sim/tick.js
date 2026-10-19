import { DAYS_PER_YEAR, advanceDays, monthIndexOf, yearIndexOf } from './clock.js'
import { rngFor } from './rng.js'
import { agriProductivityMultiplier } from './era.js'
import { buildSitingContext, evaluateSiteRule } from './mapgen/industries.js'
import { computeFarmOutput, computeHinterlandSums, computeIndustryUtilisation, applyIndustryProduction } from './economy/production.js'
import { computeIndustryDemand, computePopulationDemand, computeRelayDemand, mergeDemand } from './economy/demand.js'
import { decayStock } from './economy/decay.js'
import { computeCoverage, computeCostOfLiving, computePrice, computePriceMultiplier } from './economy/prices.js'
import { applyBaselineFlows, computeBaselineFlows, nodeKey } from './economy/flows.js'
import { computeExport, computeImport, evaluatePortTierGrowth } from './economy/trade.js'
import { computeHousingConstruction, computeHousingRoom, applyHousingShrinkage } from './economy/housing.js'
import {
  applyClassDrift,
  computeAttractiveness,
  computeBirthsAndDeaths,
  computeMigrationFromSettlement,
} from './economy/population.js'
import {
  allocateLabour,
  computeConstructionJobsOffered,
  computeEmploymentRate,
  computeFarmJobsOffered,
  computeIndustryJobsOffered,
  computeJobAvailability,
  computeLabourForce,
  computePlannedUtilisation,
  computeServiceJobsOffered,
} from './economy/jobs.js'
import { computeNeedsCoverage, computeRawConfidence, computeRealWageIndex, computeWage, smoothConfidence } from './economy/confidence.js'
import {
  computeOpeningProbability,
  computeRichnessDepletion,
  evaluateIndustryLifecycle,
  getEligibleSuccessor,
  scaleIndustryDef,
  updateOpeningStreak,
} from './economy/industryLifecycle.js'
import { computeEconomyScore, computeOutputGrowthIndex, computeShock, computeTradeBalanceIndex, evaluateEconomyLevelCheck } from './economy/economyLevel.js'

/**
 * The monthly tick (DESIGN 7.1): orchestrates every economy module
 * built in T1.16-T1.23, in DESIGN's own exact 14-step order, against a
 * real `World`/`GameState`. This is the first task to actually call
 * these modules against live save data rather than hand-built test
 * fixtures — see DECISIONS.md for the bridging choices that follow
 * from gluing eight independently-designed modules together.
 *
 * Two genuine same-month ordering problems come up, both resolved the
 * same way: DESIGN lists industry production (step 3) before
 * employment (step 11), and migration (step 10) before employment too
 * — but both production's `workersAvailable` and migration's
 * attractiveness need labour-market numbers employment doesn't compute
 * until step 11. Both are resolved with a one-month lag: steps 3 and
 * 10 read whatever `employed`/`confidence` values are already sitting
 * on the entities from *last* month's step 11, and step 11 then
 * recomputes fresh values for next month to read. This is a standard
 * pattern for monthly economic simulations, not a shortcut — DESIGN's
 * own step list has no mechanism for same-month circular dependencies
 * to resolve any other way.
 *
 * @module sim/tick
 */

const FARM_CARGOES = Object.freeze(['grain', 'livestock', 'wool', 'milk', 'timber'])
const CONSTRUCTION_MATERIALS = Object.freeze(['bricks', 'planks', 'stone'])
const NEEDS_BASKET = Object.freeze(['food', 'coal', 'clothing'])
const HOME_SETTLEMENT_RADIUS_MILES = 10 // DESIGN 5.6: "a homeSettlementId (nearest settlement within 10 miles)".

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
 * @param {Record<string, number>} stock A settlement's or industry's stock map.
 * @param {Record<string, number>} output Tonnes to add, keyed by cargo id.
 * @returns {void}
 */
function addToStock(stock, output) {
  for (const [cargo, qty] of Object.entries(output)) {
    stock[cargo] = (stock[cargo] || 0) + qty
  }
}

/**
 * Straight-line distance in miles between two world positions.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
function distanceMiles(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1)
}

/**
 * @typedef {object} TickCaches
 * @property {Map<number, import('./economy/production.js').HinterlandSums>} hinterlandSums Per-settlement, computed once (land composition never changes in Phase 1).
 * @property {Map<string, object>} industriesById `industries.json`, keyed by id.
 * @property {Map<number, string>} classIdByIndex `classes.json` id, keyed by array index (matches `Settlement.pop`'s keys).
 * @property {Map<number, number>} classIndexById The reverse of `classIdByIndex`.
 * @property {Map<number, Array<{settlementId: number, link: object}>>} roadNeighbours Directly road-linked settlements, both directions, per settlement id.
 * @property {Map<number, import('./state.js').Settlement>} settlementsById Every settlement, keyed by id — avoids an O(n) `.find()` inside the migration and lifecycle loops.
 * @property {object} sitingContext From `mapgen/industries.js`'s `buildSitingContext()`, for industry opening's site search.
 */

/**
 * Builds the caches that stay valid for the lifetime of a loaded save
 * (nothing in them depends on monthly state) — computed once after
 * load/creation, then passed into every `runMonth()` call.
 *
 * @param {import('./state.js').World} world
 * @param {import('./state.js').GameState} gameState
 * @param {object} rules The full validated rules bundle (cargo, industries, economy, classes, eras, links, settlements, terrain, mapgen).
 * @returns {TickCaches}
 */
export function createTickCaches(world, gameState, rules) {
  const settlementIds = gameState.settlements.map((s) => s.id)
  const hinterlandSums = computeHinterlandSums(world.grid, settlementIds, rules.terrain)

  const industriesById = new Map(rules.industries.map((def) => [def.id, def]))

  const classIdByIndex = new Map(rules.classes.map((c, i) => [i, c.id]))
  const classIndexById = new Map(rules.classes.map((c, i) => [c.id, i]))

  const roadNeighbours = new Map(settlementIds.map((id) => [id, []]))
  for (const link of gameState.links) {
    if (link.mode !== 'road' || link.aType !== 's' || link.bType !== 's') continue
    roadNeighbours.get(link.aId)?.push({ settlementId: link.bId, link })
    roadNeighbours.get(link.bId)?.push({ settlementId: link.aId, link })
  }

  const sitingContext = buildSitingContext(world.grid, rules.mapgen, rules.terrain, rules.industries, gameState.settlements)
  const settlementsById = new Map(gameState.settlements.map((s) => [s.id, s]))

  return { hinterlandSums, industriesById, classIdByIndex, classIndexById, roadNeighbours, settlementsById, sitingContext }
}

/**
 * Reads a settlement's class populations as a plain `{working, middle,
 * upper}` object (jobs.js/population.js's shape), from its `pop` map
 * (keyed by class index).
 *
 * @param {import('./state.js').Settlement} settlement
 * @param {Map<number, string>} classIdByIndex
 * @returns {{working: number, middle: number, upper: number}}
 */
function readClassPop(settlement, classIdByIndex) {
  const result = { working: 0, middle: 0, upper: 0 }
  for (const [index, classId] of classIdByIndex) {
    result[classId] = settlement.pop[index]?.pop || 0
  }
  return result
}

/**
 * Sums a settlement's `{working, middle, upper}` jobs-offered
 * breakdown (industries at full planned utilisation, farm, service and
 * construction jobs) — used by both industry production's lagged
 * labour split (step 3) and real employment (step 11).
 *
 * @param {import('./state.js').Settlement} settlement
 * @param {import('./state.js').Industry[]} industries Every open industry at this settlement.
 * @param {number} homesBuiltThisMonth From this month's `computeHousingConstruction()` (0 before step 9 has run).
 * @param {number} year
 * @param {object} rules
 * @param {Map<string, object>} industriesById
 * @param {number} economyProductionMultiplier
 * @param {string} settlementKind
 * @param {{working: number, middle: number, upper: number}} classPop This settlement's current population by class.
 * @param {{working: number, middle: number, upper: number}} baseWageByClass `classes.json`'s `baseWagePerMonth`, keyed by class id.
 * @returns {{total: {working: number, middle: number, upper: number}, byIndustry: Map<number, {working: number, middle: number, upper: number}>}}
 */
function computeSettlementJobsOffered(settlement, industries, homesBuiltThisMonth, year, rules, industriesById, economyProductionMultiplier, settlementKind, classPop, baseWageByClass) {
  const total = { working: 0, middle: 0, upper: 0 }
  const byIndustry = new Map()

  for (const industry of industries) {
    const def = industriesById.get(industry.typeId)
    const scaledDef = scaleIndustryDef(def, industry.capacity)
    const uPlanned = computePlannedUtilisation(scaledDef, industry.stock, economyProductionMultiplier)
    const jobs = computeIndustryJobsOffered(scaledDef, uPlanned)
    byIndustry.set(industry.id, jobs)
    total.working += jobs.working
    total.middle += jobs.middle
    total.upper += jobs.upper
  }

  const farmJobs = computeFarmJobsOffered(classPop.working, settlementKind, year, rules.eras, rules.economy.jobs)
  total.working += farmJobs

  const serviceJobs = computeServiceJobsOffered(classPop, baseWageByClass, rules.economy.jobs)
  total.working += serviceJobs.working
  total.middle += serviceJobs.middle

  const constructionJobs = computeConstructionJobsOffered(homesBuiltThisMonth, rules.economy.jobs)
  total.working += constructionJobs.working

  return { total, byIndustry, farmJobs, serviceJobs, constructionJobs }
}

/**
 * Runs one month of DESIGN 7.1's 14-step cycle against a real
 * `World`/`GameState`, mutating `gameState` in place (entity stock,
 * population, housing, industry state, economy state, history and
 * events).
 *
 * @param {object} params
 * @param {import('./state.js').World} params.world
 * @param {import('./state.js').GameState} params.gameState
 * @param {object} params.rules
 * @param {string} params.seed
 * @param {number} params.gameDay The `gameDay` this month's tick lands on (the day `sim/clock.js`'s `onMonth` hook fired).
 * @param {TickCaches} params.caches From `createTickCaches()`.
 * @returns {void}
 */
export function runMonth({ world, gameState, rules, seed, gameDay, caches }) {
  const year = world.meta.startYear + yearIndexOf(gameDay)
  const monthIndex = monthIndexOf(gameDay)
  const { classIdByIndex, classIndexById, industriesById, hinterlandSums, roadNeighbours, settlementsById } = caches

  const levelMultipliers = rules.economy.levels[gameState.economyState.level] // Step 1.

  const industriesBySettlement = new Map(gameState.settlements.map((s) => [s.id, []]))
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    industriesBySettlement.get(industry.homeSettlementId)?.push(industry)
  }

  // --- Step 2: hinterland farm output. ---
  for (const settlement of gameState.settlements) {
    const output = computeFarmOutput(hinterlandSums.get(settlement.id), rules.economy, rules.eras, year, monthIndex, levelMultipliers.production)
    addToStock(settlement.stock, output)
  }

  // --- Step 3: industry production (workersAvailable lagged one month; see module doc). ---
  for (const settlement of gameState.settlements) {
    const industries = industriesBySettlement.get(settlement.id)
    if (industries.length === 0) continue

    const plannedBySource = industries.map((industry) => {
      const def = industriesById.get(industry.typeId)
      const scaledDef = scaleIndustryDef(def, industry.capacity)
      const uPlanned = computePlannedUtilisation(scaledDef, industry.stock, levelMultipliers.production)
      return { industry, scaledDef, jobs: computeIndustryJobsOffered(scaledDef, uPlanned) }
    })

    const totalPlannedJobs = { working: 0, middle: 0, upper: 0 }
    for (const { jobs } of plannedBySource) {
      totalPlannedJobs.working += jobs.working
      totalPlannedJobs.middle += jobs.middle
      totalPlannedJobs.upper += jobs.upper
    }

    const lastMonthEmployed = { working: 0, middle: 0, upper: 0 }
    for (const [index, classId] of classIdByIndex) {
      lastMonthEmployed[classId] = settlement.pop[index]?.employed || 0
    }

    for (const { industry, scaledDef, jobs } of plannedBySource) {
      let workersAvailable = 0
      for (const classId of ['working', 'middle', 'upper']) {
        if (totalPlannedJobs[classId] <= 0) continue
        workersAvailable += jobs[classId] * (lastMonthEmployed[classId] / totalPlannedJobs[classId])
      }

      const result = computeIndustryUtilisation(scaledDef, industry.stock, workersAvailable, levelMultipliers.production)
      industry.stock = applyIndustryProduction(industry.stock, result.u, scaledDef, result.resolvedInputs)
      industry.utilisation = result.u
    }
  }

  // --- Step 4: demand (population + industry), merged per node. Ephemeral: not persisted on entities. ---
  const nodeDemand = new Map()
  const industryDemandById = new Map()
  const allCargoIds = rules.cargo.map((c) => c.id)
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    const def = industriesById.get(industry.typeId)
    const scaledDef = scaleIndustryDef(def, industry.capacity)
    const demand = computeIndustryDemand(scaledDef)
    industryDemandById.set(industry.id, demand)
    nodeDemand.set(nodeKey('i', industry.id), demand)
  }
  for (const settlement of gameState.settlements) {
    const classRows = [...classIdByIndex].map(([index, classId]) => ({
      classId,
      pop: settlement.pop[index]?.pop || 0,
      confidence: settlement.pop[index]?.confidence ?? 50,
    }))
    const populationDemand = computePopulationDemand(classRows, settlement.kind, rules.difficulty.demandMode, rules.economy, levelMultipliers.demand, monthIndex, year)

    // A settlement's own node also carries its co-located industries' input demand (DESIGN
    // 7.3's `monthlyDemand[node][cargo]` is the sum of population *and* industry demand at that
    // node), not just population demand — otherwise no settlement ever shows genuine demand for
    // a purely-industrial cargo (clay, coal, iron_ore...), no price gradient toward it can ever
    // form between settlements, and an inland mill's inputs could never arrive no matter how
    // long the baseline trickle runs. See DECISIONS.md.
    const localIndustryDemands = (industriesBySettlement.get(settlement.id) || []).map((ind) => industryDemandById.get(ind.id) || {})

    // A tiny, flat "merchant" demand for every cargo (see computeRelayDemand's own doc) so a
    // multi-hop shipment has a genuine, if small, price gradient to follow through every
    // intermediate settlement along the way, not just its final destination.
    const totalPop = [...classIdByIndex.keys()].reduce((sum, index) => sum + (settlement.pop[index]?.pop || 0), 0)
    const relayDemand = computeRelayDemand(totalPop, allCargoIds, rules.economy.flow.relayDemandPerThousandPerMonth)

    nodeDemand.set(nodeKey('s', settlement.id), mergeDemand(populationDemand, relayDemand, ...localIndustryDemands))
  }

  // --- Step 5: perishable decay. ---
  for (const settlement of gameState.settlements) settlement.stock = decayStock(settlement.stock, rules.cargo)
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    industry.stock = decayStock(industry.stock, rules.cargo)
  }

  // --- Step 6: prices. Ephemeral per-node price maps. ---
  const nodePrices = new Map()
  const cargoById = new Map(rules.cargo.map((c) => [c.id, c]))
  let priceMultiplierSamples = 0
  let priceMultiplierAtBound = 0

  function computeNodePrices(key, stock, demand) {
    const prices = {}
    const cargoIds = new Set([...Object.keys(stock), ...Object.keys(demand)])
    for (const cargoId of cargoIds) {
      const cargoDef = cargoById.get(cargoId)
      if (!cargoDef) continue
      const coverage = computeCoverage(stock[cargoId] || 0, demand[cargoId] || 0)
      const multiplier = computePriceMultiplier(coverage, cargoDef.elasticity, rules.economy.price)
      prices[cargoId] = computePrice(cargoDef.basePrice, multiplier, levelMultipliers.revenue)

      // Tracked for T1.25's balance harness gate ("no more than 25% of months sitting on a price
      // bound"). Only counted where a genuine market exists this month (demand > 0) — a cargo
      // whose era hasn't arrived yet, or that nobody at this node demands at all, sits at pMin by
      // construction (DESIGN's own "zero-demand nodes sit at the floor"), and counting that as a
      // failing price sample would be measuring an absent market, not an unhealthy one.
      if ((demand[cargoId] || 0) > 0) {
        priceMultiplierSamples++
        if (multiplier === rules.economy.price.pMin || multiplier === rules.economy.price.pMax) priceMultiplierAtBound++
      }
    }
    nodePrices.set(key, prices)
    return prices
  }

  for (const settlement of gameState.settlements) {
    computeNodePrices(nodeKey('s', settlement.id), settlement.stock, nodeDemand.get(nodeKey('s', settlement.id)) || {})
  }
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    computeNodePrices(nodeKey('i', industry.id), industry.stock, nodeDemand.get(nodeKey('i', industry.id)) || {})
  }

  // --- Step 7: baseline carrier flows. ---
  const nodeStock = new Map()
  const nodeProducedCargoes = new Map()
  for (const settlement of gameState.settlements) {
    nodeStock.set(nodeKey('s', settlement.id), settlement.stock)
    nodeProducedCargoes.set(nodeKey('s', settlement.id), new Set(FARM_CARGOES))
  }
  const localIndustryLinks = []
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    const def = industriesById.get(industry.typeId)
    nodeStock.set(nodeKey('i', industry.id), industry.stock)
    nodeProducedCargoes.set(nodeKey('i', industry.id), new Set(Object.keys(def.outputs)))

    // `links.json` never connects an industry node to anything (only settlement-settlement/world
    // links exist — see DECISIONS.md), so without this the general flow below could never touch
    // an industry's stock at all. Synthesised fresh every month (never persisted to
    // `gameState.links`) rather than generated once at world-creation time, so this doesn't
    // disturb the golden world checksums T1.12 committed. Using the best road tier as its
    // capacity is a deliberate choice, not a new invented number: DESIGN 5.6 guarantees every
    // industry sits within 10 miles of its home settlement, which a well-kept local road
    // comfortably serves, and feeding it through the *same* `computeBaselineFlows()` call (rather
    // than a bespoke pairwise transfer) is what lets industrial cargo correctly multi-hop
    // industry -> settlement -> neighbouring settlement -> that settlement's own industry over
    // successive months, exactly as DESIGN 7.5 describes for every other link.
    localIndustryLinks.push({ id: `local-industry-${industry.id}`, mode: 'road', tier: 3, aType: 'i', aId: industry.id, bType: 's', bId: industry.homeSettlementId, condition: 1 })
  }

  const flowResults = computeBaselineFlows({
    links: [...gameState.links, ...localIndustryLinks],
    nodeStock,
    nodeDemand,
    nodeProducedCargoes,
    nodePrices,
    linksRules: rules.links,
    flowRules: rules.economy.flow,
  })
  const flowedStock = applyBaselineFlows(nodeStock, flowResults)
  for (const settlement of gameState.settlements) settlement.stock = flowedStock.get(nodeKey('s', settlement.id)) || settlement.stock
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    industry.stock = flowedStock.get(nodeKey('i', industry.id)) || industry.stock
  }

  // --- Step 8: imports and exports at ports. ---
  let monthTradeValue = 0
  let monthTradeBalance = 0
  for (const settlement of gameState.settlements) {
    if (settlement.portTier <= 0) continue
    for (const cargoDef of rules.cargo) {
      const imported = computeImport(cargoDef.id, settlement.portTier, year, rules.cargo, rules.eras.worldTrade)
      if (imported.quantity > 0) {
        settlement.stock[cargoDef.id] = (settlement.stock[cargoDef.id] || 0) + imported.quantity
        monthTradeValue += imported.value
        monthTradeBalance -= imported.value
      }

      const exported = computeExport(cargoDef.id, settlement.portTier, year, settlement.stock[cargoDef.id] || 0, rules.cargo, rules.eras.worldTrade, levelMultipliers.revenue)
      if (exported.quantity > 0) {
        settlement.stock[cargoDef.id] -= exported.quantity
        monthTradeValue += exported.value
        monthTradeBalance += exported.value
      }
    }
  }

  // --- Step 9: housing and construction. ---
  const homesBuiltBySettlement = new Map()
  for (const settlement of gameState.settlements) {
    const totalPop = [...classIdByIndex.keys()].reduce((sum, index) => sum + (settlement.pop[index]?.pop || 0), 0)
    const materialsStock = { bricks: settlement.stock.bricks || 0, planks: settlement.stock.planks || 0, stone: settlement.stock.stone || 0 }
    const { homesBuilt, materialsConsumed } = computeHousingConstruction(totalPop, settlement.housing, materialsStock, rules.economy.population)

    for (const material of CONSTRUCTION_MATERIALS) {
      settlement.stock[material] = Math.max(0, (settlement.stock[material] || 0) - materialsConsumed[material])
    }
    settlement.housing += homesBuilt
    settlement.housing = applyHousingShrinkage(totalPop, settlement.housing, rules.economy.population)
    homesBuiltBySettlement.set(settlement.id, homesBuilt)
  }

  // --- Step 10: population (births, deaths, migration). Attractiveness uses last month's employment/confidence (lagged; see module doc). ---
  const attractivenessBySettlement = new Map()
  for (const settlement of gameState.settlements) {
    const totalPop = [...classIdByIndex.keys()].reduce((sum, index) => sum + (settlement.pop[index]?.pop || 0), 0)
    const housingRoom = computeHousingRoom(totalPop, settlement.housing)
    const prices = nodePrices.get(nodeKey('s', settlement.id)) || {}
    const needsCoverageByCargo = {}
    for (const cargo of NEEDS_BASKET) {
      needsCoverageByCargo[cargo] = computeCoverage(settlement.stock[cargo] || 0, (nodeDemand.get(nodeKey('s', settlement.id)) || {})[cargo] || 0)
    }
    const needsCoverage = computeNeedsCoverage(needsCoverageByCargo)

    const perClass = new Map()
    for (const [index, classId] of classIdByIndex) {
      const row = settlement.pop[index]
      if (!row) continue
      // Last month's step 11 persisted these two into economyState.indicators (see that step); neutral 0.5 before any step 11 has ever run.
      const jobAvailability = gameState.economyState.indicators[`jobAvailability:${settlement.id}:${classId}`] ?? 0.5
      const realWageIndex = gameState.economyState.indicators[`realWageIndex:${settlement.id}:${classId}`] ?? 0.5
      const serviceIndex = gameState.economyState.indicators[`serviceIndex:${settlement.id}`] ?? 0.5
      perClass.set(classId, computeAttractiveness({ jobAvailability, realWageIndex, needsCoverage, housingRoom, serviceIndex }, rules.economy.attractivenessWeights))
    }
    attractivenessBySettlement.set(settlement.id, perClass)
  }

  for (const settlement of gameState.settlements) {
    const totalPopBefore = [...classIdByIndex.keys()].reduce((sum, index) => sum + (settlement.pop[index]?.pop || 0), 0)
    const occupancy = settlement.housing > 0 ? totalPopBefore / settlement.housing : 1
    const foodCoverage = computeCoverage(settlement.stock.food || 0, (nodeDemand.get(nodeKey('s', settlement.id)) || {}).food || 0)

    for (const [index, classId] of classIdByIndex) {
      const row = settlement.pop[index]
      if (!row) continue
      const { births, deaths } = computeBirthsAndDeaths(row.pop, year, foodCoverage, occupancy, rules.eras, rules.economy.population)
      row.pop = Math.max(0, row.pop + births - deaths)
    }

    const candidates = (roadNeighbours.get(settlement.id) || []).map(({ settlementId, link }) => ({
      toId: settlementId,
      toAttractiveness: 0, // Filled in per class below.
      condition: link.condition,
      distanceMiles: link.lengthMi,
    }))
    if (candidates.length === 0) continue

    for (const [index, classId] of classIdByIndex) {
      const row = settlement.pop[index]
      if (!row || row.pop <= 0) continue
      const fromAttractiveness = attractivenessBySettlement.get(settlement.id)?.get(classId) || 0
      const classCandidates = candidates.map((c) => ({ ...c, toAttractiveness: attractivenessBySettlement.get(c.toId)?.get(classId) || 0 }))
      const mobility = rules.economy.population.mobility[classId]
      const moves = computeMigrationFromSettlement(row.pop, mobility, fromAttractiveness, classCandidates, rules.economy.population.migrationOutflowCapPerMonth, rules.economy.population.migrationDistanceScaleMiles)

      for (const { toId, moved } of moves) {
        if (moved <= 0) continue
        row.pop -= moved
        const destSettlement = settlementsById.get(toId)
        if (destSettlement?.pop[index]) destSettlement.pop[index].pop += moved
      }
    }
  }

  // --- Step 11: employment and confidence. Real jobsOffered (post-production, post-construction), two passes for neighbour borrowing. ---
  const settlementLabour = new Map()
  for (const settlement of gameState.settlements) {
    const classPop = readClassPop(settlement, classIdByIndex)
    const baseWageByClass = { working: rules.classes[classIndexById.get('working')].baseWagePerMonth, middle: rules.classes[classIndexById.get('middle')].baseWagePerMonth, upper: rules.classes[classIndexById.get('upper')].baseWagePerMonth }

    const industries = industriesBySettlement.get(settlement.id)
    const jobsResult = computeSettlementJobsOffered(settlement, industries, homesBuiltBySettlement.get(settlement.id) || 0, year, rules, industriesById, levelMultipliers.production, settlement.kind, classPop, baseWageByClass)

    const labourForce = { working: 0, middle: 0, upper: 0 }
    for (const [index, classId] of classIdByIndex) {
      labourForce[classId] = computeLabourForce(settlement.pop[index]?.pop || 0, rules.classes[index].participation)
    }

    const ownSurplus = {
      working: Math.max(0, labourForce.working - jobsResult.total.working),
      middle: Math.max(0, labourForce.middle - jobsResult.total.middle),
      upper: Math.max(0, labourForce.upper - jobsResult.total.upper),
    }

    settlementLabour.set(settlement.id, { jobsOffered: jobsResult.total, labourForce, ownSurplus, byIndustry: jobsResult.byIndustry, serviceJobs: jobsResult.serviceJobs })
  }

  for (const settlement of gameState.settlements) {
    const labour = settlementLabour.get(settlement.id)
    const neighbours = (roadNeighbours.get(settlement.id) || []).map(({ settlementId }) => ({
      settlementId,
      unemployed: settlementLabour.get(settlementId)?.ownSurplus || { working: 0, middle: 0, upper: 0 },
    }))
    const ownUnemployed = { working: labour.labourForce.working, middle: labour.labourForce.middle, upper: labour.labourForce.upper }
    const { employed, vacancies } = allocateLabour(labour.jobsOffered, ownUnemployed, neighbours)

    for (const [index, classId] of classIdByIndex) {
      const row = settlement.pop[index]
      if (!row) continue

      const employmentRate = computeEmploymentRate(employed[classId], labour.labourForce[classId])
      const jobAvailability = computeJobAvailability(vacancies[classId], labour.labourForce[classId])
      const wage = computeWage(rules.classes[index].baseWagePerMonth, employmentRate, rules.economy.wages)
      const prices = nodePrices.get(nodeKey('s', settlement.id)) || {}
      const costOfLiving = computeCostOfLiving(prices)
      const realWageIndex = computeRealWageIndex(wage, employmentRate, costOfLiving)

      const needsCoverageByCargo = {}
      for (const cargo of NEEDS_BASKET) {
        needsCoverageByCargo[cargo] = computeCoverage(settlement.stock[cargo] || 0, (nodeDemand.get(nodeKey('s', settlement.id)) || {})[cargo] || 0)
      }
      const needsCoverage = computeNeedsCoverage(needsCoverageByCargo)

      const totalPop = [...classIdByIndex.keys()].reduce((sum, i) => sum + (settlement.pop[i]?.pop || 0), 0)
      const occupancy = settlement.housing > 0 ? totalPop / settlement.housing : 1

      const rawConfidence = computeRawConfidence({ employmentRate, realWageIndex, needsCoverage, occupancy }, rules.economy.confidence)
      row.confidence = smoothConfidence(row.confidence, rawConfidence, rules.economy.confidence)
      row.employed = employed[classId]

      // Persisted for next month's step 10 (migration attractiveness) to read — see that step's lagged reads.
      gameState.economyState.indicators[`jobAvailability:${settlement.id}:${classId}`] = jobAvailability
      gameState.economyState.indicators[`realWageIndex:${settlement.id}:${classId}`] = realWageIndex
    }

    const totalPop = [...classIdByIndex.keys()].reduce((sum, i) => sum + (settlement.pop[i]?.pop || 0), 0)
    const serviceIndex = totalPop > 0 ? clamp01((labour.serviceJobs.working + labour.serviceJobs.middle) / (totalPop * rules.economy.jobs.serviceIndexPerCapitaScale)) : 0
    gameState.economyState.indicators[`serviceIndex:${settlement.id}`] = serviceIndex

    // Persisted for the yearly class-drift hook (runYearEnd), which runs outside runMonth and has no access to this month's local jobsOffered.
    gameState.economyState.indicators[`jobsOffered:${settlement.id}:working`] = labour.jobsOffered.working
    gameState.economyState.indicators[`jobsOffered:${settlement.id}:middle`] = labour.jobsOffered.middle
    gameState.economyState.indicators[`jobsOffered:${settlement.id}:upper`] = labour.jobsOffered.upper
  }

  // --- Step 12: industry lifecycle. ---
  const priceByClosingCargo = new Map()
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    const def = industriesById.get(industry.typeId)
    const homeSettlement = settlementsById.get(industry.homeSettlementId)
    const outputCargoId = Object.keys(def.outputs)[0]
    const priceMult = outputCargoId ? ((nodePrices.get(nodeKey('i', industry.id)) || {})[outputCargoId] || def.basePrice) / (cargoById.get(outputCargoId)?.basePrice || 1) : 1

    if (def.tier === 'primary' && def.siteRules.some((r) => typeof r === 'string' && r.startsWith('resource:'))) {
      industry.richnessLeft = computeRichnessDepletion(industry.richnessLeft, industry.utilisation, rules.economy.industryLifecycle)
    }

    const result = evaluateIndustryLifecycle(
      { utilisation: industry.utilisation, monthsLow: industry.monthsLow, capacityMultiplier: industry.capacity, richnessLeft: industry.richnessLeft, year, priceMult, industryDef: def },
      rules.economy.industryLifecycle,
    )
    industry.monthsLow = result.monthsLow
    industry.capacity = result.capacityMultiplier

    if (result.event) {
      gameState.eventsLog.push({ id: null, gameDay, kind: result.event.kind, subjectType: 'industry', subjectId: industry.id, text: `${industry.name}: ${result.event.reason}` })
    }

    if (result.closed) {
      industry.closedDay = gameDay
      if (homeSettlement) priceByClosingCargo.set(industry.id, { def, homeSettlement })
    }
  }

  for (const [industryId, { def, homeSettlement }] of priceByClosingCargo) {
    const successor = getEligibleSuccessor(def, year, industriesById)
    if (!successor) continue
    const closing = gameState.industries.find((i) => i.id === industryId)
    const nextId = Math.max(0, ...gameState.industries.map((i) => i.id)) + 1
    gameState.industries.push({
      id: nextId, typeId: successor.id, name: successor.name, x: closing.x, y: closing.y,
      homeSettlementId: homeSettlement.id, capacity: 1.0, utilisation: 0, richnessLeft: 1, openedDay: gameDay, closedDay: null, monthsLow: 0, stock: {},
    })
    gameState.eventsLog.push({ id: null, gameDay, kind: 'industry_opened', subjectType: 'industry', subjectId: nextId, text: `${successor.name} opens as ${def.name}'s successor` })
  }

  // Opening: island-wide mean priceMult per cargo, streak tracking, probability, seeded roll.
  for (const cargoDef of rules.cargo) {
    const nodeKeysForCargo = [...nodePrices.keys()]
    const multiples = nodeKeysForCargo
      .map((key) => (nodePrices.get(key) || {})[cargoDef.id])
      .filter((p) => p !== undefined)
      .map((p) => p / cargoDef.basePrice)
    if (multiples.length === 0) continue
    const meanPriceMult = multiples.reduce((a, b) => a + b, 0) / multiples.length

    const streakKey = `openingStreak:${cargoDef.id}`
    const monthsAboveThreshold = updateOpeningStreak(gameState.economyState.indicators[streakKey] || 0, meanPriceMult, rules.economy.industryLifecycle)
    gameState.economyState.indicators[streakKey] = monthsAboveThreshold
    if (monthsAboveThreshold < rules.economy.industryLifecycle.openRequiredMonths) continue

    const producerDef = rules.industries.find((def) => def.outputs[cargoDef.id] !== undefined)
    if (!producerDef || year < producerDef.eraFrom || (producerDef.eraTo !== null && year > producerDef.eraTo)) continue

    const site = findOpeningSite(producerDef, world, gameState, caches)
    const inputsPlausible = producerDef.inputs.every((slot) => {
      const options = slot.any ? Object.keys(slot.any) : [slot.cargo]
      return options.some((cargo) => (cargoById.get(cargo)?.importable) || hasNearbyProducer(cargo, site?.x, site?.y, gameState, industriesById))
    })

    const upperConfidence = meanConfidence(gameState, classIndexById.get('upper'))
    const probability = computeOpeningProbability(
      { monthsAboveThreshold, siteAvailable: site !== null, inputsPlausible, eraAllows: true, upperConfidence, economyLevel: gameState.economyState.level },
      rules.economy.industryLifecycle,
    )

    if (probability > 0 && rngFor(seed, 'tick', gameDay, 'industryOpen', cargoDef.id)() < probability) {
      const nextId = Math.max(0, ...gameState.industries.map((i) => i.id), 0) + 1
      gameState.industries.push({
        id: nextId, typeId: producerDef.id, name: producerDef.name, x: site.x, y: site.y,
        homeSettlementId: site.homeSettlementId, capacity: 1.0, utilisation: 0, richnessLeft: 1, openedDay: gameDay, closedDay: null, monthsLow: 0, stock: {},
      })
      gameState.eventsLog.push({ id: null, gameDay, kind: 'industry_opened', subjectType: 'industry', subjectId: nextId, text: `${producerDef.name} opens to meet sustained demand for ${cargoDef.id}` })
      gameState.economyState.indicators[streakKey] = 0
    }
  }

  // --- Step 13: history snapshot and events. ---
  let popTotal = 0
  let popU = 0
  let popM = 0
  let popW = 0
  let employmentSum = 0
  let employmentCount = 0
  let confidenceSum = 0
  let confidenceCount = 0
  for (const settlement of gameState.settlements) {
    for (const [index, classId] of classIdByIndex) {
      const row = settlement.pop[index]
      if (!row) continue
      popTotal += row.pop
      if (classId === 'upper') popU += row.pop
      else if (classId === 'middle') popM += row.pop
      else popW += row.pop

      const labourForce = computeLabourForce(row.pop, rules.classes[index].participation)
      if (labourForce > 0) {
        employmentSum += computeEmploymentRate(row.employed, labourForce)
        employmentCount++
      }
      confidenceSum += row.confidence
      confidenceCount++
    }
  }
  const employmentMean = employmentCount > 0 ? employmentSum / employmentCount : 0
  const confidenceMean = confidenceCount > 0 ? confidenceSum / confidenceCount : 50

  let totalOutput = 0
  for (const settlement of gameState.settlements) totalOutput += Object.values(settlement.stock).reduce((a, b) => a + Math.max(0, b), 0)
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    totalOutput += Object.values(industry.stock).reduce((a, b) => a + Math.max(0, b), 0)
  }

  gameState.historyMonthly.push({
    monthIndex: gameState.historyMonthly.length,
    popTotal, popU, popM, popW,
    employment: employmentMean,
    confidence: confidenceMean,
    tradeValue: monthTradeValue,
    level: gameState.economyState.level,
    extra: { totalOutput, tradeBalance: monthTradeBalance, priceMultiplierSamples, priceMultiplierAtBound },
  })

  // --- Step 14: economy level check, March and September only. ---
  if (monthIndex === 2 || monthIndex === 8) {
    const previous = gameState.historyMonthly.length >= 2 ? gameState.historyMonthly[gameState.historyMonthly.length - 2] : null
    const previousOutput = previous?.extra?.totalOutput ?? 0
    const outputGrowth = computeOutputGrowthIndex(previousOutput, totalOutput, rules.economy.economyLevelScore)
    const tradeBalanceIndex = computeTradeBalanceIndex(monthTradeBalance, monthTradeValue)
    const shock = computeShock(seed, gameDay)

    const score = computeEconomyScore(
      { employmentMean, outputGrowth, tradeBalanceIndex, confidenceMean: confidenceMean / 100, playerActivity: rules.economy.economyLevelScore.neutralPlayerActivity, shock },
      gameState.economyState.lastChangeDir,
      rules.economy.economyLevelScore,
    )
    const { nextLevel, changeDir } = evaluateEconomyLevelCheck(gameState.economyState.level, score, rules.economy.economyLevelScore)
    gameState.economyState.level = nextLevel
    gameState.economyState.lastChangeDir = changeDir
    gameState.economyState.lastCheckDay = gameDay
  }

  // Port tier growth: checked every month (DESIGN doesn't restrict this to March/September).
  for (const settlement of gameState.settlements) {
    if (settlement.portTier <= 0 || settlement.portTier >= 3) continue
    const worldLink = gameState.links.find((l) => l.aType === 's' && l.aId === settlement.id && l.bType === 'w')
    if (!worldLink) continue

    let throughput = 0
    for (const cargoDef of rules.cargo) {
      throughput += computeImport(cargoDef.id, settlement.portTier, year, rules.cargo, rules.eras.worldTrade).quantity
      throughput += computeExport(cargoDef.id, settlement.portTier, year, 0, rules.cargo, rules.eras.worldTrade, levelMultipliers.revenue).quantity
    }

    const streakKey = `portStreak:${settlement.id}`
    const result = evaluatePortTierGrowth(gameState.economyState.indicators[streakKey] || 0, settlement.portTier, throughput, worldLink, rules.links, rules.economy.ports)
    gameState.economyState.indicators[streakKey] = result.monthsAboveThreshold
    settlement.portTier = result.nextTier
  }
}

/**
 * @param {string} cargoId
 * @param {number|undefined} x
 * @param {number|undefined} y
 * @param {import('./state.js').GameState} gameState
 * @param {Map<string, object>} industriesById
 * @returns {boolean}
 */
function hasNearbyProducer(cargoId, x, y, gameState, industriesById) {
  if (x === undefined) return false
  for (const industry of gameState.industries) {
    if (industry.closedDay !== null) continue
    const def = industriesById.get(industry.typeId)
    if (def.outputs[cargoId] === undefined) continue
    if (distanceMiles(x, y, industry.x, industry.y) <= 40) return true // DESIGN 7.8's own "within 40 miles".
  }
  return false
}

/**
 * @param {import('./state.js').GameState} gameState
 * @param {number} classIndex
 * @returns {number} Population-weighted mean confidence for one class, island-wide.
 */
function meanConfidence(gameState, classIndex) {
  let sum = 0
  let weight = 0
  for (const settlement of gameState.settlements) {
    const row = settlement.pop[classIndex]
    if (!row || row.pop <= 0) continue
    sum += row.confidence * row.pop
    weight += row.pop
  }
  return weight > 0 ? sum / weight : 50
}

/**
 * A simplified site search for a newly-opening industry (DESIGN 5.6):
 * the first buildable land cell satisfying the industry's site rules,
 * with a settlement within the labour-catchment radius. Not as
 * sophisticated as generation-time placement (no scoring, no jitter) —
 * see DECISIONS.md for why a first-match search is enough here.
 *
 * @param {object} industryDef
 * @param {import('./state.js').World} world
 * @param {import('./state.js').GameState} gameState
 * @param {TickCaches} caches
 * @returns {{x: number, y: number, homeSettlementId: number}|null}
 */
function findOpeningSite(industryDef, world, gameState, caches) {
  const { grid } = world
  const size = grid.width * grid.height
  const cellMiles = grid.cellMiles

  for (let i = 0; i < size; i++) {
    if (grid.water[i] !== 0) continue
    if (!industryDef.siteRules.every((rule) => evaluateSiteRule(rule, i, caches.sitingContext))) continue

    const x = (i % grid.width) * cellMiles
    const y = Math.floor(i / grid.width) * cellMiles

    let nearestSettlement = null
    let nearestDistance = Infinity
    for (const settlement of gameState.settlements) {
      const d = distanceMiles(x, y, settlement.x, settlement.y)
      if (d < nearestDistance) {
        nearestDistance = d
        nearestSettlement = settlement
      }
    }
    if (!nearestSettlement || nearestDistance > HOME_SETTLEMENT_RADIUS_MILES) continue

    const existingAtSite = gameState.industries.filter((ind) => ind.closedDay === null && ind.typeId === industryDef.id && ind.homeSettlementId === nearestSettlement.id)
    if (existingAtSite.length >= industryDef.maxPerNode) continue

    return { x, y, homeSettlementId: nearestSettlement.id }
  }

  return null
}

/**
 * Runs DESIGN 7.6's yearly class-drift hook (one of PHASES.md's "yearly
 * hooks", distinct from the 14 monthly steps): each settlement's class
 * shares move 10% of the way toward the shares implied by local jobs,
 * with actual population counts redistributed between classes to
 * match the new shares. Reads the jobs-offered totals step 11
 * persisted into `economyState.indicators` during the year's last
 * monthly tick, since this function has no other access to that
 * ephemeral, per-month computation.
 *
 * @param {import('./state.js').GameState} gameState
 * @param {TickCaches} caches
 * @param {object} rules
 * @returns {void}
 */
export function runYearEnd(gameState, caches, rules) {
  const { classIdByIndex } = caches

  for (const settlement of gameState.settlements) {
    const totalPop = [...classIdByIndex.keys()].reduce((sum, i) => sum + (settlement.pop[i]?.pop || 0), 0)
    if (totalPop <= 0) continue

    const currentShares = {}
    for (const [index, classId] of classIdByIndex) currentShares[classId] = (settlement.pop[index]?.pop || 0) / totalPop

    const jobsOffered = {
      working: gameState.economyState.indicators[`jobsOffered:${settlement.id}:working`] || 0,
      middle: gameState.economyState.indicators[`jobsOffered:${settlement.id}:middle`] || 0,
      upper: gameState.economyState.indicators[`jobsOffered:${settlement.id}:upper`] || 0,
    }
    const totalJobs = jobsOffered.working + jobsOffered.middle + jobsOffered.upper
    // No jobs data yet (e.g. a year with no step 11 ever run): drift toward the status quo, i.e. no actual drift.
    const jobImpliedShares = totalJobs > 0
      ? { working: jobsOffered.working / totalJobs, middle: jobsOffered.middle / totalJobs, upper: jobsOffered.upper / totalJobs }
      : currentShares

    const nextShares = applyClassDrift(currentShares, jobImpliedShares, rules.economy.population)

    for (const [index, classId] of classIdByIndex) {
      if (settlement.pop[index]) settlement.pop[index].pop = totalPop * nextShares[classId]
    }
  }
}

/**
 * Advances the simulation by whole years (PHASES.md's own
 * "`runYears(state, n)` function for the harness"): drives
 * `sim/clock.js`'s calendar forward day by day, calling `runMonth()`
 * on every month boundary and `runYearEnd()` on every year boundary,
 * in that order whenever both land on the same day (DESIGN's own step
 * list treats the monthly cycle and yearly hooks as separate concerns,
 * never specifying which runs first on a January 1st that is also a
 * month boundary — `sim/clock.js`'s own hook order, month before year,
 * is used here, matching the same ordering `tickDay()` already fires
 * them in).
 *
 * @param {object} state
 * @param {import('./state.js').World} state.world
 * @param {import('./state.js').GameState} state.gameState
 * @param {object} state.rules
 * @param {string} state.seed
 * @param {number} state.gameDay The starting `gameDay`.
 * @param {number} years How many years to advance.
 * @returns {number} The final `gameDay`.
 */
export function runYears({ world, gameState, rules, seed, gameDay }, years) {
  const caches = createTickCaches(world, gameState, rules)

  return advanceDays(gameDay, years * DAYS_PER_YEAR, {
    onMonth: (day) => runMonth({ world, gameState, rules, seed, gameDay: day, caches }),
    onYearEnd: () => runYearEnd(gameState, caches, rules),
  })
}
