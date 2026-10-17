import { beforeAll, describe, expect, it } from 'vitest'
import { loadRulesNode } from '../rules.js'
import { createWorldGrid } from './grid.js'
import { generateIsland } from './island.js'
import { generateRain } from './climate.js'
import { generateHydrology } from './hydrology.js'
import { generateSlope } from './slope.js'
import { COAST_FLAG, findBayRegions, generateCoast, selectHarbourCandidates } from './coast.js'

const SEEDS = Array.from({ length: 20 }, (_, i) => `ironway-${String(i + 1).padStart(3, '0')}`)

let mapgenRules
const cache = new Map()

beforeAll(async () => {
  const rules = await loadRulesNode('public/data')
  mapgenRules = rules.mapgen
})

/**
 * Runs the full pipeline through coast generation for a seed. Memoised
 * per seed since several `it.each` blocks check different properties
 * of the same 20 generated islands.
 *
 * @param {string} seed The save seed.
 * @returns {{grid: object, harbourCandidates: object[], bayRegions: number[][]}}
 */
function generate(seed) {
  if (cache.has(seed)) {
    return cache.get(seed)
  }

  const grid = createWorldGrid(mapgenRules.grid.width, mapgenRules.grid.height, mapgenRules.grid.cellMiles)
  generateIsland(grid, seed, mapgenRules)
  generateRain(grid, mapgenRules.climate)
  generateHydrology(grid, mapgenRules.hydrology)
  generateSlope(grid, mapgenRules.slope)
  const { harbourCandidates, bayRegions } = generateCoast(grid, mapgenRules)

  const result = { grid, harbourCandidates, bayRegions }
  cache.set(seed, result)
  return result
}

describe('generateCoast property tests (20 seeds)', () => {
  it.each(SEEDS)('%s: at least 10 harbour candidates', (seed) => {
    const { harbourCandidates } = generate(seed)
    expect(harbourCandidates.length).toBeGreaterThanOrEqual(10)
  })

  it.each(SEEDS)('%s: at least 3 estuary harbours', (seed) => {
    const { harbourCandidates } = generate(seed)
    const estuaryCount = harbourCandidates.filter((c) => c.isEstuary).length
    expect(estuaryCount).toBeGreaterThanOrEqual(3)
  })

  it.each(SEEDS)('%s: every pair of candidates is 40+ miles apart', (seed) => {
    const { grid, harbourCandidates } = generate(seed)

    for (let a = 0; a < harbourCandidates.length; a++) {
      for (let b = a + 1; b < harbourCandidates.length; b++) {
        const dx = harbourCandidates[a].x - harbourCandidates[b].x
        const dy = harbourCandidates[a].y - harbourCandidates[b].y
        const distanceMiles = Math.sqrt(dx * dx + dy * dy) * grid.cellMiles
        expect(distanceMiles).toBeGreaterThanOrEqual(mapgenRules.coast.harbourMinSpacingMiles - 0.1)
      }
    }
  })

  it.each(SEEDS)('%s: every candidate lies on the coast', (seed) => {
    const { grid, harbourCandidates } = generate(seed)
    for (const candidate of harbourCandidates) {
      expect(grid.coast[candidate.index] & COAST_FLAG.COASTAL).toBeTruthy()
      expect(grid.coast[candidate.index] & COAST_FLAG.HARBOUR_CANDIDATE).toBeTruthy()
    }
  })

  it.each(SEEDS)('%s: every candidate has a finite score, for debugging', (seed) => {
    const { harbourCandidates } = generate(seed)
    for (const candidate of harbourCandidates) {
      expect(Number.isFinite(candidate.score)).toBe(true)
    }
  })
})

