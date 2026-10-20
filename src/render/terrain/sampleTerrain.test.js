import { describe, expect, it } from 'vitest'
import { buildLanduseColourLookup, hexToRgb, sampleTerrainPixel } from './sampleTerrain.js'

const LANDUSE_ENUM = ['sea', 'lake', 'arable', 'mixed', 'pastoral', 'forest', 'moor', 'marsh', 'rock']
const PALETTE_LANDUSE = {
  sea: '#3b6a86', lake: '#5f8fa6', arable: '#c9b15a', mixed: '#a9b85c',
  pastoral: '#8bb35a', forest: '#3f6b3a', moor: '#8a7a5c', marsh: '#6b7a5c', rock: '#8a8478',
}
const LANDUSE_COLOURS = buildLanduseColourLookup(LANDUSE_ENUM, PALETTE_LANDUSE)
const FOREST = LANDUSE_ENUM.indexOf('forest')

const BASE_PALETTE = {
  hillshade: { lightX: -0.55, lightY: -0.55, lightZ: 0.62, strength: 0.4, reliefScale: 0.015 },
  seaDepth: { shallow: '#5f94ab', deep: '#1f3a4d', depthScaleMetres: 60 },
  foam: { colour: '#e8f2ee', widthMiles: 0.35 },
  coastline: '#2b2620',
  textureNoise: { strength: 0, scaleMiles: 0.5 }, // off for exact-colour assertions
}

/**
 * @param {object} [overrides]
 * @returns {object} A flat 10x10 grid (cellMiles = 1): all forest, all land, elevation 0.
 */
function makeFlatGrid(overrides = {}) {
  const width = 10
  const height = 10
  const size = width * height
  return {
    width,
    height,
    cellMiles: 1,
    elev: new Int16Array(size).fill(0),
    landuse: new Uint8Array(size).fill(FOREST),
    soil: new Uint8Array(size).fill(128),
    rain: new Uint8Array(size).fill(128),
    ...overrides,
  }
}

function colourDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

