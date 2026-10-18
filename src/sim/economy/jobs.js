import { computeIndustryUtilisation } from './production.js'
import { agriProductivityMultiplier } from '../era.js'

/**
 * Jobs and labour (DESIGN 7.7): how many positions each of the four
 * job sources offers, and how available unemployed workers get
 * allocated to fill them (home settlement first, nearest neighbour by
 * road if short). `src/sim/economy/confidence.js` covers wages, real
 * wage index, needs coverage and confidence.
 *
 * @module sim/economy/jobs
 */

/**
 * Labour force at a settlement for one class (DESIGN 7.7).
 *
 * @param {number} pop Population in this class.
 * @param {number} participation This class's `classes.json` `participation` rate.
 * @returns {number} Labour force.
 */
export function computeLabourForce(pop, participation) {
  return pop * participation
}

/**
 * An industry's utilisation *before* the labour term is applied —
 * DESIGN 7.7's `u_planned`, the output level it would run at if it had
 * all the workers it wanted, limited only by inputs and output room.
 * Reuses `computeIndustryUtilisation()` from T1.16 with an infinite
 * labour supply (`workersAvailable: Infinity` always makes the labour
 * term exactly 1 — see `production.js`), rather than duplicating the
 * inputs/output-room maths here.
 *
 * @param {object} industryDef The industry's `industries.json` definition.
 * @param {Record<string, number>} stock The industry's current local stock.
 * @param {number} economyProductionMultiplier The current economy level's production multiplier.
 * @returns {number} `u_planned`, in [0, 1.3].
 */
export function computePlannedUtilisation(industryDef, stock, economyProductionMultiplier) {
  return computeIndustryUtilisation(industryDef, stock, Infinity, economyProductionMultiplier).u
}

/**
 * Positions an industry offers this month (DESIGN 7.7: `jobs[class] *
 * u_planned`).
 *
 * @param {object} industryDef The industry's `industries.json` definition (`jobs: {working, middle, upper}`).
 * @param {number} plannedUtilisation From `computePlannedUtilisation()`.
 * @returns {{working: number, middle: number, upper: number}}
 */
export function computeIndustryJobsOffered(industryDef, plannedUtilisation) {
  return {
    working: (industryDef.jobs.working || 0) * plannedUtilisation,
    middle: (industryDef.jobs.middle || 0) * plannedUtilisation,
    upper: (industryDef.jobs.upper || 0) * plannedUtilisation,
  }
}

/** @type {readonly string[]} Settlement kinds DESIGN 7.6/7.7 names for farm labour. */
const FARM_LABOUR_KINDS = Object.freeze(['village', 'hamlet'])

/**
 * Farm labour positions (DESIGN 7.6/7.7: "farms offer a labour share"
 * of Working pop in villages and hamlets, "falling with agricultural
 * productivity over time"). The fall-off reuses `era.js`'s
 * `agriProductivityMultiplier()` directly — DESIGN never gives this
 * its own separate curve, and the two are the same underlying trend
 * (the exact productivity gain T1.16 already applies to farm output
 * is, symmetrically, the exact labour saving here).
 *
 * @param {number} workingPop Working-class population at this settlement.
 * @param {string} settlementKind The settlement's kind id.
 * @param {number} year The calendar year.
 * @param {object} erasRules The validated `eras.json` rules.
 * @param {object} jobsRules `economy.json`'s `jobs` block.
 * @returns {number} Farm labour positions (Working class only; 0 for any kind other than village/hamlet).
 */
export function computeFarmJobsOffered(workingPop, settlementKind, year, erasRules, jobsRules) {
  if (!FARM_LABOUR_KINDS.includes(settlementKind)) return 0
  const share = jobsRules.farmLabourShareOfWorking / agriProductivityMultiplier(erasRules, year)
  return workingPop * share
}

/**
 * Service-sector positions (DESIGN 5-ish/7.7: "jobs... proportional to
 * population and wealth... provides middle and working jobs" —
 * explicitly not Upper). "Wealth" is taken as the settlement's
 * population-weighted average `baseWagePerMonth` (classes.json), a
 * genuine class-mix wealth proxy with no new data needed; the result
 * splits between Working and Middle in proportion to their own
 * population share (Upper gets none, matching DESIGN's wording
 * exactly).
 *
 * @param {{working: number, middle: number, upper: number}} classPop Population by class.
 * @param {{working: number, middle: number, upper: number}} baseWageByClass `classes.json`'s `baseWagePerMonth`, keyed by class id.
 * @param {object} jobsRules `economy.json`'s `jobs` block.
 * @returns {{working: number, middle: number, upper: number}}
 */
