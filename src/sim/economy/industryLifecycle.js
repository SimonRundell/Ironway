/**
 * Industry lifecycle (DESIGN 7.8): opening, expansion, contraction,
 * closure, deposit depletion and era retirement. Every function is
 * pure; geography (site search, "a producer of inputs within 40
 * miles") is deliberately not this module's job — `siteAvailable` and
 * `inputsPlausible` are plain caller-supplied booleans, the caller
 * expected to derive them by reusing `sim/mapgen/industries.js`'s own
 * `evaluateSiteRule()`/`buildSitingContext()` against the live world
 * grid, exactly as world generation already does; see DECISIONS.md.
 *
 * `Industry.monthsLow` (DESIGN 7.1's schema, `sim/state.js`) is reused
 * here as a single "consecutive months in the current notable
 * utilisation regime" counter for all three of DESIGN's streak rules
 * (expansion, contraction, closure) rather than adding new persisted
 * fields — see DECISIONS.md for why this is safe and what the one
 * accepted edge case is.
 *
 * @module sim/economy/industryLifecycle
 */

/**
 * Returns a copy of an industry definition with every job count, input
 * quantity and output quantity scaled by `capacityMultiplier` — what
 * `computeIndustryUtilisation()`, `computeIndustryJobsOffered()` and
 * `computeIndustryDemand()` (T1.16/T1.20) should actually be called
 * with for an industry that has expanded or contracted.
 * `storageMonths` is a time constant, not a capacity, so it is left
 * unchanged (the absolute output cap still scales correctly, since it
 * is `storageMonths * outputQty` and `outputQty` is already scaled).
 *
 * @param {object} industryDef The base `industries.json` definition.
 * @param {number} capacityMultiplier 1.0 for an un-expanded, un-contracted industry.
 * @returns {object} A same-shaped definition, scaled.
 */
export function scaleIndustryDef(industryDef, capacityMultiplier) {
  return {
    ...industryDef,
    jobs: {
      working: (industryDef.jobs.working || 0) * capacityMultiplier,
      middle: (industryDef.jobs.middle || 0) * capacityMultiplier,
      upper: (industryDef.jobs.upper || 0) * capacityMultiplier,
    },
    inputs: industryDef.inputs.map((slot) => (
      slot.any
        ? { any: Object.fromEntries(Object.entries(slot.any).map(([cargo, qty]) => [cargo, qty * capacityMultiplier])) }
        : { cargo: slot.cargo, qty: slot.qty * capacityMultiplier }
    )),
    outputs: Object.fromEntries(Object.entries(industryDef.outputs).map(([cargo, qty]) => [cargo, qty * capacityMultiplier])),
  }
}

/**
 * Updates the "island-wide mean priceMult has stayed above
 * openThreshold" streak (DESIGN 7.8) for one cargo.
 *
 * @param {number} monthsAboveThreshold The streak coming into this month.
 * @param {number} meanPriceMult This cargo's island-wide mean price multiplier this month.
 * @param {object} lifecycleRules `economy.json`'s `industryLifecycle` block.
 * @returns {number} The updated streak (0 if the mean dropped back at or below the threshold).
 */
export function updateOpeningStreak(monthsAboveThreshold, meanPriceMult, lifecycleRules) {
  return meanPriceMult > lifecycleRules.openThreshold ? monthsAboveThreshold + 1 : 0
}

/**
 * Computes the probability an NPC investor opens a new industry this
 * month (DESIGN 7.8): zero unless the price signal has been sustained
 * long enough, a suitable site exists, the inputs are plausible and
 * the era allows it; otherwise scaled by Upper class confidence and
 * the economy level. The actual yes/no draw is the caller's
 * responsibility, using a seeded `rngFor()` draw against this
 * probability (DESIGN 4.5: no `Math.random` in simulation maths) —
 * this function only ever returns the number to draw against.
 *
 * @param {object} signal
 * @param {number} signal.monthsAboveThreshold From `updateOpeningStreak()`.
 * @param {boolean} signal.siteAvailable Whether a valid site exists (DESIGN 5.6) — caller-supplied.
 * @param {boolean} signal.inputsPlausible Whether a producer of every input sits within `openInputSearchRadiusMiles`, or the input is importable — caller-supplied.
 * @param {boolean} signal.eraAllows Whether the candidate industry's `eraFrom` has arrived (and it hasn't passed `eraTo`).
 * @param {number} signal.upperConfidence Island-wide (or local) Upper class confidence, 0-100.
 * @param {number} signal.economyLevel The current economy level index, 0-4.
 * @param {object} lifecycleRules `economy.json`'s `industryLifecycle` block.
 * @returns {number} A probability in [0, 1].
 */
export function computeOpeningProbability(signal, lifecycleRules) {
  if (signal.monthsAboveThreshold < lifecycleRules.openRequiredMonths) return 0
  if (!signal.siteAvailable || !signal.inputsPlausible || !signal.eraAllows) return 0

  const confidenceFactor = Math.max(0, Math.min(1, signal.upperConfidence / 100))
  const economyLevelFactor = (signal.economyLevel + 1) / 5 // Levels run 0 (Depression) to 4 (Boom).

  return lifecycleRules.openBaseProbability * confidenceFactor * economyLevelFactor
}

/**
 * Depletes a resource-sited industry's remaining deposit richness
 * (DESIGN 7.8: "richness falls with cumulative extraction"), in
 * proportion to this month's utilisation: an industry run flat out
 * every month exhausts its deposit after exactly
 * `depositLifetimeMonthsAtFullOutput` months; run at half utilisation,
 * it takes twice as long. Not meaningful for non-resource-sited
 * industries — the caller simply never calls this for those (their
 * `richnessLeft` stays at 1 for life, per `sim/state.js`'s own
 * doc comment).
 *
 * @param {number} richnessLeft Remaining richness, 0-1.
 * @param {number} utilisation This month's realized utilisation.
 * @param {object} lifecycleRules `economy.json`'s `industryLifecycle` block.
 * @returns {number} The next richness, floored at 0.
 */
