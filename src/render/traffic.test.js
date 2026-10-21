import { describe, expect, it } from 'vitest'
import {
  dominantCargoCategory,
  linkFlowTonnes,
  pointAtPathFraction,
  portHasActivity,
  vehicleColour,
  vehicleCountForLink,
  vehiclePosition,
} from './traffic.js'

const CARGO_RULES = [
  { id: 'coal', category: 'bulk' },
  { id: 'fish', category: 'perishable' },
  { id: 'cloth', category: 'general' },
]

const TRAFFIC_RULES = {
  colourByCargoCategory: { bulk: '#8a7a5c', perishable: '#6b8a5c', general: '#a8683f' },
  defaultColour: '#8a8478',
  tonnesPerVehicle: 150,
  maxVehiclesPerLink: 6,
  tripDurationMsByMode: { road: 9000, rail: 6000, sea: 14000 },
}

function makeLink(overrides = {}) {
  return {
    id: 1,
    aType: 's',
    aId: 1,
    bType: 's',
    bId: 2,
    mode: 'road',
    tier: 1,
    lengthMi: 10,
    gradient: 0.02,
    condition: 1,
    owner: 'public',
    path: [[0, 0], [5, 0], [10, 0]],
    recentFlow: {},
    ...overrides,
  }
}

describe('linkFlowTonnes', () => {
  it('sums every cargo', () => {
    expect(linkFlowTonnes(makeLink({ recentFlow: { coal: 100, fish: 20 } }))).toBe(120)
  })

  it('is zero for an empty recentFlow', () => {
    expect(linkFlowTonnes(makeLink())).toBe(0)
  })
})

describe('dominantCargoCategory', () => {
  it('picks the heaviest cargo\'s category', () => {
    const link = makeLink({ recentFlow: { coal: 50, fish: 200, cloth: 10 } })
    expect(dominantCargoCategory(link, CARGO_RULES)).toBe('perishable')
  })

  it('is null for a link with no flow', () => {
    expect(dominantCargoCategory(makeLink(), CARGO_RULES)).toBeNull()
  })

  it('is null for a cargo id not found in cargo.json', () => {
    const link = makeLink({ recentFlow: { mystery_cargo: 50 } })
    expect(dominantCargoCategory(link, CARGO_RULES)).toBeNull()
  })
})

describe('vehicleColour', () => {
  it('looks up the configured colour for a category', () => {
    expect(vehicleColour('bulk', TRAFFIC_RULES)).toEqual({ r: 138, g: 122, b: 92 })
  })

  it('falls back to defaultColour for null category', () => {
    expect(vehicleColour(null, TRAFFIC_RULES)).toEqual({ r: 138, g: 132, b: 120 })
  })

  it('falls back to defaultColour for an unmapped category', () => {
    expect(vehicleColour('special', TRAFFIC_RULES)).toEqual({ r: 138, g: 132, b: 120 })
  })
})

describe('vehicleCountForLink', () => {
  it('is zero for zero flow (Done-when: a link with zero flow shows nothing)', () => {
    expect(vehicleCountForLink(makeLink(), TRAFFIC_RULES)).toBe(0)
  })

  it('scales up with more tonnes (Done-when: high flow shows more traffic)', () => {
    const low = vehicleCountForLink(makeLink({ recentFlow: { coal: 150 } }), TRAFFIC_RULES)
    const high = vehicleCountForLink(makeLink({ recentFlow: { coal: 900 } }), TRAFFIC_RULES)
    expect(low).toBeGreaterThanOrEqual(1)
    expect(high).toBeGreaterThan(low)
  })

  it('never exceeds maxVehiclesPerLink', () => {
    expect(vehicleCountForLink(makeLink({ recentFlow: { coal: 1000000 } }), TRAFFIC_RULES)).toBe(6)
  })
})

