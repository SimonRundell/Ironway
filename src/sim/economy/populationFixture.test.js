import { describe, expect, it } from 'vitest'
import { computeAttractiveness, computeBirthsAndDeaths, computeMigrationFromSettlement } from './population.js'
import { computeHousingRoom } from './housing.js'

/**
 * T1.19's own "Done when" fixtures (PHASES.md), each isolating one
 * named property directly rather than relying on the unit tests to
 * imply it.
 */

const POP_RULES = {
  birthRateFoodFactorFloor: 0.5,
  birthRateHousingFactorFloor: 0.5,
  foodCoverageThreshold: 0.8,
  overcrowdingDeathThreshold: 1.10,
  migrationOutflowCapPerMonth: 0.03,
  migrationDistanceScaleMiles: 20,
}

const ERAS_RULES = {
  birthRatePer1000PerYear: [{ year: 1830, value: 33 }],
  deathRatePer1000PerYear: [{ year: 1830, value: 22 }],
}

describe('T1.19 fixture: closed-system migration conserves people', () => {
  it('total population across a 3-settlement road chain is unchanged after 24 months of migration-only movement', () => {
    // A -- B -- C, attractiveness rising along the chain so migration flows A->B->C.
    const attractiveness = { A: 0.3, B: 0.6, C: 0.9 }
    let pop = { A: 1000, B: 500, C: 200 }
    const totalBefore = pop.A + pop.B + pop.C

    const linksFrom = {
      A: [{ toId: 'B', toAttractiveness: attractiveness.B, condition: 1, distanceMiles: 10 }],
      B: [
        { toId: 'A', toAttractiveness: attractiveness.A, condition: 1, distanceMiles: 10 },
        { toId: 'C', toAttractiveness: attractiveness.C, condition: 1, distanceMiles: 10 },
      ],
      C: [{ toId: 'B', toAttractiveness: attractiveness.B, condition: 1, distanceMiles: 10 }],
    }

    for (let month = 0; month < 24; month++) {
      const outflows = {}
      for (const from of ['A', 'B', 'C']) {
        outflows[from] = computeMigrationFromSettlement(pop[from], 0.02, attractiveness[from], linksFrom[from], POP_RULES.migrationOutflowCapPerMonth, POP_RULES.migrationDistanceScaleMiles)
      }

      const next = { ...pop }
      for (const from of ['A', 'B', 'C']) {
        for (const { toId, moved } of outflows[from]) {
          next[from] -= moved
          next[toId] += moved
        }
      }
      pop = next
    }

    const totalAfter = pop.A + pop.B + pop.C
    expect(totalAfter).toBeCloseTo(totalBefore, 9)
    // And migration is actually happening, not a no-op fixture.
    expect(pop.C).toBeGreaterThan(200)
    expect(pop.A).toBeLessThan(1000)
  })
})

describe('T1.19 fixture: a settlement with a food shortage declines', () => {
  it('nets more deaths than births under a severe, sustained food shortage', () => {
    const { births, deaths } = computeBirthsAndDeaths(1000, 1830, 0.1, 0.5, ERAS_RULES, POP_RULES) // Coverage 0.1, well under the 0.8 threshold.
    expect(deaths).toBeGreaterThan(births)
  })

  it('a settlement with ample food instead grows (births exceed deaths)', () => {
    const { births, deaths } = computeBirthsAndDeaths(1000, 1830, 1.5, 0.5, ERAS_RULES, POP_RULES)
    expect(births).toBeGreaterThan(deaths)
  })
})

describe('T1.19 fixture: a settlement with vacancies and housing attracts migrants', () => {
  it('migration flows toward the settlement with more housing room, all else equal', () => {
    const weights = { jobAvailability: 0.35, realWageIndex: 0.20, needsCoverage: 0.20, housingRoom: 0.15, serviceIndex: 0.10 }
    const sharedInputs = { jobAvailability: 0.5, realWageIndex: 0.5, needsCoverage: 0.5, serviceIndex: 0.5 }

    const crowdedRoom = computeHousingRoom(980, 1000) // 98% full: almost no vacancies.
    const spaciousRoom = computeHousingRoom(400, 1000) // 40% full: plenty of vacancies.

    const crowdedAttractiveness = computeAttractiveness({ ...sharedInputs, housingRoom: crowdedRoom }, weights)
    const spaciousAttractiveness = computeAttractiveness({ ...sharedInputs, housingRoom: spaciousRoom }, weights)
    expect(spaciousAttractiveness).toBeGreaterThan(crowdedAttractiveness)

    // A third settlement deciding between the two as migration destinations.
    const fromPop = 1000
    const fromAttractiveness = Math.min(crowdedAttractiveness, spaciousAttractiveness) - 0.05 // Less attractive than either, so both pull migrants.
    const [toCrowded, toSpacious] = computeMigrationFromSettlement(
      fromPop, 0.02, fromAttractiveness,
      [
        { toId: 'crowded', toAttractiveness: crowdedAttractiveness, condition: 1, distanceMiles: 10 },
        { toId: 'spacious', toAttractiveness: spaciousAttractiveness, condition: 1, distanceMiles: 10 },
      ],
      POP_RULES.migrationOutflowCapPerMonth, POP_RULES.migrationDistanceScaleMiles,
    )

    expect(toSpacious.moved).toBeGreaterThan(toCrowded.moved)
  })
})
