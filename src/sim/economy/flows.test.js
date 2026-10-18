import { describe, expect, it } from 'vitest'
import { applyBaselineFlows, computeBaselineFlows, getLinkCapacity, nodeKey } from './flows.js'

const LINKS_RULES = {
  road: [
    { tier: 0, freightTonnesPerMonth: 150 },
    { tier: 1, freightTonnesPerMonth: 600 },
    { tier: 2, freightTonnesPerMonth: 1200 },
    { tier: 3, freightTonnesPerMonth: 3000 },
  ],
  rail: [
    { tier: 0, freightTonnesPerMonth: 1500 },
    { tier: 1, freightTonnesPerMonth: 6000 },
  ],
  sea: {
    byPortTier: [
      { portTier: 0, freightTonnesPerMonth: 800 },
      { portTier: 1, freightTonnesPerMonth: 2500 },
    ],
  },
}

const FLOW_RULES = {
  baselineShare: 0.15,
  baselineLossByMode: { road: 0.12, rail: 0.06, sea: 0.04 },
  minGradient: 0.1,
  reserveMonths: 0.5,
  flowRate: 0.3,
}

function roadLink(id, aId, bId, tier = 1) {
  return { id, aType: 's', aId, bType: 's', bId, mode: 'road', tier, lengthMi: 10 }
}

describe('getLinkCapacity', () => {
  it('looks up freight capacity by mode and tier', () => {
    expect(getLinkCapacity({ mode: 'road', tier: 1 }, LINKS_RULES)).toBe(600)
    expect(getLinkCapacity({ mode: 'rail', tier: 0 }, LINKS_RULES)).toBe(1500)
  })

  it('looks up sea capacity by port tier', () => {
    expect(getLinkCapacity({ mode: 'sea', tier: 1 }, LINKS_RULES)).toBe(2500)
  })
})

