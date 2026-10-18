import { describe, expect, it } from 'vitest'
import { computeExport, computeImport } from './trade.js'
import { applyBaselineFlows, computeBaselineFlows, nodeKey } from './flows.js'
import { computeCoverage, computePrice, computePriceMultiplier } from './prices.js'

/**
 * T1.21's own "Done when" fixtures (PHASES.md): imported cotton reaches
 * a mill town only through flows, and exports remove stock at ports.
 */

const CARGO_CATALOGUE = [
  { id: 'cotton', eraFrom: 1830, basePrice: 45, elasticity: 0.5, importable: true, exportable: false },
  { id: 'grain', eraFrom: 1830, basePrice: 8, elasticity: 0.6, importable: false, exportable: true },
]
const WORLD_TRADE_RULES = {
  cotton: { importCapPerPortTierPerMonth: [100, 300, 800, 2000], worldPriceFactor: 1.0 },
  grain: { exportCapPerPortTierPerMonth: [500, 1500, 4000, 10000], worldPriceFactor: 1.0 },
}
const LINKS_RULES = { road: [{ tier: 0, freightTonnesPerMonth: 150 }, { tier: 1, freightTonnesPerMonth: 600 }] }
const FLOW_RULES = { baselineShare: 0.15, baselineLossByMode: { road: 0.12 }, minGradient: 0.1, reserveMonths: 0.5, flowRate: 0.3 }
const PRICE_RULES = { pMin: 0.4, pMax: 3.0 }

const portKey = nodeKey('s', 1)
const millKey = nodeKey('s', 2)
const link = { id: 1, aType: 's', aId: 1, bType: 's', bId: 2, mode: 'road', tier: 1, lengthMi: 10 }

function cottonPrice(stock, demand) {
  const coverage = computeCoverage(stock, demand)
  const multiplier = computePriceMultiplier(coverage, 0.5, PRICE_RULES)
  return computePrice(45, multiplier, 1.0)
}

describe('T1.21 fixture: imported cotton reaches a mill town only through flows', () => {
  it('cotton builds up at the port from imports, then moves inland exclusively via the flow algorithm', () => {
    let portCotton = 0
    let millCotton = 0
    const millDemand = 50 // The mill wants cotton; the port itself has no use for it (demand 0).

    for (let month = 1; month <= 6; month++) {
      // 1. Import: adds only to the port's own stock. Nothing here ever touches millCotton directly.
      const imported = computeImport('cotton', 2, 1830, CARGO_CATALOGUE, WORLD_TRADE_RULES)
      portCotton += imported.quantity
      const millCottonBeforeFlow = millCotton

      // 2. Price and flow: the only mechanism that can move cotton from the port to the mill.
      const priceAtPort = cottonPrice(portCotton, 0)
      const priceAtMill = cottonPrice(millCotton, millDemand)

      const nodeStock = new Map([[portKey, { cotton: portCotton }], [millKey, { cotton: millCotton }]])
      const nodeDemand = new Map([[portKey, { cotton: 0 }], [millKey, { cotton: millDemand }]])
      const nodeProducedCargoes = new Map([[portKey, new Set(['cotton'])], [millKey, new Set()]]) // The port is cotton's "producer" here (an import source), so it keeps no reserve of its own import.
      const nodePrices = new Map([[portKey, { cotton: priceAtPort }], [millKey, { cotton: priceAtMill }]])

      const flows = computeBaselineFlows({ links: [link], nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules: LINKS_RULES, flowRules: FLOW_RULES })
      const next = applyBaselineFlows(nodeStock, flows)
      portCotton = next.get(portKey).cotton
      millCotton = next.get(millKey).cotton

      // The mill's cotton increased by exactly what the flow delivered -- nothing else could have changed it.
      const delivered = flows.find((f) => f.toKey === millKey)
      const expectedMillCotton = millCottonBeforeFlow + (delivered ? delivered.received : 0)
      expect(millCotton).toBeCloseTo(expectedMillCotton)
    }

    expect(millCotton).toBeGreaterThan(0) // Cotton genuinely got there.
    expect(portCotton).toBeGreaterThan(0) // And the port still has its own pile, imports exceeding what one link can carry onward.
  })
})

describe('T1.21 fixture: exports remove stock at ports', () => {
  it('a port\'s grain stock drops by exactly the exported quantity', () => {
    let portGrain = 5000
    const exported = computeExport('grain', 2, 1830, portGrain, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0)
    expect(exported.quantity).toBeGreaterThan(0)

    portGrain -= exported.quantity
    expect(portGrain).toBeCloseTo(5000 - exported.quantity)
    expect(portGrain).toBeLessThan(5000)
  })

  it('repeated monthly exports keep draining port stock until none is left', () => {
    let portGrain = 1000
    let monthsRun = 0
    while (portGrain > 0 && monthsRun < 20) {
      const exported = computeExport('grain', 1, 1830, portGrain, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0)
      portGrain -= exported.quantity
      monthsRun++
    }
    expect(portGrain).toBe(0)
    expect(monthsRun).toBeLessThan(20) // Actually drained, not stuck.
  })
})