describe('markCoastalFlags / shelter (synthetic grid)', () => {
  it('flags a land cell adjacent to the sea as coastal, and an inland cell as not', () => {
    // 5x5: sea border, land interior, so (1,1) is coastal and (2,2) is inland.
    const width = 5
    const height = 5
    const grid = createWorldGrid(width, height, 2)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const onEdge = x === 0 || x === width - 1 || y === 0 || y === height - 1
        grid.water[i] = onEdge ? 1 : 0
        grid.elev[i] = onEdge ? -10 : 10
      }
    }

    const mapgen = {
      coast: { cliffSlopeRatio: 0.9, shelterRadiusMiles: 24, rayMaxMiles: 20, bayShelterThreshold: 0.6, portRiverFlowThreshold: 500, harbourMinSpacingMiles: 40, minEstuaryHarbours: 3, estuaryBonus: 0.3, shoreDepthSearchRadiusMiles: 8, shoreDepthScaleMetres: 80, shoreDepthWeight: 0.3, mudflatSlopeRatio: 0.02, mudflatShoreDepthMax: 0.15, mudflatPenalty: 0.3 },
      slope: { quantizationScale: 100 },
    }
    generateSlope(grid, mapgen.slope)
    generateCoast(grid, mapgen)

    const coastalIndex = 1 * width + 1
    const inlandIndex = 2 * width + 2
    expect(grid.coast[coastalIndex] & COAST_FLAG.COASTAL).toBeTruthy()
    expect(grid.coast[inlandIndex] & COAST_FLAG.COASTAL).toBeFalsy()
  })

  it('flags a coastal river cell as an estuary', () => {
    const width = 5
    const height = 5
    const grid = createWorldGrid(width, height, 2)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const onEdge = x === 0 || x === width - 1 || y === 0 || y === height - 1
        grid.water[i] = onEdge ? 1 : 0
        grid.elev[i] = onEdge ? -10 : 10
      }
    }
    const riverCellIndex = 1 * width + 2 // coastal (top row is sea at y=0)
    grid.river[riverCellIndex] = 2
    grid.flow[riverCellIndex] = 10000

    const mapgen = {
      coast: { cliffSlopeRatio: 0.9, shelterRadiusMiles: 24, rayMaxMiles: 20, bayShelterThreshold: 0.6, portRiverFlowThreshold: 500, harbourMinSpacingMiles: 40, minEstuaryHarbours: 3, estuaryBonus: 0.3, shoreDepthSearchRadiusMiles: 8, shoreDepthScaleMetres: 80, shoreDepthWeight: 0.3, mudflatSlopeRatio: 0.02, mudflatShoreDepthMax: 0.15, mudflatPenalty: 0.3 },
      slope: { quantizationScale: 100 },
    }
    generateSlope(grid, mapgen.slope)
    generateCoast(grid, mapgen)

    expect(grid.coast[riverCellIndex] & COAST_FLAG.ESTUARY).toBeTruthy()
  })

  it('gives an enclosed cove cell higher shelter than an open-ocean cell', () => {
    // 11x11: a cove is a 3x3 pocket of sea cut into land on three
    // sides, open to the sea only from the top; the open-ocean cell
    // sits far from any land.
    const width = 21
    const height = 21
    const grid = createWorldGrid(width, height, 2)
    grid.water.fill(1)
    grid.elev.fill(-10)

    // A block of land with a notch (the cove) carved into its north edge.
    for (let y = 10; y < 20; y++) {
      for (let x = 5; x < 16; x++) {
        grid.water[y * width + x] = 0
        grid.elev[y * width + x] = 10
      }
    }
    // Carve the cove: a 3-wide, 3-deep pocket of sea back into the land block.
    for (let y = 10; y < 13; y++) {
      for (let x = 9; x < 12; x++) {
        grid.water[y * width + x] = 1
        grid.elev[y * width + x] = -10
      }
    }

    const mapgen = {
      coast: { cliffSlopeRatio: 0.9, shelterRadiusMiles: 24, rayMaxMiles: 20, bayShelterThreshold: 0.6, portRiverFlowThreshold: 500, harbourMinSpacingMiles: 40, minEstuaryHarbours: 3, estuaryBonus: 0.3, shoreDepthSearchRadiusMiles: 8, shoreDepthScaleMetres: 80, shoreDepthWeight: 0.3, mudflatSlopeRatio: 0.02, mudflatShoreDepthMax: 0.15, mudflatPenalty: 0.3 },
      slope: { quantizationScale: 100 },
    }
    generateSlope(grid, mapgen.slope)
    generateCoast(grid, mapgen)

    const coveCellIndex = 11 * width + 10 // inside the 3x3 cove pocket
    const openOceanIndex = 1 * width + 1 // far corner, away from all land

    expect(grid.shelter[coveCellIndex]).toBeGreaterThan(grid.shelter[openOceanIndex])
  })
})