describe('computeBaselineFlows: single link, single cargo', () => {
  const link = roadLink(1, 1, 2) // capacity = 600 * 0.15 = 90.

  function fixture({ stockA = 1000, demandB = 100, priceA = 2, priceB = 5 } = {}) {
    return {
      links: [link],
      nodeStock: new Map([[nodeKey('s', 1), { coal: stockA }], [nodeKey('s', 2), { coal: 0 }]]),
      nodeDemand: new Map([[nodeKey('s', 1), { coal: 0 }], [nodeKey('s', 2), { coal: demandB }]]),
      nodeProducedCargoes: new Map([[nodeKey('s', 1), new Set(['coal'])], [nodeKey('s', 2), new Set()]]),
      nodePrices: new Map([[nodeKey('s', 1), { coal: priceA }], [nodeKey('s', 2), { coal: priceB }]]),
      linksRules: LINKS_RULES,
      flowRules: FLOW_RULES,
    }
  }

  it('moves coal from the cheaper (producer) node to the pricier (consumer) node', () => {
    const [result] = computeBaselineFlows(fixture())
    expect(result.fromKey).toBe('s:1')
    expect(result.toKey).toBe('s:2')
    expect(result.cargo).toBe('coal')
  })

  it('caps moved at the link\'s baseline capacity share when desired exceeds it', () => {
    // available=1000 (producer, reserve 0), gradient=(5-2)/2=1.5, desired=min(1000*0.3, 1000*1.5)=300, capacity=90.
    const [result] = computeBaselineFlows(fixture())
    expect(result.moved).toBeCloseTo(90)
    expect(result.received).toBeCloseTo(90 * (1 - 0.12))
  })

  it('does not generate a flow below minGradient', () => {
    const results = computeBaselineFlows(fixture({ priceA: 2, priceB: 2.1 })) // gradient = 0.05.
    expect(results).toEqual([])
  })

  it('generates a flow right at or above minGradient', () => {
    const results = computeBaselineFlows(fixture({ priceA: 2, priceB: 2.2 })) // gradient = 0.1 exactly.
    expect(results.length).toBe(1)
  })

  it('a non-producer node reserves reserveMonths worth of its own demand before anything is available to export', () => {
    // Node 1 is a non-producer here with its own coal demand: available = stock - demand*reserveMonths.
    const result = computeBaselineFlows({
      links: [link],
      nodeStock: new Map([[nodeKey('s', 1), { coal: 100 }], [nodeKey('s', 2), { coal: 0 }]]),
      nodeDemand: new Map([[nodeKey('s', 1), { coal: 40 }], [nodeKey('s', 2), { coal: 100 }]]),
      nodeProducedCargoes: new Map([[nodeKey('s', 1), new Set()], [nodeKey('s', 2), new Set()]]),
      nodePrices: new Map([[nodeKey('s', 1), { coal: 2 }], [nodeKey('s', 2), { coal: 5 }]]),
      linksRules: LINKS_RULES,
      flowRules: FLOW_RULES,
    })
    // available = 100 - 40*0.5 = 80. desired = min(80*0.3, 80*1.5) = 24 (well under the 90 capacity).
    expect(result[0].moved).toBeCloseTo(24)
  })

  it('a producer\'s own reserve is zero even if it somehow also "demands" the cargo it produces', () => {
    const result = computeBaselineFlows(fixture({ stockA: 100, demandB: 100 }))
    // available = 100 - 0 (producer) = 100. desired = min(100*0.3, 100*1.5) = 30.
    expect(result[0].moved).toBeCloseTo(30)
  })

  it('exports nothing when available stock is at or below the reserve', () => {
    const results = computeBaselineFlows({
      links: [link],
      nodeStock: new Map([[nodeKey('s', 1), { coal: 20 }], [nodeKey('s', 2), { coal: 0 }]]),
      nodeDemand: new Map([[nodeKey('s', 1), { coal: 100 }], [nodeKey('s', 2), { coal: 100 }]]), // reserve = 100*0.5 = 50 > stock 20.
      nodeProducedCargoes: new Map([[nodeKey('s', 1), new Set()], [nodeKey('s', 2), new Set()]]),
      nodePrices: new Map([[nodeKey('s', 1), { coal: 2 }], [nodeKey('s', 2), { coal: 5 }]]),
      linksRules: LINKS_RULES,
      flowRules: FLOW_RULES,
    })
    expect(results).toEqual([])
  })

  it('skips world/port links entirely (deferred to T1.21)', () => {
    const worldLink = { id: 2, aType: 's', aId: 1, bType: 'w', bId: 1, mode: 'sea', tier: 0, lengthMi: 5 }
    const results = computeBaselineFlows({ ...fixture(), links: [worldLink] })
    expect(results).toEqual([])
  })
})

describe('computeBaselineFlows: node oversubscription', () => {
  it('scales every outgoing candidate for the same (node, cargo) proportionally when their combined desire exceeds available stock', () => {
    // One producer (ample link capacity, so only node-oversubscription binds) exporting coal to 4 neighbours.
    const bigCapacityLinks = { road: [{ tier: 0, freightTonnesPerMonth: 1_000_000 }] }
    const links = [1, 2, 3, 4].map((toId) => ({ id: toId, aType: 's', aId: 1, bType: 's', bId: toId + 1, mode: 'road', tier: 0, lengthMi: 1 }))

    const nodeStock = new Map([[nodeKey('s', 1), { coal: 50 }]])
    const nodeDemand = new Map([[nodeKey('s', 1), { coal: 0 }]])
    const nodeProducedCargoes = new Map([[nodeKey('s', 1), new Set(['coal'])]])
    const nodePrices = new Map([[nodeKey('s', 1), { coal: 2 }]])
    for (const toId of [2, 3, 4, 5]) {
      nodeStock.set(nodeKey('s', toId), { coal: 0 })
      nodeDemand.set(nodeKey('s', toId), { coal: 0 })
      nodeProducedCargoes.set(nodeKey('s', toId), new Set())
      nodePrices.set(nodeKey('s', toId), { coal: 5 }) // Same gradient and price for every neighbour, by construction.
    }

    const results = computeBaselineFlows({ links, nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: bigCapacityLinks, flowRules: FLOW_RULES })

    // available = 50 (producer). Each link alone would desire min(50*0.3, 50*1.5) = 15; 4 links want 60 > 50.
    // Scaled: each gets 15 * (50/60) = 12.5, summing to exactly 50.
    expect(results.length).toBe(4)
    for (const result of results) expect(result.moved).toBeCloseTo(12.5)
    expect(results.reduce((sum, r) => sum + r.moved, 0)).toBeCloseTo(50)
  })
})