describe('sampleTerrainPixel', () => {
  it('is deterministic: the same inputs always produce the same colour', () => {
    const grid = makeFlatGrid()
    const sdf = new Float32Array(100).fill(5)
    const palette = { ...BASE_PALETTE, textureNoise: { strength: 0.05, scaleMiles: 0.5 } }
    const options = { grid, sdf, worldX: 3.2, worldY: 4.7, landuseColours: LANDUSE_COLOURS, palette }

    expect(sampleTerrainPixel(options)).toEqual(sampleTerrainPixel(options))
  })

  it('flat inland land far from the coast matches its land-use colour (soil/rain at neutral, no gradient, no noise)', () => {
    const grid = makeFlatGrid()
    const sdf = new Float32Array(100).fill(5) // well inside land everywhere
    const colour = sampleTerrainPixel({
      grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
    })
    expect(colourDistance(colour, hexToRgb(PALETTE_LANDUSE.forest))).toBeLessThan(2)
  })

  it('deep sea far from any coast matches the deep end of the sea-depth ramp', () => {
    const grid = makeFlatGrid({ elev: new Int16Array(100).fill(-200) }) // well past depthScaleMetres
    const sdf = new Float32Array(100).fill(-5)
    const colour = sampleTerrainPixel({
      grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
    })
    expect(colourDistance(colour, hexToRgb(BASE_PALETTE.seaDepth.deep))).toBeLessThan(2)
  })

  it('shallow sea near the coast is lighter than deep sea far from it', () => {
    const grid = makeFlatGrid({ elev: new Int16Array(100).fill(-5) })
    const sdf = new Float32Array(100).fill(-1)
    const shallow = sampleTerrainPixel({
      grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
    })
    const deepGrid = makeFlatGrid({ elev: new Int16Array(100).fill(-200) })
    const deepSdf = new Float32Array(100).fill(-5)
    const deep = sampleTerrainPixel({
      grid: deepGrid, sdf: deepSdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
    })
    const brightness = (c) => c.r + c.g + c.b
    expect(brightness(shallow)).toBeGreaterThan(brightness(deep))
  })

  it('has no discontinuity exactly at the coastline (the land/sea blend and the foam band must meet, not snap)', () => {
    const grid = makeFlatGrid()
    const width = 40
    const sdf = new Float32Array(width)
    for (let x = 0; x < width; x++) sdf[x] = x - 20 // crosses zero at x = 20
    const wideGrid = { ...grid, width, height: 1, elev: new Int16Array(width).fill(-10), landuse: new Uint8Array(width).fill(FOREST), soil: new Uint8Array(width).fill(128), rain: new Uint8Array(width).fill(128) }

    const sample = (worldX) => sampleTerrainPixel({ grid: wideGrid, sdf, worldX, worldY: 0, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })

    // A tiny step straddling sdf = 0 (worldX = 20) should produce a
    // tiny colour change. A one-sided threshold (e.g. foam that is "on"
    // for sdf <= 0 and "off" the instant sdf > 0) would instead show a
    // fixed-size jump no matter how small the step gets.
    const justSea = sample(20 - 1e-4)
    const justLand = sample(20 + 1e-4)
    expect(colourDistance(justSea, justLand)).toBeLessThan(1)
  })

  it('blends across the coastline rather than stepping between its two sides', () => {
    const grid = makeFlatGrid()
    const width = 40
    const sdf = new Float32Array(width)
    for (let x = 0; x < width; x++) sdf[x] = x - 20
    const wideGrid = { ...grid, width, height: 1, elev: new Int16Array(width).fill(-10), landuse: new Uint8Array(width).fill(FOREST), soil: new Uint8Array(width).fill(128), rain: new Uint8Array(width).fill(128) }

    const colours = []
    for (let x = 15; x <= 25; x += 0.02) {
      colours.push(sampleTerrainPixel({ grid: wideGrid, sdf, worldX: x, worldY: 0, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE }))
    }
    // Every intermediate colour is a genuine blend, not a repeat of
    // one of the two endpoints (i.e. it isn't just stepping between
    // "sea" and "land" with nothing in between).
    const sea = colours[0]
    const land = colours[colours.length - 1]
    const midpoint = colours[Math.floor(colours.length / 2)]
    expect(colourDistance(midpoint, sea)).toBeGreaterThan(5)
    expect(colourDistance(midpoint, land)).toBeGreaterThan(5)
    expect(colourDistance(sea, land)).toBeGreaterThan(30)
  })

  it('hillshade makes a slope facing the light brighter than one facing away', () => {
    const width = 3
    const height = 3
    const sdf = new Float32Array(width * height).fill(5)
    const soil = new Uint8Array(width * height).fill(128)
    const rain = new Uint8Array(width * height).fill(128)
    const landuse = new Uint8Array(width * height).fill(FOREST)

    // The light comes from the north-west. A surface whose normal
    // tilts toward the light (elevation rising toward the south-east,
    // since normal = (-dz/dx, -dz/dy, 1)) faces it; the opposite slope
    // faces away.
    const towardLight = { width, height, cellMiles: 1, elev: Int16Array.from([-200, -100, 0, -100, 0, 100, 0, 100, 200]), landuse, soil, rain }
    const awayFromLight = { width, height, cellMiles: 1, elev: Int16Array.from([200, 100, 0, 100, 0, -100, 0, -100, -200]), landuse, soil, rain }

    const bright = sampleTerrainPixel({ grid: towardLight, sdf, worldX: 1, worldY: 1, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
    const dark = sampleTerrainPixel({ grid: awayFromLight, sdf, worldX: 1, worldY: 1, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
    const brightness = (c) => c.r + c.g + c.b
    expect(brightness(bright)).toBeGreaterThan(brightness(dark))
  })
})