describe('pointAtPathFraction', () => {
  it('returns the start point at t=0 and the end point at t=1', () => {
    const path = [[0, 0], [10, 0], [10, 10]]
    expect(pointAtPathFraction(path, 0)).toEqual({ x: 0, y: 0 })
    expect(pointAtPathFraction(path, 1)).toEqual({ x: 10, y: 10 })
  })

  it('moves at an even pace across unequal segment lengths', () => {
    // First segment is 10 long, second is 1 long: total 11. t=10/11 should land exactly on the corner.
    const path = [[0, 0], [10, 0], [11, 0]]
    const point = pointAtPathFraction(path, 10 / 11)
    expect(point.x).toBeCloseTo(10)
  })

  it('handles a single-point path', () => {
    expect(pointAtPathFraction([[5, 5]], 0.5)).toEqual({ x: 5, y: 5 })
  })

  it('handles a zero-length path (coincident points)', () => {
    expect(pointAtPathFraction([[3, 3], [3, 3]], 0.5)).toEqual({ x: 3, y: 3 })
  })

  it('clamps t outside [0, 1]', () => {
    const path = [[0, 0], [10, 0]]
    expect(pointAtPathFraction(path, -1)).toEqual({ x: 0, y: 0 })
    expect(pointAtPathFraction(path, 2)).toEqual({ x: 10, y: 0 })
  })
})

describe('vehiclePosition', () => {
  it('is deterministic for the same inputs', () => {
    const link = makeLink()
    expect(vehiclePosition(link, 0, 1000, TRAFFIC_RULES)).toEqual(vehiclePosition(link, 0, 1000, TRAFFIC_RULES))
  })

  it('depends only on link, slotIndex and nowMs, never on any camera/zoom value (Done-when: no sprite teleports at zoom changes)', () => {
    const link = makeLink()
    // Calling it twice with wildly different hypothetical "zoom" context (there is none to pass in)
    // at the same nowMs must give the same position - the function signature itself enforces this.
    const a = vehiclePosition(link, 2, 4000, TRAFFIC_RULES)
    const b = vehiclePosition(link, 2, 4000, TRAFFIC_RULES)
    expect(a).toEqual(b)
  })

  it('different slots on the same link get different phase offsets', () => {
    const link = makeLink()
    const a = vehiclePosition(link, 0, 1000, TRAFFIC_RULES)
    const b = vehiclePosition(link, 1, 1000, TRAFFIC_RULES)
    expect(a).not.toEqual(b)
  })

  it('moves over time (is not stuck at one point)', () => {
    const link = makeLink()
    const a = vehiclePosition(link, 0, 0, TRAFFIC_RULES)
    const b = vehiclePosition(link, 0, 3000, TRAFFIC_RULES)
    expect(a).not.toEqual(b)
  })

  it('loops back to the same position after one full tripDuration', () => {
    const link = makeLink()
    const a = vehiclePosition(link, 0, 500, TRAFFIC_RULES)
    const b = vehiclePosition(link, 0, 500 + TRAFFIC_RULES.tripDurationMsByMode.road, TRAFFIC_RULES)
    expect(a.x).toBeCloseTo(b.x)
    expect(a.y).toBeCloseTo(b.y)
  })
})

describe('portHasActivity', () => {
  function makeSettlement(overrides = {}) {
    return { id: 1, name: 'Testport', kind: 'town', x: 0, y: 0, portTier: 1, housing: 1000, regionCells: 5, pop: {}, stock: {}, ...overrides }
  }

  it('is false for a settlement with no port', () => {
    const settlement = makeSettlement({ portTier: 0 })
    const links = [makeLink({ mode: 'sea', aType: 's', aId: 1, recentFlow: { coal: 100 } })]
    expect(portHasActivity(settlement, links)).toBe(false)
  })

  it('is false when its sea links carry nothing', () => {
    const settlement = makeSettlement()
    const links = [makeLink({ mode: 'sea', aType: 's', aId: 1, recentFlow: {} })]
    expect(portHasActivity(settlement, links)).toBe(false)
  })

  it('is true when a connected sea link is carrying cargo', () => {
    const settlement = makeSettlement()
    const links = [makeLink({ mode: 'sea', aType: 's', aId: 1, recentFlow: { coal: 100 } })]
    expect(portHasActivity(settlement, links)).toBe(true)
  })

  it('ignores a flowing link that does not touch this settlement', () => {
    const settlement = makeSettlement({ id: 5 })
    const links = [makeLink({ mode: 'sea', aType: 's', aId: 1, bType: 's', bId: 2, recentFlow: { coal: 100 } })]
    expect(portHasActivity(settlement, links)).toBe(false)
  })

  it('ignores a flowing road link even if it touches this settlement', () => {
    const settlement = makeSettlement()
    const links = [makeLink({ mode: 'road', aType: 's', aId: 1, recentFlow: { coal: 100 } })]
    expect(portHasActivity(settlement, links)).toBe(false)
  })
})