describe('computeBaselineFlows: link oversubscription', () => {
  it('allocates a link\'s shared capacity to the highest gradient*price candidate first, in full, before the next', () => {
    const link = roadLink(1, 1, 2) // capacity = 90.
    const nodeStock = new Map([[nodeKey('s', 1), { coal: 1000, iron: 1000 }], [nodeKey('s', 2), { coal: 0, iron: 0 }]])
    const nodeDemand = new Map([[nodeKey('s', 1), { coal: 0, iron: 0 }], [nodeKey('s', 2), { coal: 1000, iron: 1000 }]])
    const nodeProducedCargoes = new Map([[nodeKey('s', 1), new Set(['coal', 'iron'])], [nodeKey('s', 2), new Set()]])
    // Coal's gradient*priceFrom is larger than iron's, so coal should be served first and in full.
    const nodePrices = new Map([[nodeKey('s', 1), { coal: 10, iron: 2 }], [nodeKey('s', 2), { coal: 50, iron: 2.5 }]])

    const results = computeBaselineFlows({ links: [link], nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES })

    const coal = results.find((r) => r.cargo === 'coal')
    const iron = results.find((r) => r.cargo === 'iron')
    // coal: gradient=(50-10)/10=4, priority=40. iron: gradient=(2.5-2)/2=0.25, priority=0.5. Coal wins priority.
    // coal desired = min(1000*0.3, 1000*4) = 300, capped to the full 90 capacity (served first, in full).
    expect(coal.moved).toBeCloseTo(90)
    // iron gets nothing: capacity was exhausted by coal.
    expect(iron).toBeUndefined()
  })

  it('never exceeds a link\'s baseline capacity even when several cargoes compete for it', () => {
    const link = roadLink(1, 1, 2)
    const nodeStock = new Map([[nodeKey('s', 1), { a: 1000, b: 1000, c: 1000 }], [nodeKey('s', 2), { a: 0, b: 0, c: 0 }]])
    const nodeDemand = new Map([[nodeKey('s', 1), { a: 0, b: 0, c: 0 }], [nodeKey('s', 2), { a: 1000, b: 1000, c: 1000 }]])
    const nodeProducedCargoes = new Map([[nodeKey('s', 1), new Set(['a', 'b', 'c'])], [nodeKey('s', 2), new Set()]])
    const nodePrices = new Map([[nodeKey('s', 1), { a: 2, b: 2, c: 2 }], [nodeKey('s', 2), { a: 5, b: 6, c: 7 }]])

    const results = computeBaselineFlows({ links: [link], nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES })
    const capacity = getLinkCapacity(link, LINKS_RULES) * FLOW_RULES.baselineShare
    const totalMoved = results.reduce((sum, r) => sum + r.moved, 0)
    expect(totalMoved).toBeLessThanOrEqual(capacity + 1e-9)
  })
})

