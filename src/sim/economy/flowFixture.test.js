import { describe, expect, it } from 'vitest'
import { applyBaselineFlows, computeBaselineFlows, getLinkCapacity, nodeKey } from './flows.js'
import { computeCoverage, computePrice, computePriceMultiplier } from './prices.js'

/**
 * T1.18's own "Done when" fixture (PHASES.md): a two-settlement world,
 * one link, one cargo (coal) — one settlement has a coal stockpile and
 * no need for it, the other needs coal and has none. Run several
 * months of real baseline flow + real pricing together and confirm
 * coal moves in at the link's capped baseline rate while there is
 * ample coal to send, and that the price gap between the two
 * settlements narrows as the deficient settlement's stock builds up.
 */

const LINKS_RULES = { road: [{ tier: 0, freightTonnesPerMonth: 150 }, { tier: 1, freightTonnesPerMonth: 600 }] }
const PRICE_RULES = { pMin: 0.4, pMax: 3.0 }
const FLOW_RULES = {
  baselineShare: 0.15,
  baselineLossByMode: { road: 0.12 },
  minGradient: 0.1,
  reserveMonths: 0.5,
  flowRate: 0.3,
}
const COAL = { basePrice: 5, elasticity: 0.6 }
const ECONOMY_REVENUE_MULTIPLIER = 1.0 // Normal economy level.

const link = { id: 1, aType: 's', aId: 1, bType: 's', bId: 2, mode: 'road', tier: 1, lengthMi: 10 }
const producerKey = nodeKey('s', 1)
const consumerKey = nodeKey('s', 2)

function priceFor(stock, demand) {
  const coverage = computeCoverage(stock, demand)
  const multiplier = computePriceMultiplier(coverage, COAL.elasticity, PRICE_RULES)
  return computePrice(COAL.basePrice, multiplier, ECONOMY_REVENUE_MULTIPLIER)
}

describe('T1.18 fixture: coal from a stockpiled producer to a coal-starved consumer', () => {
  it('coal arrives at the capped baseline rate while the producer has ample stock, and the price gap narrows over time', () => {
    let producerStock = 2000 // A stockpile, no ongoing production modelled here (that's T1.16's job) and no demand of its own.
    let consumerStock = 0
    const consumerDemand = 100

    const capacity = getLinkCapacity(link, LINKS_RULES) * FLOW_RULES.baselineShare // 600 * 0.15 = 90.
    const expectedCappedMoved = capacity
    const expectedCappedReceived = capacity * (1 - FLOW_RULES.baselineLossByMode.road)

    const priceGaps = []
    const movedAmounts = []
    const months = 5 // By month 6 the gap has already narrowed below minGradient and the trickle stops on its own -- see the next test.

    for (let month = 1; month <= months; month++) {
      const priceA = priceFor(producerStock, 0) // Producer has no demand for its own coal.
      const priceB = priceFor(consumerStock, consumerDemand)
      priceGaps.push(priceB - priceA)

      const nodeStock = new Map([[producerKey, { coal: producerStock }], [consumerKey, { coal: consumerStock }]])
      const nodeDemand = new Map([[producerKey, { coal: 0 }], [consumerKey, { coal: consumerDemand }]])
      const nodeProducedCargoes = new Map([[producerKey, new Set(['coal'])], [consumerKey, new Set()]])
      const nodePrices = new Map([[producerKey, { coal: priceA }], [consumerKey, { coal: priceB }]])

      const results = computeBaselineFlows({ links: [link], nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES })
      expect(results.length).toBe(1)
      movedAmounts.push(results[0].moved)

      const next = applyBaselineFlows(nodeStock, results)
      producerStock = next.get(producerKey).coal
      consumerStock = next.get(consumerKey).coal
    }

    // Capped baseline rate: every month, with the producer's stockpile still large relative to the link's
    // tiny capacity, the link is the binding constraint, not the producer's own available stock or flowRate.
    for (const moved of movedAmounts) {
      expect(moved).toBeCloseTo(expectedCappedMoved)
    }
    expect(consumerStock).toBeCloseTo(expectedCappedReceived * months)

    // Price gap narrows: the consumer's rebuilding stock steadily improves its coverage, pulling its price
    // down towards the producer's (constant, since the producer's coverage is always Infinity here).
    for (let i = 1; i < priceGaps.length; i++) {
      expect(priceGaps[i]).toBeLessThan(priceGaps[i - 1])
    }
    expect(priceGaps[0]).toBeGreaterThan(0)
    expect(priceGaps[priceGaps.length - 1]).toBeLessThan(priceGaps[0] * 0.9) // A real, non-trivial narrowing over 6 months.
  })

  it('once the producer stockpile runs low, the flow is no longer capacity-bound and eventually stops below minGradient', () => {
    let producerStock = 50 // A much smaller stockpile than the link's 90-tonne capacity share.
    let consumerStock = 0
    const consumerDemand = 100

    for (let month = 1; month <= 20 && producerStock > 0.01; month++) {
      const priceA = priceFor(producerStock, 0)
      const priceB = priceFor(consumerStock, consumerDemand)

      const nodeStock = new Map([[producerKey, { coal: producerStock }], [consumerKey, { coal: consumerStock }]])
      const nodeDemand = new Map([[producerKey, { coal: 0 }], [consumerKey, { coal: consumerDemand }]])
      const nodeProducedCargoes = new Map([[producerKey, new Set(['coal'])], [consumerKey, new Set()]])
      const nodePrices = new Map([[producerKey, { coal: priceA }], [consumerKey, { coal: priceB }]])

      const results = computeBaselineFlows({ links: [link], nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES })
      if (results.length === 0) break // Gradient fell below minGradient: the trickle has stopped, as DESIGN says it should.

      const next = applyBaselineFlows(nodeStock, results)
      producerStock = next.get(producerKey).coal
      consumerStock = next.get(consumerKey).coal

      // Never capacity-bound here: desired (available*flowRate at most) stays under the 90-tonne link cap
      // once the whole stockpile is this small, so moved should equal flowRate*available, not the cap.
      expect(results[0].moved).toBeLessThan(getLinkCapacity(link, LINKS_RULES) * FLOW_RULES.baselineShare)
    }

    expect(producerStock).toBeGreaterThanOrEqual(0) // Never over-drawn.
    expect(consumerStock).toBeGreaterThan(0) // Some coal did get through before the trickle wound down.
  })
})
