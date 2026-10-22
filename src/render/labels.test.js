import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../sim/rules.js'
import { generateWorld } from '../sim/mapgen/world.js'
import { MIN_PPM, MAX_PPM } from './camera.js'
import { topDownProjection } from './projection.js'
import {
  buildIndustryCandidates,
  buildSettlementCandidates,
  estimateLabelWidthPx,
  isLabelKindVisible,
  labelFadeAlpha,
  labelFontSizePx,
  labelPriorityScore,
  layoutLabels,
} from './labels.js'

const LABELS_RULES = {
  textColour: '#fff8ee',
  haloColour: '#1a1714',
  haloWidthPx: 3,
  baseFontSizePx: 13,
  refPpm: 12,
  logScaleRate: 0.08,
  minFontScale: 0.85,
  maxFontScale: 1.25,
  charWidthFactor: 0.56,
  anchorOffsetPx: 10,
  cellSizePx: 60,
  fadeRangePpmFactor: 1.5,
  minPpmByKind: { capital: 1.5, city: 1.5, town: 4, village: 12, hamlet: 24 },
  industriesMinPpm: 12,
}

const VIEWPORT = { width: 1000, height: 700 }

function makeSettlement(overrides = {}) {
  return {
    id: 1, name: 'Ashton', kind: 'town', x: 0, y: 0, portTier: 0, housing: 5000, regionCells: 10,
    pop: { 0: { pop: 4000, employed: 3500, confidence: 0.6 }, 1: { pop: 900, employed: 800, confidence: 0.6 }, 2: { pop: 100, employed: 90, confidence: 0.6 } },
    stock: {},
    ...overrides,
  }
}

function makeIndustry(overrides = {}) {
  return {
    id: 1, typeId: 'coal_mine', name: 'Ashton Colliery', x: 0, y: 0, homeSettlementId: 1,
    capacity: 3000, utilisation: 1, richnessLeft: 1, openedDay: 0, closedDay: null, monthsLow: 0, stock: {},
    ...overrides,
  }
}

describe('buildSettlementCandidates', () => {
  it('builds one candidate per settlement with the right rank and weight', () => {
    const candidates = buildSettlementCandidates([makeSettlement({ kind: 'capital' })])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'capital', text: 'Ashton', rank: 0, weight: 5000 })
  })
})

describe('buildIndustryCandidates', () => {
  it('builds one candidate per industry, ranked below every settlement kind', () => {
    const candidates = buildIndustryCandidates([makeIndustry()])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'industry', text: 'Ashton Colliery', rank: 5, weight: 3000 })
  })
})

describe('labelPriorityScore', () => {
  it('ranks a capital ahead of a city regardless of population', () => {
    const capital = { rank: 0, weight: 1000 }
    const city = { rank: 1, weight: 1000000 }
    expect(labelPriorityScore(capital)).toBeLessThan(labelPriorityScore(city))
  })

  it('within the same rank, higher weight sorts first', () => {
    const bigTown = { rank: 2, weight: 30000 }
    const smallTown = { rank: 2, weight: 6000 }
    expect(labelPriorityScore(bigTown)).toBeLessThan(labelPriorityScore(smallTown))
  })

  it('ranks any settlement ahead of any industry', () => {
    const hamlet = { rank: 4, weight: 1 }
    const industry = { rank: 5, weight: 1000000 }
    expect(labelPriorityScore(hamlet)).toBeLessThan(labelPriorityScore(industry))
  })
})

describe('estimateLabelWidthPx', () => {
  it('scales with text length and font size', () => {
    expect(estimateLabelWidthPx('Ashton', 10, 0.56)).toBeCloseTo(6 * 10 * 0.56)
    expect(estimateLabelWidthPx('Ashtonbury', 10, 0.56)).toBeGreaterThan(estimateLabelWidthPx('Ashton', 10, 0.56))
  })
})

describe('labelFontSizePx', () => {
  it('is exactly baseFontSizePx at refPpm', () => {
    expect(labelFontSizePx(LABELS_RULES.refPpm, LABELS_RULES)).toBeCloseTo(LABELS_RULES.baseFontSizePx)
  })

  it('never scales outside [minFontScale, maxFontScale] across the whole camera zoom range', () => {
    for (const ppm of [MIN_PPM, 3, 12, 50, MAX_PPM]) {
      const size = labelFontSizePx(ppm, LABELS_RULES)
      expect(size).toBeGreaterThanOrEqual(LABELS_RULES.baseFontSizePx * LABELS_RULES.minFontScale - 1e-9)
      expect(size).toBeLessThanOrEqual(LABELS_RULES.baseFontSizePx * LABELS_RULES.maxFontScale + 1e-9)
    }
  })

  it('is larger at higher ppm than lower ppm (small scale with zoom)', () => {
    expect(labelFontSizePx(MAX_PPM, LABELS_RULES)).toBeGreaterThan(labelFontSizePx(MIN_PPM, LABELS_RULES))
  })
})

