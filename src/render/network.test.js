import { describe, expect, it } from 'vitest'
import {
  distanceToPath,
  distanceToSegment,
  findNearestLink,
  isLinkVisible,
  linkColour,
  linkWidthPx,
  simplifyScreenPoints,
} from './network.js'

const PALETTE = {
  roadByTier: { 0: '#9c8a6a', 1: '#9c8a6a', 2: '#8a7a5c', 3: '#6b6254' },
  railByTier: { 0: '#4a4740', 1: '#4a4740', 2: '#2b2620', 3: '#2b2620' },
  seaLane: '#2f4f5f',
  network: {
    widthPxByTier: [1, 1.4, 1.9, 2.5],
    minPpmByTier: [12, 6, 1.5, 1.5],
    seaLaneWidthPx: 1.4,
    seaLaneDash: [5, 4],
  },
}

function makeLink(overrides = {}) {
  return { id: 1, aType: 's', aId: 1, bType: 's', bId: 2, mode: 'road', tier: 0, lengthMi: 1, gradient: 0, condition: 1, owner: null, path: [[0, 0], [1, 0]], ...overrides }
}

describe('linkColour', () => {
  it('picks the road colour for the link\'s tier', () => {
    expect(linkColour(makeLink({ mode: 'road', tier: 2 }), PALETTE)).toBe(PALETTE.roadByTier[2])
  })

  it('picks the rail colour for the link\'s tier', () => {
    expect(linkColour(makeLink({ mode: 'rail', tier: 3 }), PALETTE)).toBe(PALETTE.railByTier[3])
  })

  it('always uses seaLane for sea links, ignoring tier', () => {
    expect(linkColour(makeLink({ mode: 'sea', tier: 0 }), PALETTE)).toBe(PALETTE.seaLane)
  })
})

describe('linkWidthPx', () => {
  it('increases with road tier', () => {
    const w0 = linkWidthPx(makeLink({ mode: 'road', tier: 0 }), PALETTE.network)
    const w3 = linkWidthPx(makeLink({ mode: 'road', tier: 3 }), PALETTE.network)
    expect(w3).toBeGreaterThan(w0)
  })

  it('uses the fixed sea lane width regardless of tier', () => {
    expect(linkWidthPx(makeLink({ mode: 'sea', tier: 0 }), PALETTE.network)).toBe(PALETTE.network.seaLaneWidthPx)
  })
})

describe('isLinkVisible', () => {
  it('hides a low-tier road below its minPpm threshold', () => {
    const link = makeLink({ mode: 'road', tier: 0 }) // minPpmByTier[0] = 12
    expect(isLinkVisible(link, 6, PALETTE.network)).toBe(false)
    expect(isLinkVisible(link, 12, PALETTE.network)).toBe(true)
  })

  it('a higher-tier road needs a lower ppm to appear', () => {
    const link = makeLink({ mode: 'road', tier: 3 }) // minPpmByTier[3] = 1.5
    expect(isLinkVisible(link, 2, PALETTE.network)).toBe(true)
  })

  it('rail and sea links are always visible, regardless of ppm', () => {
    expect(isLinkVisible(makeLink({ mode: 'rail', tier: 0 }), 0.1, PALETTE.network)).toBe(true)
    expect(isLinkVisible(makeLink({ mode: 'sea', tier: 0 }), 0.1, PALETTE.network)).toBe(true)
  })
})

describe('simplifyScreenPoints', () => {
  it('always keeps the first and last point', () => {
    const points = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.2, y: 0 }, { x: 100, y: 0 }]
    const result = simplifyScreenPoints(points, 5)
    expect(result[0]).toEqual(points[0])
    expect(result[result.length - 1]).toEqual(points[points.length - 1])
  })

  it('drops points closer together than the gap threshold', () => {
    const points = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]
    const result = simplifyScreenPoints(points, 5)
    // 0.5 and 1 are both within 5px of the kept point at 0, so only 0, 10(ish), 20 survive.
    expect(result.length).toBeLessThan(points.length)
  })

  it('leaves a 2-point path untouched', () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 100 }]
    expect(simplifyScreenPoints(points, 50)).toEqual(points)
  })

  it('never drops every interior point if they are far enough apart', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]
    expect(simplifyScreenPoints(points, 5)).toHaveLength(3)
  })
})

describe('distanceToSegment', () => {
  it('is zero for a point on the segment', () => {
    expect(distanceToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0)
  })

  it('is the perpendicular distance for a point beside the segment', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3)
  })

  it('clamps to the nearest endpoint beyond the segment\'s ends', () => {
    expect(distanceToSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5)
    expect(distanceToSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5)
  })

  it('handles a zero-length segment as a point distance', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5)
  })
})

describe('distanceToPath', () => {
  it('is the minimum distance over every segment', () => {
    const path = [[0, 0], [10, 0], [10, 10]]
    expect(distanceToPath({ x: 10, y: 5 }, path)).toBeCloseTo(0)
    expect(distanceToPath({ x: 5, y: 1 }, path)).toBeCloseTo(1)
  })

  it('is Infinity for a path with fewer than 2 points', () => {
    expect(distanceToPath({ x: 0, y: 0 }, [[0, 0]])).toBe(Infinity)
    expect(distanceToPath({ x: 0, y: 0 }, [])).toBe(Infinity)
  })
})

describe('findNearestLink', () => {
  it('returns the closest link within range', () => {
    const near = makeLink({ id: 1, path: [[0, 0], [10, 0]] })
    const far = makeLink({ id: 2, path: [[0, 100], [10, 100]] })
    const result = findNearestLink([far, near], { x: 5, y: 1 }, 50)
    expect(result.link.id).toBe(1)
    expect(result.distanceMiles).toBeCloseTo(1)
  })

  it('returns null when nothing is within maxDistanceMiles', () => {
    const link = makeLink({ path: [[0, 0], [10, 0]] })
    expect(findNearestLink([link], { x: 5, y: 100 }, 1)).toBeNull()
  })

  it('returns null for an empty link list', () => {
    expect(findNearestLink([], { x: 0, y: 0 }, 10)).toBeNull()
  })

  it('ignores links with no path (e.g. world/port stub links)', () => {
    const stub = makeLink({ id: 1, path: [] })
    const real = makeLink({ id: 2, path: [[0, 0], [10, 0]] })
    const result = findNearestLink([stub, real], { x: 5, y: 1 }, 50)
    expect(result.link.id).toBe(2)
  })
})
