import { describe, expect, it } from 'vitest'
import {
  blobRadiusMiles,
  buildingSlot,
  buildingSlotCount,
  classShares,
  dominantColour,
  dryRadiusFraction,
  featureOffsets,
  footprintOffsets,
  footprintStreets,
  isWaterAt,
  settlementFeatures,
  totalPopulation,
  updateBuildingLifecycle,
} from './settlements.js'

const CLASSES_RULES = [
  { id: 'working', name: 'Working' },
  { id: 'middle', name: 'Middle' },
  { id: 'upper', name: 'Upper' },
]
const CLASS_ORDER = CLASSES_RULES.map((c) => c.id)
const CLASS_COLOURS = { working: '#8a5a3c', middle: '#a8683f', upper: '#6b4a5c' }
const SETTLEMENT_RULES = {
  blobRadiusMilesPerSqrtPop: 0.012,
  minBlobRadiusMiles: 0.5,
  footprintPaddingFactor: 1.3,
  popPerBuildingSlot: 150,
  minBuildingSlots: 3,
  maxBuildingSlots: 70,
}

function makeSettlement(overrides = {}) {
  return {
    id: 7,
    name: 'Testford',
    kind: 'town',
    x: 10,
    y: 20,
    portTier: 0,
    housing: 10000,
    regionCells: 5,
    pop: { 0: { pop: 7000, employed: 6000, confidence: 0.6 }, 1: { pop: 2500, employed: 2000, confidence: 0.6 }, 2: { pop: 500, employed: 400, confidence: 0.6 } },
    stock: {},
    ...overrides,
  }
}

describe('totalPopulation', () => {
  it('sums every class', () => {
    expect(totalPopulation(makeSettlement())).toBe(10000)
  })

  it('returns 0 for an empty settlement', () => {
    expect(totalPopulation(makeSettlement({ pop: {} }))).toBe(0)
  })
})

describe('classShares', () => {
  it('divides each class population by the total', () => {
    const shares = classShares(makeSettlement(), CLASSES_RULES)
    expect(shares.working).toBeCloseTo(0.7)
    expect(shares.middle).toBeCloseTo(0.25)
    expect(shares.upper).toBeCloseTo(0.05)
  })

  it('returns all zeros rather than NaN for zero population', () => {
    const shares = classShares(makeSettlement({ pop: {} }), CLASSES_RULES)
    expect(shares).toEqual({ working: 0, middle: 0, upper: 0 })
  })
})

describe('dominantColour', () => {
  it('is pure working colour when working share is 1', () => {
    const colour = dominantColour({ working: 1, middle: 0, upper: 0 }, CLASS_COLOURS)
    expect(colour).toEqual({ r: 138, g: 90, b: 60 })
  })

  it('blends proportionally to shares', () => {
    const colour = dominantColour({ working: 0.5, middle: 0.5, upper: 0 }, CLASS_COLOURS)
    const working = { r: 138, g: 90, b: 60 }
    const middle = { r: 168, g: 104, b: 63 }
    expect(colour.r).toBeCloseTo((working.r + middle.r) / 2)
    expect(colour.g).toBeCloseTo((working.g + middle.g) / 2)
    expect(colour.b).toBeCloseTo((working.b + middle.b) / 2)
  })

  it('falls back to a colour rather than NaN when all shares are zero', () => {
    const colour = dominantColour({ working: 0, middle: 0, upper: 0 }, CLASS_COLOURS)
    expect(Number.isNaN(colour.r)).toBe(false)
  })
})

describe('blobRadiusMiles', () => {
  it('grows with the square root of population', () => {
    const small = blobRadiusMiles(2000, SETTLEMENT_RULES)
    const big = blobRadiusMiles(8000, SETTLEMENT_RULES)
    // 4x the population should be exactly 2x the radius once past the floor.
    expect(big / small).toBeCloseTo(2, 1)
  })

  it('never drops below the configured floor', () => {
    expect(blobRadiusMiles(1, SETTLEMENT_RULES)).toBe(SETTLEMENT_RULES.minBlobRadiusMiles)
  })
})

describe('buildingSlotCount', () => {
  it('scales with housing capacity', () => {
    expect(buildingSlotCount(15000, SETTLEMENT_RULES)).toBe(100 > SETTLEMENT_RULES.maxBuildingSlots ? SETTLEMENT_RULES.maxBuildingSlots : 100)
  })

  it('never drops below the configured minimum', () => {
    expect(buildingSlotCount(1, SETTLEMENT_RULES)).toBe(SETTLEMENT_RULES.minBuildingSlots)
  })

  it('never exceeds the configured maximum', () => {
    expect(buildingSlotCount(1000000, SETTLEMENT_RULES)).toBe(SETTLEMENT_RULES.maxBuildingSlots)
  })

  it('is monotonic in housing (growth never produces fewer slots)', () => {
    const counts = [1000, 2000, 5000, 8000].map((h) => buildingSlotCount(h, SETTLEMENT_RULES))
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    }
  })
})

