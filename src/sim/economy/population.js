import { interpolateYearTable } from '../era.js'

/**
 * Population: births, deaths, attractiveness, migration and yearly
 * class drift (DESIGN 7.6). Every function is pure; nothing here reads
 * employment, wages or service-sector data directly (DESIGN 7.7, built
 * at T1.20 — which itself depends on this task) — attractiveness's
 * `jobAvailability`, `realWageIndex`, `needsCoverage` and
 * `serviceIndex` inputs, and class drift's `jobImpliedShares`, are all
 * plain caller-supplied numbers, the same pattern T1.16 already used
 * for `workersAvailable`.
 *
 * "Rural drift" (DESIGN 7.6: unemployed rural Working class migrating
 * toward higher attractiveness as farm labour need falls) is not a
 * separate function here — it is what `computeMigrationFromSettlement()`
 * already produces once a future caller's `jobAvailability` reflects
 * reduced farm-labour demand; see DECISIONS.md.
 *
 * @module sim/economy/population
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
 * DESIGN 7.6: "foodFactor drops below 1 when food coverage is under
 * 0.8 ... floor 0.5". Linear between the floor (at zero coverage) and
 * 1 (at the threshold).
 *
 * @param {number} foodCoverage A settlement's food coverage (stock / demand).
 * @param {object} popRules `economy.json`'s `population` block.
 * @returns {number} The birth-rate food factor, in `[birthRateFoodFactorFloor, 1]`.
 */
export function computeFoodFactor(foodCoverage, popRules) {
  const threshold = popRules.foodCoverageThreshold
  const floor = popRules.birthRateFoodFactorFloor
  if (foodCoverage >= threshold) return 1
  return floor + (1 - floor) * clamp01(foodCoverage / threshold)
}

/**
 * DESIGN 7.6: "housingFactor drops when population exceeds housing
 * capacity ... floor 0.5". Linear from 1 at exactly full capacity down
 * to the floor at `overcrowdingDeathThreshold` occupancy (110% by
 * default) — the same occupancy band DESIGN uses for the death-side
 * overcrowding penalty, reused here rather than inventing a second,
 * unrelated threshold (see DECISIONS.md).
 *
 * @param {number} occupancy `population / housingCapacity`.
 * @param {object} popRules `economy.json`'s `population` block.
 * @returns {number} The birth-rate housing factor, in `[birthRateHousingFactorFloor, 1]`.
 */
export function computeHousingFactor(occupancy, popRules) {
  if (occupancy <= 1) return 1
  const floor = popRules.birthRateHousingFactorFloor
  const span = popRules.overcrowdingDeathThreshold - 1
  const t = span <= 0 ? 1 : clamp01((occupancy - 1) / span)
  return 1 - (1 - floor) * t
}

/**
 * The death-rate "shortagePenalty" DESIGN 7.6 names but doesn't define
 * numerically: the same food shortfall that reduces `foodFactor` below
 * 1 adds an equal death-rate penalty, plus an additional penalty
 * proportional to how far population sits above
 * `overcrowdingDeathThreshold` (DESIGN's explicit "population above
 * 110 percent of capacity also raises deaths"). Both components are 0
 * in a healthy settlement.
 *
 * @param {number} foodFactor From `computeFoodFactor()`.
 * @param {number} occupancy `population / housingCapacity`.
 * @param {object} popRules `economy.json`'s `population` block.
 * @returns {number} The shortage penalty (0 or more).
 */
export function computeShortagePenalty(foodFactor, occupancy, popRules) {
  const foodShortageComponent = 1 - foodFactor
  const overcrowdingComponent = Math.max(0, occupancy - popRules.overcrowdingDeathThreshold)
  return foodShortageComponent + overcrowdingComponent
}

/**
 * @typedef {object} BirthsAndDeaths
 * @property {number} births
 * @property {number} deaths
 */

/**
 * Computes one (settlement, class) row's births and deaths for one
 * month (DESIGN 7.6). The birth/death rate tables in `eras.json` are
 * not broken down by class — the same island-wide, year-dependent rate
 * applies to every class's population.
 *
 * @param {number} pop This class's population at this settlement.
 * @param {number} year The calendar year.
 * @param {number} foodCoverage The settlement's food coverage.
 * @param {number} occupancy `population / housingCapacity` (total population, not this class alone).
 * @param {object} erasRules The validated `eras.json` rules.
 * @param {object} popRules `economy.json`'s `population` block.
 * @returns {BirthsAndDeaths}
 */
export function computeBirthsAndDeaths(pop, year, foodCoverage, occupancy, erasRules, popRules) {
  const birthRatePerPersonPerYear = interpolateYearTable(erasRules.birthRatePer1000PerYear, year) / 1000
  const deathRatePerPersonPerYear = interpolateYearTable(erasRules.deathRatePer1000PerYear, year) / 1000

  const foodFactor = computeFoodFactor(foodCoverage, popRules)
  const housingFactor = computeHousingFactor(occupancy, popRules)
  const shortagePenalty = computeShortagePenalty(foodFactor, occupancy, popRules)

  const births = (pop * birthRatePerPersonPerYear / 12) * foodFactor * housingFactor
  const deaths = (pop * deathRatePerPersonPerYear / 12) * (1 + shortagePenalty)

  return { births, deaths }
}

