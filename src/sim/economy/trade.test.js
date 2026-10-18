import { describe, expect, it } from 'vitest'
import { computeExport, computeImport, computeTradeBalance, evaluatePortTierGrowth } from './trade.js'

const CARGO_CATALOGUE = [
  { id: 'cotton', eraFrom: 1830, basePrice: 45, importable: true, exportable: false },
  { id: 'grain', eraFrom: 1830, basePrice: 8, importable: false, exportable: true },
  { id: 'machinery', eraFrom: 1830, basePrice: 120, importable: true, exportable: true },
  { id: 'cars', eraFrom: 1900, basePrice: 400, importable: false, exportable: true },
  { id: 'timber', eraFrom: 1830, basePrice: 6, importable: true, exportable: false },
]

const WORLD_TRADE_RULES = {
  cotton: { importCapPerPortTierPerMonth: [100, 300, 800, 2000], worldPriceFactor: 1.0 },
  grain: { exportCapPerPortTierPerMonth: [500, 1500, 4000, 10000], worldPriceFactor: 1.0 },
  machinery: { importCapPerPortTierPerMonth: [20, 60, 160, 400], exportCapPerPortTierPerMonth: [20, 60, 160, 400], worldPriceFactor: 1.0 },
  cars: { exportCapPerPortTierPerMonth: [20, 60, 160, 400], worldPriceFactor: 1.0 },
  timber: { importCapPerPortTierPerMonth: [200, 600, 1600, 4000], worldPriceFactor: 1.0 },
}

describe('computeImport', () => {
  it('matches a hand-computed value for an importable cargo', () => {
    const result = computeImport('cotton', 2, 1830, CARGO_CATALOGUE, WORLD_TRADE_RULES)
    expect(result.quantity).toBe(800)
    expect(result.price).toBe(45)
    expect(result.value).toBe(36000)
  })

  it('imports the full cap regardless of any local demand (DESIGN: imports reach inland nodes only through flows)', () => {
    // computeImport takes no demand/stock argument at all -- its quantity depends only on the cap.
    const resultTier1 = computeImport('cotton', 1, 1830, CARGO_CATALOGUE, WORLD_TRADE_RULES)
    expect(resultTier1.quantity).toBe(300)
  })

  it('imports nothing for portTier 0 (not a port)', () => {
    expect(computeImport('cotton', 0, 1830, CARGO_CATALOGUE, WORLD_TRADE_RULES).quantity).toBe(0)
  })

  it('imports nothing for a non-importable cargo', () => {
    expect(computeImport('grain', 2, 1830, CARGO_CATALOGUE, WORLD_TRADE_RULES).quantity).toBe(0)
  })

  it('imports nothing before the cargo\'s era', () => {
    const result = computeImport('cotton', 2, 1700, CARGO_CATALOGUE, WORLD_TRADE_RULES)
    expect(result.quantity).toBe(0)
  })

  it('applies worldPriceFactor to the price', () => {
    const rules = { cotton: { ...WORLD_TRADE_RULES.cotton, worldPriceFactor: 1.2 } }
    const result = computeImport('cotton', 2, 1830, CARGO_CATALOGUE, rules)
    expect(result.price).toBeCloseTo(45 * 1.2)
  })
})

