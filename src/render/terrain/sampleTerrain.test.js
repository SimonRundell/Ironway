import { describe, expect, it } from 'vitest'
import { createWorldGrid, indexOf } from '../../sim/mapgen/grid.js'
import { buildRiverFields } from './riverField.js'
import { buildLanduseColourLookup, buildSeasonContext, hexToRgb, sampleTerrainPixel } from './sampleTerrain.js'

const LANDUSE_ENUM = ['sea', 'lake', 'arable', 'mixed', 'pastoral', 'forest', 'moor', 'marsh', 'rock']
const PALETTE_LANDUSE = {
  sea: '#3b6a86', lake: '#5f8fa6', arable: '#c9b15a', mixed: '#a9b85c',
  pastoral: '#8bb35a', forest: '#3f6b3a', moor: '#8a7a5c', marsh: '#6b7a5c', rock: '#8a8478',
}
const LANDUSE_COLOURS = buildLanduseColourLookup(LANDUSE_ENUM, PALETTE_LANDUSE)
const FOREST = LANDUSE_ENUM.indexOf('forest')
const SEA = LANDUSE_ENUM.indexOf('sea')

const BASE_PALETTE = {
  hillshade: { lightX: -0.55, lightY: -0.55, lightZ: 0.62, strength: 0.4, reliefScale: 0.015 },
  seaDepth: { shallow: '#5f94ab', deep: '#1f3a4d', depthScaleMetres: 60 },
  foam: { colour: '#e8f2ee', widthMiles: 0.35 },
  coastline: '#2b2620',
  river: '#5f8fa6',
  fineLandCover: { minPpm: 24 },
  textureNoise: { strength: 0, scaleMiles: 0.5 }, // off for exact-colour assertions
}