/**
 * Computes a class's attractiveness at one settlement (DESIGN 7.6):
 * a weighted sum of five already-normalised (0-1) components.
 *
 * @param {object} inputs
 * @param {number} inputs.jobAvailability
 * @param {number} inputs.realWageIndex
 * @param {number} inputs.needsCoverage
 * @param {number} inputs.housingRoom From `sim/economy/housing.js`'s `computeHousingRoom()`.
 * @param {number} inputs.serviceIndex
 * @param {object} weights `economy.json`'s `attractivenessWeights` block.
 * @returns {number} Attractiveness, in [0, 1] when every input is in [0, 1].
 */
export function computeAttractiveness(inputs, weights) {
  return (
    weights.jobAvailability * inputs.jobAvailability
    + weights.realWageIndex * inputs.realWageIndex
    + weights.needsCoverage * inputs.needsCoverage
    + weights.housingRoom * inputs.housingRoom
    + weights.serviceIndex * inputs.serviceIndex
  )
}

/**
 * @typedef {object} MigrationCandidate
 * @property {number} toId The destination settlement id.
 * @property {number} toAttractiveness That settlement's attractiveness for this class.
 * @property {number} condition The road link's condition, 0-1 (DESIGN's unspecified `linkEase(s,t)` — taken directly as the link's own condition; see DECISIONS.md).
 * @property {number} distanceMiles The road link's length.
 */

/**
 * @typedef {object} MigrationResult
 * @property {number} toId
 * @property {number} moved
 */

/**
 * Computes one class's migration out of one settlement for one month
 * (DESIGN 7.6), along its direct road links only ("multi-hop migration
 * emerges over time" — a two-hop move is just two separate single-hop
 * moves across two successive months, not something this function
 * models directly). `decay(distance)` is DESIGN's other unspecified
 * term: a simple rational falloff (`1 / (1 + distance/scale)`), pure
 * division only, since `Math.exp` is off-limits in simulation maths
 * (DESIGN 4.5).
 *
 * If the combined desired outflow across every candidate destination
 * exceeds `migrationOutflowCapPerMonth` of this class's population,
 * every candidate is scaled down proportionally to fit the cap — the
 * same oversubscription-scaling pattern T1.18's flows already use.
 *
 * @param {number} fromPop This class's population at the source settlement.
 * @param {number} mobility This class's mobility rate (`economy.json`'s `population.mobility`).
 * @param {number} fromAttractiveness The source settlement's attractiveness for this class.
 * @param {MigrationCandidate[]} candidates Every settlement directly road-linked to the source.
 * @param {number} outflowCapPerMonth `economy.json`'s `migrationOutflowCapPerMonth`.
 * @param {number} distanceScaleMiles `economy.json`'s `migrationDistanceScaleMiles`.
 * @returns {MigrationResult[]}
 */
export function computeMigrationFromSettlement(fromPop, mobility, fromAttractiveness, candidates, outflowCapPerMonth, distanceScaleMiles) {
  const desired = candidates.map((candidate) => {
    const attractivenessGap = Math.max(0, candidate.toAttractiveness - fromAttractiveness)
    const linkEase = candidate.condition
    const decay = 1 / (1 + candidate.distanceMiles / distanceScaleMiles)
    return { toId: candidate.toId, moved: fromPop * mobility * attractivenessGap * linkEase * decay }
  })

  const totalDesired = desired.reduce((sum, d) => sum + d.moved, 0)
  const cap = fromPop * outflowCapPerMonth
  if (totalDesired > cap && totalDesired > 0) {
    const ratio = cap / totalDesired
    for (const d of desired) d.moved *= ratio
  }

  return desired
}

/**
 * @typedef {object} ClassShares
 * @property {number} working
 * @property {number} middle
 * @property {number} upper
 */

/**
 * Applies one year's class drift (DESIGN 7.6): shares move
 * `classDriftTowardJobSharePerYear` of the way toward the shares
 * implied by local jobs, with a floor under the Upper share for
 * rentiers regardless of job mix. Raising Upper's target above its raw
 * job-implied share would otherwise break the shares-sum-to-1
 * invariant, so the three targets are renormalised after the floor is
 * applied, before interpolating.
 *
 * @param {ClassShares} currentShares This settlement's current class shares (sum to 1).
 * @param {ClassShares} jobImpliedShares The shares implied by local jobs (sum to 1).
 * @param {object} popRules `economy.json`'s `population` block.
 * @returns {ClassShares} The next year's shares (sum to 1).
 */
export function applyClassDrift(currentShares, jobImpliedShares, popRules) {
  const rawTarget = { ...jobImpliedShares, upper: Math.max(jobImpliedShares.upper, popRules.rentierUpperFloor) }
  const rawTotal = rawTarget.working + rawTarget.middle + rawTarget.upper
  const target = {
    working: rawTarget.working / rawTotal,
    middle: rawTarget.middle / rawTotal,
    upper: rawTarget.upper / rawTotal,
  }

  const rate = popRules.classDriftTowardJobSharePerYear
  return {
    working: currentShares.working + (target.working - currentShares.working) * rate,
    middle: currentShares.middle + (target.middle - currentShares.middle) * rate,
    upper: currentShares.upper + (target.upper - currentShares.upper) * rate,
  }
}