export function computeRichnessDepletion(richnessLeft, utilisation, lifecycleRules) {
  const depleted = richnessLeft - utilisation / lifecycleRules.depositLifetimeMonthsAtFullOutput
  return depleted < 0 ? 0 : depleted
}

/**
 * Finds an industry's successor, if DESIGN 7.8's era retirement should
 * replace it with one (a `successorId` is set, and the successor's own
 * `eraFrom` has arrived).
 *
 * @param {object} industryDef The retiring industry's definition.
 * @param {number} year The calendar year.
 * @param {Map<string, object>} industriesById Every `industries.json` definition, keyed by id.
 * @returns {object|null} The successor's definition, or null if none applies yet.
 */
export function getEligibleSuccessor(industryDef, year, industriesById) {
  if (!industryDef.successorId) return null
  const successor = industriesById.get(industryDef.successorId)
  if (!successor || year < successor.eraFrom) return null
  return successor
}

/**
 * @typedef {object} LifecycleEvent
 * @property {string} kind One of `industry_expanded`, `industry_contracted`, `industry_closed`.
 * @property {string} reason A short, human-readable explanation (for the event log's `text`).
 */

/**
 * @typedef {object} LifecycleResult
 * @property {number} monthsLow The updated streak, to persist and pass into next month's call.
 * @property {number} capacityMultiplier The updated capacity multiplier (feed into `scaleIndustryDef()` from next month on).
 * @property {boolean} closed Whether the industry closes this month.
 * @property {LifecycleEvent|null} event Set whenever something notable happened this month.
 */

/**
 * Evaluates one industry's lifecycle transition for one month (DESIGN
 * 7.8): expansion, contraction, closure (demand-driven, era-retirement-
 * driven, or deposit-depletion-driven). Deposit depletion closes
 * immediately and unconditionally, taking priority over every other
 * rule. Contraction (halving) and closure use *sequential*, not
 * concurrent, streak windows: 12 months below `contractionUtilisationThreshold`
 * halves capacity and resets the streak, then a fresh
 * `closureRequiredMonths` below the *stricter*
 * `closureUtilisationThreshold` closes it — DESIGN's own wording
 * doesn't settle whether these two clocks run together or one after
 * the other; see DECISIONS.md for why sequential was chosen.
 *
 * @param {object} state
 * @param {number} state.utilisation This month's realized utilisation (ignored once past era retirement).
 * @param {number} state.monthsLow The streak coming into this month.
 * @param {number} state.capacityMultiplier The current capacity multiplier.
 * @param {number} state.richnessLeft Remaining deposit richness (1 for non-depleting industries).
 * @param {number} state.year The calendar year.
 * @param {number} state.priceMult This cargo's current local (or island-wide) price multiplier, for expansion's "unmet price signal".
 * @param {object} state.industryDef The industry's `industries.json` definition (for `eraTo`).
 * @param {object} lifecycleRules `economy.json`'s `industryLifecycle` block.
 * @returns {LifecycleResult}
 */
export function evaluateIndustryLifecycle(state, lifecycleRules) {
  const { utilisation, monthsLow, capacityMultiplier, richnessLeft, year, priceMult, industryDef } = state

  if (richnessLeft <= 0) {
    return { monthsLow, capacityMultiplier, closed: true, event: { kind: 'industry_closed', reason: 'deposit depleted' } }
  }

  const pastEra = industryDef.eraTo !== null && year > industryDef.eraTo
  const alreadyContracted = capacityMultiplier < 1.0
  const lowThreshold = alreadyContracted ? lifecycleRules.closureUtilisationThreshold : lifecycleRules.contractionUtilisationThreshold

  const isHigh = !pastEra && utilisation >= lifecycleRules.expansionUtilisationThreshold
  const isLow = pastEra || utilisation < lowThreshold

  if (isHigh) {
    const nextStreak = monthsLow + 1
    const unmetSignal = priceMult > lifecycleRules.unmetPriceSignalThreshold
    const hasRoomToExpand = capacityMultiplier < lifecycleRules.maxCapacityMultiplier

    if (nextStreak >= lifecycleRules.expansionRequiredMonths && unmetSignal && hasRoomToExpand) {
      const nextCapacity = Math.min(lifecycleRules.maxCapacityMultiplier, capacityMultiplier * (1 + lifecycleRules.expansionCapacityGain))
      return { monthsLow: 0, capacityMultiplier: nextCapacity, closed: false, event: { kind: 'industry_expanded', reason: 'sustained high utilisation with unmet demand' } }
    }
    return { monthsLow: nextStreak, capacityMultiplier, closed: false, event: null }
  }

  if (isLow) {
    const nextStreak = monthsLow + 1

    if (!alreadyContracted && nextStreak >= lifecycleRules.contractionRequiredMonths) {
      return { monthsLow: 0, capacityMultiplier: capacityMultiplier * lifecycleRules.contractionCapacityFactor, closed: false, event: { kind: 'industry_contracted', reason: pastEra ? 'past its era' : 'sustained low utilisation' } }
    }
    if (alreadyContracted && nextStreak >= lifecycleRules.closureRequiredMonths) {
      return { monthsLow: nextStreak, capacityMultiplier, closed: true, event: { kind: 'industry_closed', reason: pastEra ? 'past its era' : 'sustained low utilisation after contraction' } }
    }
    return { monthsLow: nextStreak, capacityMultiplier, closed: false, event: null }
  }

  return { monthsLow: 0, capacityMultiplier, closed: false, event: null }
}