describe('computeBaselineFlows: order independence', () => {
  it('produces identical results regardless of the input links array order', () => {
    const links = [
      roadLink(1, 1, 2),
      roadLink(2, 1, 3),
      roadLink(3, 2, 3),
      roadLink(4, 3, 4),
    ]
    const nodeStock = new Map()
    const nodeDemand = new Map()
    const nodeProducedCargoes = new Map()
    const nodePrices = new Map()
    for (let id = 1; id <= 4; id++) {
      nodeStock.set(nodeKey('s', id), { coal: id === 1 ? 500 : 0, iron: id === 2 ? 500 : 0 })
      nodeDemand.set(nodeKey('s', id), { coal: 200, iron: 200 })
      nodeProducedCargoes.set(nodeKey('s', id), id === 1 ? new Set(['coal']) : id === 2 ? new Set(['iron']) : new Set())
      nodePrices.set(nodeKey('s', id), { coal: id === 1 ? 2 : 2 + id, iron: id === 2 ? 2 : 2 + id })
    }

    const base = { nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES }
    const resultsForward = computeBaselineFlows({ ...base, links })
    const resultsReversed = computeBaselineFlows({ ...base, links: [...links].reverse() })
    const resultsShuffled = computeBaselineFlows({ ...base, links: [links[2], links[0], links[3], links[1]] })

    const byKey = (results) => {
      const map = new Map()
      for (const r of results) map.set(`${r.linkId}|${r.cargo}`, r.moved)
      return map
    }

    expect(byKey(resultsReversed)).toEqual(byKey(resultsForward))
    expect(byKey(resultsShuffled)).toEqual(byKey(resultsForward))
    expect(resultsForward.length).toBeGreaterThan(0) // Sanity: the fixture actually produced flows worth comparing.
  })
})

describe('applyBaselineFlows: conservation', () => {
  it('source loses exactly `moved`, destination gains exactly `received`, and global stock changes by the total loss only', () => {
    const link = roadLink(1, 1, 2)
    const nodeStock = new Map([[nodeKey('s', 1), { coal: 1000 }], [nodeKey('s', 2), { coal: 0 }]])
    const nodeDemand = new Map([[nodeKey('s', 1), { coal: 0 }], [nodeKey('s', 2), { coal: 100 }]])
    const nodeProducedCargoes = new Map([[nodeKey('s', 1), new Set(['coal'])], [nodeKey('s', 2), new Set()]])
    const nodePrices = new Map([[nodeKey('s', 1), { coal: 2 }], [nodeKey('s', 2), { coal: 5 }]])

    const results = computeBaselineFlows({ links: [link], nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES })
    const next = applyBaselineFlows(nodeStock, results)

    const sourceLoss = nodeStock.get(nodeKey('s', 1)).coal - next.get(nodeKey('s', 1)).coal
    const destGain = next.get(nodeKey('s', 2)).coal - nodeStock.get(nodeKey('s', 2)).coal
    expect(sourceLoss).toBeCloseTo(results[0].moved)
    expect(destGain).toBeCloseTo(results[0].received)

    const totalBefore = nodeStock.get(nodeKey('s', 1)).coal + nodeStock.get(nodeKey('s', 2)).coal
    const totalAfter = next.get(nodeKey('s', 1)).coal + next.get(nodeKey('s', 2)).coal
    const expectedLoss = results[0].moved - results[0].received
    expect(totalBefore - totalAfter).toBeCloseTo(expectedLoss)
  })

  it('does not mutate the input stock map', () => {
    const link = roadLink(1, 1, 2)
    const nodeStock = new Map([[nodeKey('s', 1), { coal: 1000 }], [nodeKey('s', 2), { coal: 0 }]])
    const nodeDemand = new Map([[nodeKey('s', 1), { coal: 0 }], [nodeKey('s', 2), { coal: 100 }]])
    const nodeProducedCargoes = new Map([[nodeKey('s', 1), new Set(['coal'])], [nodeKey('s', 2), new Set()]])
    const nodePrices = new Map([[nodeKey('s', 1), { coal: 2 }], [nodeKey('s', 2), { coal: 5 }]])

    const results = computeBaselineFlows({ links: [link], nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES })
    applyBaselineFlows(nodeStock, results)

    expect(nodeStock.get(nodeKey('s', 1)).coal).toBe(1000)
    expect(nodeStock.get(nodeKey('s', 2)).coal).toBe(0)
  })
})