describe('findBayRegions (synthetic grid)', () => {
  it('finds two separate sheltered regions', () => {
    const width = 7
    const height = 3
    const grid = { width, height, water: new Uint8Array(width * height).fill(1), shelter: new Uint8Array(width * height) }

    // Two sheltered (shelter > threshold) 2-cell pockets, separated by an unsheltered gap.
    grid.shelter[1 * width + 0] = 200
    grid.shelter[1 * width + 1] = 200
    grid.shelter[1 * width + 3] = 10 // gap, below threshold
    grid.shelter[1 * width + 5] = 200
    grid.shelter[1 * width + 6] = 200

    const regions = findBayRegions(grid, 0.6)
    regions.sort((a, b) => b.length - a.length)

    expect(regions).toHaveLength(2)
    expect(regions[0]).toHaveLength(2)
    expect(regions[1]).toHaveLength(2)
  })

  it('returns nothing when no sea cell clears the threshold', () => {
    const width = 4
    const height = 4
    const grid = { width, height, water: new Uint8Array(width * height).fill(1), shelter: new Uint8Array(width * height) }
    expect(findBayRegions(grid, 0.6)).toHaveLength(0)
  })
})

describe('selectHarbourCandidates (synthetic candidates)', () => {
  const coastParams = { harbourMinSpacingMiles: 40, minEstuaryHarbours: 3 }
  const grid = { cellMiles: 2, coast: new Uint8Array(200) }

  it('picks the highest-scoring candidates respecting spacing', () => {
    const candidates = [
      { index: 0, x: 0, y: 0, score: 1.0, isEstuary: false },
      { index: 1, x: 5, y: 0, score: 0.9, isEstuary: false }, // 10mi away: too close to (0,0)
      { index: 2, x: 30, y: 0, score: 0.8, isEstuary: false }, // 60mi away: fine
    ]
    const selected = selectHarbourCandidates(grid, candidates, coastParams)
    expect(selected.map((c) => c.index).sort()).toEqual([0, 2])
  })

  it('tops up estuary representation by evicting a conflicting non-estuary site', () => {
    // Candidate 10 (estuary) is close to already-selected candidate 0
    // (non-estuary, higher score) and nothing else; with only one
    // other estuary in range, the natural selection has 1 estuary, so
    // candidate 10 must evict candidate 0 to reach the minimum of 2.
    const candidates = [
      { index: 0, x: 0, y: 0, score: 1.0, isEstuary: false },
      { index: 1, x: 30, y: 0, score: 0.9, isEstuary: true },
      { index: 2, x: 2, y: 0, score: 0.5, isEstuary: true }, // 4mi from candidate 0: conflicts
    ]
    const selected = selectHarbourCandidates(grid, candidates, { ...coastParams, minEstuaryHarbours: 2 })

    expect(selected.some((c) => c.index === 2)).toBe(true) // the estuary got in
    expect(selected.some((c) => c.index === 0)).toBe(false) // by evicting the conflicting non-estuary
    expect(selected.filter((c) => c.isEstuary)).toHaveLength(2)
  })

  it('never evicts one estuary to make room for another', () => {
    const candidates = [
      { index: 0, x: 0, y: 0, score: 1.0, isEstuary: true },
      { index: 1, x: 2, y: 0, score: 0.5, isEstuary: true }, // 4mi away: conflicts, but both are estuaries
    ]
    const selected = selectHarbourCandidates(grid, candidates, { ...coastParams, minEstuaryHarbours: 2 })

    // Cannot reach 2 estuaries without violating spacing between two
    // estuaries, which the eviction rule forbids, so only the
    // higher-scoring one is kept.
    expect(selected).toHaveLength(1)
    expect(selected[0].index).toBe(0)
  })

  it('flags every selected cell as a harbour candidate on the grid', () => {
    const freshGrid = { cellMiles: 2, coast: new Uint8Array(10) }
    const candidates = [{ index: 3, x: 0, y: 0, score: 1.0, isEstuary: false }]
    selectHarbourCandidates(freshGrid, candidates, coastParams)
    expect(freshGrid.coast[3] & COAST_FLAG.HARBOUR_CANDIDATE).toBeTruthy()
  })
})
