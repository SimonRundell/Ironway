/**
 * Housing (DESIGN 7.6): room (an attractiveness input), construction
 * (gated on bricks/planks/stone, one unit of each per unit of capacity
 * built — "no materials, no homes" is enforced by taking the
 * worst-supplied material, the same min-over-inputs pattern T1.16's
 * industry utilisation already uses) and shrinkage (slow abandonment
 * when a settlement is well under capacity).
 *
 * `housingCapacity` throughout is measured directly in population it
 * can hold (`sim/state.js`'s `Settlement.housing`), not a count of
 * discrete dwellings, so "homes built" below means "capacity units
 * added", not literal buildings.
 *
 * @module sim/economy/housing
 */

/** @type {readonly string[]} The three construction materials DESIGN 7.6 names. */
const CONSTRUCTION_MATERIALS = Object.freeze(['bricks', 'planks', 'stone'])

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
 * Computes a settlement's housing room (DESIGN 7.6's attractiveness
 * input): how much spare capacity it has relative to its population,
 * 0 (full or over capacity) to 1 (empty).
 *
 * @param {number} population Total population (every class combined).
 * @param {number} housingCapacity The settlement's `housing` capacity.
 * @returns {number} Housing room, in [0, 1].
 */
export function computeHousingRoom(population, housingCapacity) {
  if (housingCapacity <= 0) return 0
  return clamp01(1 - population / housingCapacity)
}

/**
 * @typedef {object} HousingConstructionResult
 * @property {number} homesBuilt Capacity units added this month (0 if no construction was requested, or no materials).
 * @property {Record<'bricks'|'planks'|'stone', number>} materialsConsumed Tonnes of each material drawn down.
 */

/**
 * Computes this month's housing construction (DESIGN 7.6): once
 * population exceeds `housingRequestThreshold` of capacity, the
 * settlement requests enough construction to close that specific
 * shortfall (the gap above the threshold, not above full capacity —
 * see DECISIONS.md), capped by whichever of bricks, planks or stone is
 * least available. A completely missing material (zero stock) stalls
 * construction entirely, matching DESIGN's "no materials, no homes".
 *
 * @param {number} population Total population.
 * @param {number} housingCapacity The settlement's current `housing` capacity.
 * @param {Record<'bricks'|'planks'|'stone', number>} materialsStock Current stock of each material.
 * @param {object} popRules `economy.json`'s `population` block.
 * @returns {HousingConstructionResult}
 */
export function computeHousingConstruction(population, housingCapacity, materialsStock, popRules) {
  const requestThreshold = housingCapacity * popRules.housingRequestThreshold
  const shortfall = Math.max(0, population - requestThreshold)

  if (shortfall <= 0) {
    return { homesBuilt: 0, materialsConsumed: { bricks: 0, planks: 0, stone: 0 } }
  }

  const materialsPerHome = popRules.materialsPerHomeUnit
  const homesAffordable = Math.min(
    ...CONSTRUCTION_MATERIALS.map((material) => (materialsStock[material] || 0) / materialsPerHome),
  )

  const homesBuilt = Math.min(shortfall, homesAffordable)
  const materialsConsumed = {}
  for (const material of CONSTRUCTION_MATERIALS) {
    materialsConsumed[material] = homesBuilt * materialsPerHome
  }

  return { homesBuilt, materialsConsumed }
}

/**
 * Applies housing shrinkage (DESIGN 7.6): capacity decays slowly when
 * a settlement sits well under capacity (abandonment).
 *
 * @param {number} population Total population.
 * @param {number} housingCapacity The settlement's current `housing` capacity.
 * @param {object} popRules `economy.json`'s `population` block.
 * @returns {number} The next month's housing capacity.
 */
export function applyHousingShrinkage(population, housingCapacity, popRules) {
  if (housingCapacity <= 0) return housingCapacity
  const occupancy = population / housingCapacity
  if (occupancy >= popRules.housingAbandonmentThreshold) return housingCapacity
  return housingCapacity * (1 - popRules.housingShrinkageRatePerMonth)
}