describe('isLabelKindVisible / labelFadeAlpha', () => {
  it('a hamlet is invisible below its minPpm and fully visible well above it', () => {
    const hamlet = { kind: 'hamlet' }
    expect(isLabelKindVisible(hamlet, 10, LABELS_RULES)).toBe(false)
    expect(isLabelKindVisible(hamlet, 30, LABELS_RULES)).toBe(true)
    expect(labelFadeAlpha(hamlet, 10, LABELS_RULES)).toBe(0)
    expect(labelFadeAlpha(hamlet, 40, LABELS_RULES)).toBeCloseTo(1)
  })

  it('fades a hamlet in smoothly between minPpm and minPpm*fadeRangePpmFactor', () => {
    const hamlet = { kind: 'hamlet' }
    const minPpm = LABELS_RULES.minPpmByKind.hamlet
    const mid = minPpm * (LABELS_RULES.fadeRangePpmFactor + 1) / 2
    const alpha = labelFadeAlpha(hamlet, mid, LABELS_RULES)
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(1)
  })

  it('a capital/city (minPpm at the camera floor) is always full opacity once visible, never mid-fade (Done-when: always labelled in Region band)', () => {
    const capital = { kind: 'capital' }
    expect(labelFadeAlpha(capital, MIN_PPM, LABELS_RULES)).toBe(1)
    expect(labelFadeAlpha(capital, 2, LABELS_RULES)).toBe(1)
    expect(labelFadeAlpha(capital, MAX_PPM, LABELS_RULES)).toBe(1)
  })

  it('an industry is invisible below industriesMinPpm', () => {
    const industry = { kind: 'industry' }
    expect(isLabelKindVisible(industry, 6, LABELS_RULES)).toBe(false)
    expect(isLabelKindVisible(industry, 20, LABELS_RULES)).toBe(true)
  })
})

describe('layoutLabels', () => {
  it('places two settlements far apart with no overlap', () => {
    const candidates = buildSettlementCandidates([
      makeSettlement({ id: 1, kind: 'town', x: 0, y: 0 }),
      makeSettlement({ id: 2, kind: 'town', x: 200, y: 0 }),
    ])
    const camera = { x: 100, y: 0, ppm: 4.5 }
    const placed = layoutLabels({ candidates, camera, viewport: VIEWPORT, projection: topDownProjection, rules: LABELS_RULES })
    expect(placed).toHaveLength(2)
  })

  it('drops the lower-priority label when two candidates would overlap', () => {
    const candidates = buildSettlementCandidates([
      makeSettlement({ id: 1, name: 'BigCity', kind: 'city', x: 0, y: 0, pop: { 0: { pop: 100000, employed: 1, confidence: 1 }, 1: {}, 2: {} } }),
      makeSettlement({ id: 2, name: 'TinyHamlet', kind: 'hamlet', x: 0.05, y: 0, pop: { 0: { pop: 10, employed: 1, confidence: 1 }, 1: {}, 2: {} } }),
    ])
    const camera = { x: 0, y: 0, ppm: 30 } // close enough together on screen to collide at this zoom
    const placed = layoutLabels({ candidates, camera, viewport: VIEWPORT, projection: topDownProjection, rules: LABELS_RULES })
    expect(placed).toHaveLength(1)
    expect(placed[0].text).toBe('BigCity')
  })

  it('never places two overlapping label boxes, for any candidate set', () => {
    const candidates = buildSettlementCandidates(
      Array.from({ length: 30 }, (_, i) => makeSettlement({ id: i + 1, name: `Town${i}`, kind: 'town', x: (i % 6) * 5, y: Math.floor(i / 6) * 5 })),
    )
    const camera = { x: 15, y: 10, ppm: 40 }
    const placed = layoutLabels({ candidates, camera, viewport: VIEWPORT, projection: topDownProjection, rules: LABELS_RULES })
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) {
        const boxA = boxFor(placed[a], LABELS_RULES)
        const boxB = boxFor(placed[b], LABELS_RULES)
        const overlap = boxA.x < boxB.x + boxB.width && boxA.x + boxA.width > boxB.x && boxA.y < boxB.y + boxB.height && boxA.y + boxA.height > boxB.y
        expect(overlap).toBe(false)
      }
    }
  })

  it('omits a candidate whose kind is not yet visible at this ppm', () => {
    const candidates = buildSettlementCandidates([makeSettlement({ kind: 'hamlet' })])
    const camera = { x: 0, y: 0, ppm: 2 }
    const placed = layoutLabels({ candidates, camera, viewport: VIEWPORT, projection: topDownProjection, rules: LABELS_RULES })
    expect(placed).toHaveLength(0)
  })
})