const SEASONS_RULES = {
  tintStrength: 0.06,
  monthlyTintColours: [
    '#8fa6bf', '#97a8ba', '#a9bb86', '#bcc978', '#cdd176',
    '#dccd6c', '#e0c45e', '#dba84e', '#cf8f49', '#bf7c4a',
    '#9c8577', '#8894ac',
  ],
  snowLineMetres: 900,
  snowFadeRangeMetres: 150,
  snowColour: '#eef3f5',
  snowMonths: [11, 0, 1],
  harvestMonths: [7, 8, 9],
  harvestColour: '#c9932f',
  harvestStrength: 0.35,
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

/** Mirrors sampleTerrain.js's own sea-colour tinting (depth ramp blended 35% toward the raw land-use colour), so tests can predict the exact expected colour for a water cell whose `landuse` is set correctly. */
function lerpRgbForTest(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
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

  it('deep sea far from any coast matches the deep end of the sea-depth ramp, tinted toward the sea land-use colour', () => {
    const grid = makeFlatGrid({ elev: new Int16Array(100).fill(-200), landuse: new Uint8Array(100).fill(SEA) }) // well past depthScaleMetres
    const sdf = new Float32Array(100).fill(-5)
    const colour = sampleTerrainPixel({
      grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
    })
    const expected = lerpRgbForTest(hexToRgb(BASE_PALETTE.seaDepth.deep), hexToRgb(PALETTE_LANDUSE.sea), 0.35)
    expect(colourDistance(colour, expected)).toBeLessThan(2)
  })

  it('shallow sea near the coast is lighter than deep sea far from it', () => {
    const grid = makeFlatGrid({ elev: new Int16Array(100).fill(-5), landuse: new Uint8Array(100).fill(SEA) })
    const sdf = new Float32Array(100).fill(-1)
    const shallow = sampleTerrainPixel({
      grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
    })
    const deepGrid = makeFlatGrid({ elev: new Int16Array(100).fill(-200), landuse: new Uint8Array(100).fill(SEA) })
    const deepSdf = new Float32Array(100).fill(-5)
    const deep = sampleTerrainPixel({
      grid: deepGrid, sdf: deepSdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
    })
    const brightness = (c) => c.r + c.g + c.b
    expect(brightness(shallow)).toBeGreaterThan(brightness(deep))
  })

  it('a lake reads a different hue from the open sea at the same depth (DESIGN 9.4\'s distinct lake/sea palette entries)', () => {
    const sdf = new Float32Array(100).fill(-5)
    const elev = new Int16Array(100).fill(-20)
    const seaGrid = makeFlatGrid({ elev, landuse: new Uint8Array(100).fill(SEA) })
    const lakeGrid = makeFlatGrid({ elev, landuse: new Uint8Array(100).fill(LANDUSE_ENUM.indexOf('lake')) })
    const sea = sampleTerrainPixel({ grid: seaGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
    const lake = sampleTerrainPixel({ grid: lakeGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
    expect(colourDistance(sea, lake)).toBeGreaterThan(5)
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

  describe('rivers (PHASES.md T2.05)', () => {
    const sdf = new Float32Array(100).fill(5) // land everywhere, well inside

    it('is unaffected by river fields when they are omitted entirely (back-compat with T2.04 callers)', () => {
      const grid = makeFlatGrid()
      const withoutRivers = sampleTerrainPixel({ grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
      const zeroRiverDistance = new Float32Array(100).fill(0)
      const zeroRiverHalfWidth = new Float32Array(100).fill(0) // a half-width of 0 everywhere means "no river anywhere"
      const withZeroRivers = sampleTerrainPixel({
        grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE,
        riverDistance: zeroRiverDistance, riverHalfWidth: zeroRiverHalfWidth,
      })
      expect(withZeroRivers).toEqual(withoutRivers)
    })

    it('paints the river colour right on the centreline and fades it out by the half-width', () => {
      const grid = makeFlatGrid()
      const riverDistance = new Float32Array(100).fill(99) // "no river anywhere" by default
      const riverHalfWidth = new Float32Array(100).fill(0.3)
      for (let x = 0; x < 10; x++) riverDistance[5 * 10 + x] = Math.abs(x - 5) // centreline at x = 5, row y = 5

      const onCentreline = sampleTerrainPixel({
        grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, riverDistance, riverHalfWidth,
      })
      const farFromRiver = sampleTerrainPixel({
        grid, sdf, worldX: 5, worldY: 0, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, riverDistance, riverHalfWidth,
      })
      expect(colourDistance(onCentreline, hexToRgb(BASE_PALETTE.river))).toBeLessThan(2)
      expect(colourDistance(farFromRiver, hexToRgb(PALETTE_LANDUSE.forest))).toBeLessThan(2)
    })

    it('never renders thinner than the minimum screen width, however thin the actual river class', () => {
      const grid = makeFlatGrid()
      const riverDistance = new Float32Array(100).fill(99)
      const riverHalfWidth = new Float32Array(100).fill(0.001) // a class-1 stream's true half-width is a fraction of this
      for (let x = 0; x < 10; x++) riverDistance[5 * 10 + x] = Math.abs(x - 5)

      // At a very low ppm (fully zoomed out), 0.001mi true half-width is
      // far under a pixel; without a floor this would barely tint the
      // centreline pixel at all.
      const lowPpm = sampleTerrainPixel({
        grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, riverDistance, riverHalfWidth, ppm: 2,
      })
      expect(colourDistance(lowPpm, hexToRgb(BASE_PALETTE.river))).toBeLessThan(2)
    })

    it('does not pinch shut at a diagonal jog in the river path (a D8-traced path\'s normal shape)', () => {
      // A 1-cell-wide river stepping diagonally, exactly as a D8
      // flow-direction trace produces: (0,0) -> (1,1) -> (2,2).
      const grid = createWorldGrid(4, 4, 1)
      grid.river[indexOf(grid, 0, 0)] = 3
      grid.river[indexOf(grid, 1, 1)] = 3
      grid.river[indexOf(grid, 2, 2)] = 3
      const { riverDistance, riverHalfWidth } = buildRiverFields(grid, { milesPerClass: 0.15, estuaryBoost: 1 })

      const renderGrid = { width: 4, height: 4, cellMiles: 1, elev: new Int16Array(16), landuse: new Uint8Array(16).fill(FOREST), soil: new Uint8Array(16).fill(128), rain: new Uint8Array(16).fill(128) }
      const flatSdf = new Float32Array(16).fill(5)

      // The centre of the square between (0,0) and (1,1) is exactly
      // where plain bilinear interpolation of the distance field (0 at
      // each river corner, a full cell at the two non-river corners)
      // saddles to its worst case, roughly half a cell away — enough to
      // exceed a thin river's half-width and pinch the line shut.
      const midpoint = sampleTerrainPixel({ grid: renderGrid, sdf: flatSdf, worldX: 0.5, worldY: 0.5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, riverDistance, riverHalfWidth })
      expect(colourDistance(midpoint, hexToRgb(BASE_PALETTE.river))).toBeLessThan(2)
    })

    it('has no discontinuity at the river bank (continuous distance/half-width fields, same technique as the coastline)', () => {
      const grid = makeFlatGrid({ width: 1, height: 1, elev: new Int16Array(1), landuse: new Uint8Array(1).fill(FOREST), soil: new Uint8Array(1).fill(128), rain: new Uint8Array(1).fill(128) })
      const flatSdf = new Float32Array(1).fill(5)
      const riverDistance = new Float32Array(1).fill(0.3) // exactly at the bank (distance == half-width)
      const riverHalfWidth = new Float32Array(1).fill(0.3)

      const sample = (distance) => {
        riverDistance[0] = distance
        return sampleTerrainPixel({ grid, sdf: flatSdf, worldX: 0, worldY: 0, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, riverDistance, riverHalfWidth })
      }
      const justInside = sample(0.3 - 1e-4)
      const justOutside = sample(0.3 + 1e-4)
      expect(colourDistance(justInside, justOutside)).toBeLessThan(1)
    })
  })

  describe('fine land cover (PHASES.md T2.05, DESIGN 9.4\'s "ppm >= 24")', () => {
    it('does not vary with position below the ppm threshold', () => {
      const grid = makeFlatGrid()
      const sdf = new Float32Array(100).fill(5)
      const a = sampleTerrainPixel({ grid, sdf, worldX: 5.0, worldY: 5.0, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM, ppm: 12 })
      const b = sampleTerrainPixel({ grid, sdf, worldX: 5.3, worldY: 5.1, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM, ppm: 12 })
      expect(a).toEqual(b)
    })

    it('does vary with position at or above the ppm threshold (forest tree glyphs)', () => {
      const grid = makeFlatGrid()
      const sdf = new Float32Array(100).fill(5)
      const colours = []
      // A full 2D patch, not one fixed row: a tree glyph's jittered centre
      // could sit anywhere within its scatter cell, so only scanning one
      // row risks missing every glyph in range by chance (y just outside
      // every nearby dot's radius) without this test saying anything
      // false about the renderer itself.
      for (let x = 3; x < 8; x += 0.3) {
        for (let y = 3; y < 8; y += 0.3) {
          colours.push(sampleTerrainPixel({ grid, sdf, worldX: x, worldY: y, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM, ppm: 24 }))
        }
      }
      const distinctValues = new Set(colours.map((c) => `${c.r},${c.g},${c.b}`))
      expect(distinctValues.size).toBeGreaterThan(1)
    })

    it('is skipped when landuseEnum is omitted, even if ppm is above the threshold', () => {
      const grid = makeFlatGrid()
      const sdf = new Float32Array(100).fill(5)
      const withoutEnum = sampleTerrainPixel({ grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, ppm: 48 })
      const withoutPpmOrEnum = sampleTerrainPixel({ grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
      expect(withoutEnum).toEqual(withoutPpmOrEnum)
    })

    it('is deterministic at high ppm (same inputs, same scattered texture)', () => {
      const grid = makeFlatGrid()
      const sdf = new Float32Array(100).fill(5)
      const options = { grid, sdf, worldX: 5.4, worldY: 5.6, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM, ppm: 60 }
      expect(sampleTerrainPixel(options)).toEqual(sampleTerrainPixel(options))
    })
  })

  describe('seasons (PHASES.md T2.13)', () => {
    const sdf = new Float32Array(100).fill(5) // well inside land everywhere

    it('a season-less call (no `season` option) is byte-identical to passing one built with no monthIndex (both mean "seasons off")', () => {
      const grid = makeFlatGrid()
      const withoutSeason = sampleTerrainPixel({ grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
      const withNullSeason = sampleTerrainPixel({ grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, season: buildSeasonContext(SEASONS_RULES, undefined) })
      expect(withNullSeason).toEqual(withoutSeason)
    })

    it('a subtle monthly tint shifts the final colour, in and out of season', () => {
      const grid = makeFlatGrid()
      const noSeason = sampleTerrainPixel({ grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
      const july = sampleTerrainPixel({ grid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, season: buildSeasonContext(SEASONS_RULES, 6) })
      expect(colourDistance(july, noSeason)).toBeGreaterThan(0)
      expect(colourDistance(july, noSeason)).toBeLessThan(40) // "subtle", not a wholesale recolour
    })

    it('blends toward the snow colour above the snow line in a snow month, and not below it', () => {
      const highGrid = makeFlatGrid({ landuse: new Uint8Array(100).fill(LANDUSE_ENUM.indexOf('moor')), elev: new Int16Array(100).fill(1200) })
      const lowGrid = makeFlatGrid({ landuse: new Uint8Array(100).fill(LANDUSE_ENUM.indexOf('moor')), elev: new Int16Array(100).fill(50) })
      const january = buildSeasonContext(SEASONS_RULES, 0)

      const high = sampleTerrainPixel({ grid: highGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, season: january })
      const low = sampleTerrainPixel({ grid: lowGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, season: january })
      const highNoSeason = sampleTerrainPixel({ grid: highGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })
      const lowNoSeason = sampleTerrainPixel({ grid: lowGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE })

      expect(colourDistance(high, hexToRgb(SEASONS_RULES.snowColour))).toBeLessThan(colourDistance(highNoSeason, hexToRgb(SEASONS_RULES.snowColour)))
      // Below the snow line, only the small whole-scene tint should move
      // the colour — far less than the high-elevation cell, which gets
      // that same tint *plus* a real blend toward the snow colour.
      expect(colourDistance(low, lowNoSeason)).toBeLessThan(colourDistance(high, highNoSeason) / 2)
    })

    it('does not snow outside a snow month, even high above the snow line', () => {
      const highGrid = makeFlatGrid({ landuse: new Uint8Array(100).fill(LANDUSE_ENUM.indexOf('moor')), elev: new Int16Array(100).fill(1200) })
      const july = buildSeasonContext(SEASONS_RULES, 6)
      const coloured = sampleTerrainPixel({ grid: highGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, season: july })
      expect(colourDistance(coloured, hexToRgb(SEASONS_RULES.snowColour))).toBeGreaterThan(50)
    })

    it('tints arable gold in a harvest month, but leaves pastoral untouched', () => {
      const arableGrid = makeFlatGrid({ landuse: new Uint8Array(100).fill(LANDUSE_ENUM.indexOf('arable')) })
      const pastoralGrid = makeFlatGrid({ landuse: new Uint8Array(100).fill(LANDUSE_ENUM.indexOf('pastoral')) })
      const august = buildSeasonContext(SEASONS_RULES, 7)

      const arable = sampleTerrainPixel({ grid: arableGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM, season: august })
      const arableNoSeason = sampleTerrainPixel({ grid: arableGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM })
      const pastoral = sampleTerrainPixel({ grid: pastoralGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM, season: august })
      const pastoralNoSeason = sampleTerrainPixel({ grid: pastoralGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM })

      expect(colourDistance(arable, hexToRgb(SEASONS_RULES.harvestColour))).toBeLessThan(colourDistance(arableNoSeason, hexToRgb(SEASONS_RULES.harvestColour)))
      // Pastoral isn't the harvest rule's target class: only the shared whole-scene tint should separate it from its own no-season colour.
      expect(colourDistance(pastoral, pastoralNoSeason)).toBeLessThan(15)
    })

    it('does not tint arable gold outside a harvest month', () => {
      const arableGrid = makeFlatGrid({ landuse: new Uint8Array(100).fill(LANDUSE_ENUM.indexOf('arable')) })
      const january = buildSeasonContext(SEASONS_RULES, 0)
      const arable = sampleTerrainPixel({ grid: arableGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM, season: january })
      const arableNoSeason = sampleTerrainPixel({ grid: arableGrid, sdf, worldX: 5, worldY: 5, landuseColours: LANDUSE_COLOURS, palette: BASE_PALETTE, landuseEnum: LANDUSE_ENUM })
      // Only the whole-scene January tint should separate them, not the harvest blend.
      expect(colourDistance(arable, arableNoSeason)).toBeLessThan(15)
    })
  })
})

describe('buildSeasonContext', () => {
  it('returns null when there is no seasons block at all', () => {
    expect(buildSeasonContext(undefined, 5)).toBeNull()
  })

  it('returns null when no month is given, even with a valid seasons block (the HUD toggle being off)', () => {
    expect(buildSeasonContext(SEASONS_RULES, undefined)).toBeNull()
  })

  it('flags snowActive only for months in snowMonths', () => {
    expect(buildSeasonContext(SEASONS_RULES, 0).snowActive).toBe(true) // January
    expect(buildSeasonContext(SEASONS_RULES, 11).snowActive).toBe(true) // December
    expect(buildSeasonContext(SEASONS_RULES, 6).snowActive).toBe(false) // July
  })

  it('flags harvestActive only for months in harvestMonths', () => {
    expect(buildSeasonContext(SEASONS_RULES, 8).harvestActive).toBe(true) // September
    expect(buildSeasonContext(SEASONS_RULES, 0).harvestActive).toBe(false) // January
  })

  it('is deterministic for the same month', () => {
    expect(buildSeasonContext(SEASONS_RULES, 4)).toEqual(buildSeasonContext(SEASONS_RULES, 4))
  })
})