describe('computeExport', () => {
  it('matches a hand-computed value when stock exceeds the cap', () => {
    const result = computeExport('grain', 1, 1830, 2000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0)
    expect(result.quantity).toBe(1500) // Capped, not all 2000 available.
    expect(result.price).toBe(8)
    expect(result.value).toBe(12000)
  })

  it('exports stock removes it from the port (limited by availability, not just the cap)', () => {
    const result = computeExport('grain', 1, 1830, 500, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0)
    expect(result.quantity).toBe(500) // Less than the 1500 cap: availability binds instead.
  })

  it('exports nothing when there is no stock at all', () => {
    expect(computeExport('grain', 1, 1830, 0, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0).quantity).toBe(0)
  })

  it('exports nothing for portTier 0', () => {
    expect(computeExport('grain', 0, 1830, 2000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0).quantity).toBe(0)
  })

  it('exports nothing for a non-exportable cargo', () => {
    expect(computeExport('cotton', 2, 1830, 2000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0).quantity).toBe(0)
  })

  it('exports nothing before the cargo\'s era', () => {
    expect(computeExport('cars', 3, 1890, 2000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0).quantity).toBe(0)
  })

  it('exports something once the cargo\'s era arrives', () => {
    expect(computeExport('cars', 3, 1905, 2000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0).quantity).toBeGreaterThan(0)
  })

  it('applies the economy level revenue multiplier to the export price, unlike imports', () => {
    const normal = computeExport('grain', 1, 1830, 2000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0)
    const boom = computeExport('grain', 1, 1830, 2000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.2)
    expect(boom.price).toBeCloseTo(normal.price * 1.2)
  })

  it('a cargo that is both importable and exportable (machinery) works independently in each direction', () => {
    const imported = computeImport('machinery', 2, 1830, CARGO_CATALOGUE, WORLD_TRADE_RULES)
    const exported = computeExport('machinery', 2, 1830, 1000, CARGO_CATALOGUE, WORLD_TRADE_RULES, 1.0)
    expect(imported.quantity).toBe(160)
    expect(exported.quantity).toBe(160)
  })
})

describe('computeTradeBalance', () => {
  it('is export value minus import value', () => {
    const imports = [{ value: 36000 }, { value: 5000 }]
    const exports = [{ value: 12000 }]
    expect(computeTradeBalance(imports, exports)).toBe(12000 - 41000)
  })

  it('is zero with no trade at all', () => {
    expect(computeTradeBalance([], [])).toBe(0)
  })

  it('is positive for a trade surplus', () => {
    expect(computeTradeBalance([{ value: 1000 }], [{ value: 5000 }])).toBeGreaterThan(0)
  })
})

describe('evaluatePortTierGrowth', () => {
  const LINKS_RULES = { sea: { byPortTier: [{ portTier: 0, freightTonnesPerMonth: 800 }, { portTier: 1, freightTonnesPerMonth: 2500 }, { portTier: 2, freightTonnesPerMonth: 5000 }, { portTier: 3, freightTonnesPerMonth: 8000 }] } }
  const PORT_RULES = { tierGrowthThroughputThreshold: 0.9, tierGrowthSustainedMonths: 12 }
  const worldLink = { mode: 'sea', tier: 1 }

  it('increments the streak while throughput stays at or above the threshold', () => {
    const result = evaluatePortTierGrowth(5, 1, 2300, worldLink, LINKS_RULES, PORT_RULES) // 2300/2500 = 0.92.
    expect(result.monthsAboveThreshold).toBe(6)
    expect(result.nextTier).toBe(1)
  })

  it('resets the streak the moment throughput dips below the threshold', () => {
    const result = evaluatePortTierGrowth(11, 1, 2000, worldLink, LINKS_RULES, PORT_RULES) // 2000/2500 = 0.8.
    expect(result.monthsAboveThreshold).toBe(0)
    expect(result.nextTier).toBe(1)
  })

  it('raises the tier only once the streak reaches the sustained-months requirement, not before', () => {
    const notYet = evaluatePortTierGrowth(10, 1, 2300, worldLink, LINKS_RULES, PORT_RULES) // streak would become 11.
    expect(notYet.nextTier).toBe(1)

    const justEnough = evaluatePortTierGrowth(11, 1, 2300, worldLink, LINKS_RULES, PORT_RULES) // streak becomes 12.
    expect(justEnough.nextTier).toBe(2)
    expect(justEnough.monthsAboveThreshold).toBe(0) // Streak resets after a tier change.
  })

  it('never raises a tier-3 port further', () => {
    const result = evaluatePortTierGrowth(11, 3, 8000, { mode: 'sea', tier: 3 }, LINKS_RULES, PORT_RULES)
    expect(result.nextTier).toBe(3)
  })
})