export function computeServiceJobsOffered(classPop, baseWageByClass, jobsRules) {
  const totalPop = classPop.working + classPop.middle + classPop.upper
  if (totalPop <= 0) return { working: 0, middle: 0, upper: 0 }

  const weightedWage = (classPop.working * baseWageByClass.working + classPop.middle * baseWageByClass.middle + classPop.upper * baseWageByClass.upper) / totalPop
  const total = jobsRules.serviceJobsPerThousandPopPerWageUnit * (totalPop / 1000) * weightedWage

  const workingMiddlePop = classPop.working + classPop.middle
  if (workingMiddlePop <= 0) return { working: 0, middle: 0, upper: 0 }

  return {
    working: total * (classPop.working / workingMiddlePop),
    middle: total * (classPop.middle / workingMiddlePop),
    upper: 0,
  }
}

/**
 * Construction-sector positions (DESIGN 7.7: "construction offers jobs
 * per home built"). Treated as Working class only, construction being
 * manual trade labour, unlike the service sector's broader
 * working-and-middle split.
 *
 * @param {number} homesBuilt This month's `computeHousingConstruction()` result (`homesBuilt`).
 * @param {object} jobsRules `economy.json`'s `jobs` block.
 * @returns {{working: number, middle: number, upper: number}}
 */
export function computeConstructionJobsOffered(homesBuilt, jobsRules) {
  return { working: homesBuilt * jobsRules.constructionJobsPerHomeUnit, middle: 0, upper: 0 }
}

/**
 * @typedef {object} NeighbourLabourPool
 * @property {number} settlementId
 * @property {{working: number, middle: number, upper: number}} unemployed That neighbour's own surplus unemployed, available to lend.
 */

/**
 * @typedef {object} LabourAllocationResult
 * @property {{working: number, middle: number, upper: number}} employed Positions actually filled.
 * @property {{working: number, middle: number, upper: number}} vacancies Positions still unfilled after exhausting every neighbour.
 */

/**
 * Allocates available unemployed workers to a settlement's offered
 * jobs (DESIGN 7.7: "industries draw from their `homeSettlementId`
 * first, then the nearest neighbour settlement by road if short").
 * Aggregated at the settlement level across every job source (rather
 * than one allocation per individual industry) — DESIGN gives no rule
 * for which of several competing local industries would win priority
 * over another, so nothing is lost by resolving the settlement's total
 * labour shortfall as one pool against the same ordered neighbour list
 * every local employer would draw from anyway; see DECISIONS.md.
 *
 * @param {{working: number, middle: number, upper: number}} jobsOffered Total positions offered at this settlement, every source combined.
 * @param {{working: number, middle: number, upper: number}} ownUnemployed This settlement's own unemployed, by class.
 * @param {NeighbourLabourPool[]} neighbours Road-linked neighbours, nearest first (caller's ordering).
 * @returns {LabourAllocationResult}
 */
export function allocateLabour(jobsOffered, ownUnemployed, neighbours) {
  const employed = { working: 0, middle: 0, upper: 0 }
  const vacancies = { working: 0, middle: 0, upper: 0 }

  for (const classId of ['working', 'middle', 'upper']) {
    const fromOwn = Math.min(jobsOffered[classId], ownUnemployed[classId] || 0)
    employed[classId] = fromOwn
    let remaining = jobsOffered[classId] - fromOwn

    for (const neighbour of neighbours) {
      if (remaining <= 0) break
      const available = neighbour.unemployed[classId] || 0
      const drawn = Math.min(remaining, available)
      employed[classId] += drawn
      remaining -= drawn
    }

    vacancies[classId] = remaining
  }

  return { employed, vacancies }
}

/**
 * DESIGN 7.7: `employmentRate(s,c) = employed(s,c) / labourForce(s,c)`.
 *
 * @param {number} employed
 * @param {number} labourForce
 * @returns {number} 0 when `labourForce` is 0 (no one to be unemployed).
 */
export function computeEmploymentRate(employed, labourForce) {
  if (labourForce <= 0) return 0
  return employed / labourForce
}

/**
 * DESIGN 7.7: `jobAvailability(s,c) = clamp(vacancies(s,c) /
 * labourForce(s,c) * 5, 0, 1)`.
 *
 * @param {number} vacancies
 * @param {number} labourForce
 * @returns {number} In [0, 1]; 0 when `labourForce` is 0.
 */
export function computeJobAvailability(vacancies, labourForce) {
  if (labourForce <= 0) return 0
  const raw = (vacancies / labourForce) * 5
  if (raw < 0) return 0
  if (raw > 1) return 1
  return raw
}