describe('buildingSlot', () => {
  it('is deterministic: same settlement id and index always gives the same layout', () => {
    const shares = { working: 0.7, middle: 0.25, upper: 0.05 }
    const a = buildingSlot(7, 3, CLASS_ORDER, shares)
    const b = buildingSlot(7, 3, CLASS_ORDER, shares)
    expect(a).toEqual(b)
  })

  it('gives different settlements different layouts', () => {
    const shares = { working: 0.7, middle: 0.25, upper: 0.05 }
    const a = buildingSlot(7, 3, CLASS_ORDER, shares)
    const b = buildingSlot(8, 3, CLASS_ORDER, shares)
    expect(a.angle).not.toBeCloseTo(b.angle)
  })

  it('assigns every slot a valid class id', () => {
    const shares = { working: 0.7, middle: 0.25, upper: 0.05 }
    for (let i = 0; i < 50; i++) {
      const slot = buildingSlot(7, i, CLASS_ORDER, shares)
      expect(CLASS_ORDER).toContain(slot.classId)
    }
  })

  it('roughly matches class shares over many slots', () => {
    const shares = { working: 0.7, middle: 0.25, upper: 0.05 }
    const counts = { working: 0, middle: 0, upper: 0 }
    const n = 2000
    for (let i = 0; i < n; i++) {
      counts[buildingSlot(7, i, CLASS_ORDER, shares).classId] += 1
    }
    expect(counts.working / n).toBeGreaterThan(0.55)
    expect(counts.working / n).toBeLessThan(0.85)
  })
})

describe('footprintOffsets', () => {
  it('is deterministic for the same settlement id', () => {
    const a = footprintOffsets(7, 2, SETTLEMENT_RULES)
    const b = footprintOffsets(7, 2, SETTLEMENT_RULES)
    expect(a).toEqual(b)
  })

  it('returns vertexCount points centred on the origin', () => {
    const points = footprintOffsets(7, 2, SETTLEMENT_RULES, 12)
    expect(points).toHaveLength(12)
    for (const p of points) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(0)
    }
  })
})

describe('footprintStreets', () => {
  it('is deterministic for the same settlement id', () => {
    expect(footprintStreets(7, 2)).toEqual(footprintStreets(7, 2))
  })
})

describe('settlementFeatures', () => {
  it('always gives every settlement a church', () => {
    expect(settlementFeatures(makeSettlement({ kind: 'hamlet' })).church).toBe(true)
  })

  it('only gives a market to town-sized settlements and above', () => {
    expect(settlementFeatures(makeSettlement({ kind: 'hamlet' })).market).toBe(false)
    expect(settlementFeatures(makeSettlement({ kind: 'village' })).market).toBe(false)
    expect(settlementFeatures(makeSettlement({ kind: 'town' })).market).toBe(true)
    expect(settlementFeatures(makeSettlement({ kind: 'city' })).market).toBe(true)
  })

  it('only gives a wharf to a settlement with a port', () => {
    expect(settlementFeatures(makeSettlement({ portTier: 0 })).wharf).toBe(false)
    expect(settlementFeatures(makeSettlement({ portTier: 1 })).wharf).toBe(true)
  })

  it('is deterministic for the same settlement id', () => {
    const settlement = makeSettlement()
    expect(settlementFeatures(settlement)).toEqual(settlementFeatures(settlement))
  })
})