/** @returns {{x: number, y: number, width: number, height: number}} Independent re-derivation of a placed label's screen box, for the overlap test above (not calling back into labels.js's own internal box helper, to avoid a tautological check). */
function boxFor(label, rules) {
  const width = label.text.length * label.fontSizePx * rules.charWidthFactor
  const height = label.fontSizePx
  return { x: label.screen.x - width / 2, y: label.screen.y - rules.anchorOffsetPx - height, width, height }
}

describe('PHASES.md T2.10 Done-when, against a real generated world', () => {
  const SEED = 'ironway-001'
  let world
  let rules

  beforeAll(async () => {
    rules = await loadRulesNode('public/data')
    const generated = generateWorld(SEED, 'normal', rules)
    world = generated.world
  })

  /** A small deterministic PRNG (mulberry32), so "200 random camera positions" is reproducible without Math.random. */
  function mulberry32(seed) {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('finds no overlapping labels across 200 random camera positions', () => {
    const candidates = [...buildSettlementCandidates(world.settlements), ...buildIndustryCandidates(world.industries)]
    const bounds = { maxX: world.grid.width * world.grid.cellMiles, maxY: world.grid.height * world.grid.cellMiles }
    const random = mulberry32(20261022)
    const logMinPpm = Math.log(MIN_PPM)
    const logMaxPpm = Math.log(MAX_PPM)

    for (let i = 0; i < 200; i++) {
      const camera = {
        x: random() * bounds.maxX,
        y: random() * bounds.maxY,
        ppm: Math.exp(logMinPpm + random() * (logMaxPpm - logMinPpm)),
      }
      const placed = layoutLabels({ candidates, camera, viewport: VIEWPORT, projection: topDownProjection, rules: LABELS_RULES })
      for (let a = 0; a < placed.length; a++) {
        for (let b = a + 1; b < placed.length; b++) {
          const boxA = boxFor(placed[a], LABELS_RULES)
          const boxB = boxFor(placed[b], LABELS_RULES)
          const overlap = boxA.x < boxB.x + boxB.width && boxA.x + boxA.width > boxB.x && boxA.y < boxB.y + boxB.height && boxA.y + boxA.height > boxB.y
          if (overlap) throw new Error(`camera ${i} (x=${camera.x}, y=${camera.y}, ppm=${camera.ppm}): "${placed[a].text}" overlaps "${placed[b].text}"`)
        }
      }
    }
  })

  it('always labels the capital and every city in the Region band that is actually on screen', () => {
    // "Always labelled" means never dropped by the declutter algorithm
    // (capital/city outrank everything else, so nothing can ever push
    // them out) — not that panning the camera away from one still
    // shows it. For each Region-band ppm, only assert it for whichever
    // capitals/cities the camera's own visible-world bounds actually
    // include, rather than assuming a particular pan position.
    const candidates = buildSettlementCandidates(world.settlements)
    const capitalsAndCities = world.settlements.filter((s) => s.kind === 'capital' || s.kind === 'city')
    expect(capitalsAndCities.length).toBeGreaterThan(0)

    const centreX = (world.grid.width * world.grid.cellMiles) / 2
    const centreY = (world.grid.height * world.grid.cellMiles) / 2
    let anyChecked = false

    for (const ppm of [MIN_PPM, 2, 2.75, 3.5, 4]) {
      const camera = { x: centreX, y: centreY, ppm }
      const corners = topDownProjection.visibleWorldPolygon(camera, VIEWPORT)
      const minX = Math.min(...corners.map((c) => c.x))
      const maxX = Math.max(...corners.map((c) => c.x))
      const minY = Math.min(...corners.map((c) => c.y))
      const maxY = Math.max(...corners.map((c) => c.y))

      const placed = layoutLabels({ candidates, camera, viewport: VIEWPORT, projection: topDownProjection, rules: LABELS_RULES })
      const placedTexts = new Set(placed.map((p) => p.text))

      for (const s of capitalsAndCities) {
        if (s.x < minX || s.x > maxX || s.y < minY || s.y > maxY) continue
        anyChecked = true
        expect(placedTexts.has(s.name)).toBe(true)
      }
    }
    expect(anyChecked).toBe(true)
  })
})