describe('featureOffsets', () => {
  it('places every feature at a distinct, nonzero offset', () => {
    const offsets = featureOffsets(2)
    const points = Object.values(offsets)
    for (const p of points) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(0)
    }
    const unique = new Set(points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`))
    expect(unique.size).toBe(points.length)
  })
})

describe('updateBuildingLifecycle', () => {
  it('marks new slots as born at the current time', () => {
    const map = new Map()
    const slots = updateBuildingLifecycle(map, 1, 3, 1000, 2000)
    expect(slots.size).toBe(3)
    for (const entry of slots.values()) {
      expect(entry).toEqual({ bornAt: 1000, removedAt: null })
    }
  })

  it('does not re-born an already-tracked slot on a later frame', () => {
    const map = new Map()
    updateBuildingLifecycle(map, 1, 3, 1000, 2000)
    const slots = updateBuildingLifecycle(map, 1, 3, 1500, 2000)
    expect(slots.get(0).bornAt).toBe(1000)
  })

  it('marks a slot abandoned the frame it falls out of range, and only then', () => {
    const map = new Map()
    updateBuildingLifecycle(map, 1, 5, 1000, 2000)
    let slots = updateBuildingLifecycle(map, 1, 2, 1500, 2000)
    expect(slots.get(3).removedAt).toBe(1500)
    expect(slots.get(4).removedAt).toBe(1500)
    expect(slots.get(0).removedAt).toBeNull()

    // A later frame, still shrunk, must not move removedAt forward.
    slots = updateBuildingLifecycle(map, 1, 2, 1800, 2000)
    expect(slots.get(3).removedAt).toBe(1500)
  })

  it('purges an abandoned slot once its fade duration elapses', () => {
    const map = new Map()
    updateBuildingLifecycle(map, 1, 3, 1000, 2000)
    let slots = updateBuildingLifecycle(map, 1, 0, 1500, 2000)
    expect(slots.has(0)).toBe(true)
    slots = updateBuildingLifecycle(map, 1, 0, 4000, 2000)
    expect(slots.size).toBe(0)
  })

  it('revives a slot (clears removedAt) if growth brings it back before it is purged', () => {
    const map = new Map()
    updateBuildingLifecycle(map, 1, 3, 1000, 2000)
    updateBuildingLifecycle(map, 1, 1, 1500, 2000)
    const slots = updateBuildingLifecycle(map, 1, 3, 1800, 2000)
    expect(slots.get(2).removedAt).toBeNull()
  })

  it('tracks multiple settlements independently', () => {
    const map = new Map()
    updateBuildingLifecycle(map, 1, 3, 1000, 2000)
    updateBuildingLifecycle(map, 2, 5, 1000, 2000)
    expect(map.get(1).size).toBe(3)
    expect(map.get(2).size).toBe(5)
  })
})

// A 100x1 world, 1 mile per cell: x in [0, 50) is open water, x in [50, 60)
// carries a river channel (width class 3), x in [60, 100) is dry land —
// just enough shape to exercise `isWaterAt()`/`dryRadiusFraction()`'s own
// logic without needing a real generated grid.
function makeStripGrid() {
  const width = 100
  const water = new Uint8Array(width)
  const river = new Uint8Array(width)
  for (let x = 0; x < 50; x++) water[x] = 1
  for (let x = 50; x < 60; x++) river[x] = 3
  return { width, height: 1, cellMiles: 1, water, river }
}

describe('isWaterAt', () => {
  const grid = makeStripGrid()

  it('is true over open water', () => {
    expect(isWaterAt(grid, 10.5, 0.5, 2)).toBe(true)
  })

  it('is true over a river channel at or above the given width class', () => {
    expect(isWaterAt(grid, 55.5, 0.5, 2)).toBe(true)
  })

  it('is false below the river channel\'s own width class', () => {
    expect(isWaterAt(grid, 55.5, 0.5, 5)).toBe(false)
  })

  it('is false over dry land', () => {
    expect(isWaterAt(grid, 75.5, 0.5, 2)).toBe(false)
  })

  it('is true off the edge of the grid, in either direction', () => {
    expect(isWaterAt(grid, -5, 0.5, 2)).toBe(true)
    expect(isWaterAt(grid, 150, 0.5, 2)).toBe(true)
  })
})

describe('dryRadiusFraction', () => {
  const grid = makeStripGrid()

  it('returns the fraction unchanged when no grid is given (placeholder/test worlds)', () => {
    expect(dryRadiusFraction(undefined, 99.5, 0.5, 0, 60, 1, 2)).toBe(1)
  })

  it('returns the fraction unchanged when the initial position is already dry', () => {
    expect(dryRadiusFraction(grid, 99.5, 0.5, 0, 1, 0.1, 2)).toBe(0.1)
  })

  it('shrinks the fraction until the position lands off water, pulling towards the (dry) settlement centre', () => {
    // Settlement at x=99.5 (dry), pointing back across the river/water
    // band (angle=PI, i.e. -x direction). The raw fraction (1.0) lands
    // at x=39.5 (open water); shrinking once (x0.6) lands at x=63.5,
    // which is dry.
    const fraction = dryRadiusFraction(grid, 99.5, 0.5, Math.PI, 60, 1, 2)
    expect(fraction).toBeCloseTo(0.6, 10)
    const worldX = 99.5 + Math.cos(Math.PI) * 60 * fraction
    expect(isWaterAt(grid, worldX, 0.5, 2)).toBe(false)
  })

  it('still returns a (shrunk) number rather than looping forever when every attempt stays wet', () => {
    const allWater = { width: 2, height: 1, cellMiles: 1, water: new Uint8Array([1, 1]), river: new Uint8Array([0, 0]) }
    const fraction = dryRadiusFraction(allWater, 0.5, 0.5, 0, 1, 1, 2)
    expect(fraction).toBeCloseTo(1 * 0.6 ** 6, 10)
  })
})
