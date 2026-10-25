import { fbm2D, valueNoise2D } from '../../sim/noise.js'

/**
 * Per-pixel terrain colour sampling (DESIGN 9.4, PHASES T2.04/T2.05):
 * bilinear elevation and land-use sampling for smooth relief with no
 * cell blockiness, hillshade from a north-west light, a sea depth
 * gradient, a signed-distance coastline with a foam band, soil/rain
 * tinting, rivers as variable-width curves, and (at `ppm >= 24`)
 * deterministic fine land cover — tree glyphs, hedgerows, pasture
 * patches, heather speckle, reeds. Pure maths over typed-array grid
 * layers and `Float32Array` fields (from `coastlineSdf.js` and
 * `riverField.js`) — no canvas, no worker — so it is unit testable
 * directly; `workers/tileWorker.js` is the only caller that actually
 * writes pixels with it.
 *
 * @module render/terrain/sampleTerrain
 */

/** @type {number} Fixed seed for the cosmetic texture-noise layer. Deliberately not tied to the world's own seed: the noise only breaks up flat colour, it is not part of the generator, so every world can share one constant. */
const TEXTURE_NOISE_SEED = 90125

/** @type {number} Fixed seed for the forest tree-glyph scatter. */
const TREE_SEED = 40503
/** @type {number} Fixed seed for the moor heather-speckle scatter. */
const HEATHER_SEED = 61009
/** @type {number} Fixed seed for the pastoral patch noise. */
const PASTURE_PATCH_SEED = 71511

/** @type {number} A river's rendered width never drops below this many screen pixels, regardless of its actual width class or the current zoom. A class-1 headwater stream's true width (fractions of a world mile) becomes sub-pixel at Region/Area zoom without this, which reads as a dashed, broken line rather than DESIGN 9.4's smooth curve — the same "minimum line weight" convention a hand-drawn atlas uses for its thinnest rivers. */
const MIN_RIVER_SCREEN_PIXELS = 1.5

/**
 * Caches the few `hexToRgb()` conversions a palette needs, keyed on
 * the palette object itself: `sampleTerrainPixel()` runs once per
 * pixel (up to 512x512 times per tile), and re-parsing the same four
 * hex strings on every single pixel showed up as a measurable cost
 * under the tile pipeline's stress test (PHASES.md T2.03's scripted
 * sweep) once real per-pixel sampling replaced the old placeholder
 * fill. A `WeakMap` means a new palette (a reload, a different world)
 * is never served another palette's stale colours.
 *
 * @type {WeakMap<object, {seaShallow: object, seaDeep: object, foam: object, coastline: object, river: object}>}
 */
const paletteColourCache = new WeakMap()

/**
 * @param {object} palette The validated `palette.json` rules.
 * @returns {{seaShallow: {r,g,b}, seaDeep: {r,g,b}, foam: {r,g,b}, coastline: {r,g,b}, river: {r,g,b}}}
 */
function getPaletteColours(palette) {
  let colours = paletteColourCache.get(palette)
  if (!colours) {
    colours = {
      seaShallow: hexToRgb(palette.seaDepth.shallow),
      seaDeep: hexToRgb(palette.seaDepth.deep),
      foam: hexToRgb(palette.foam.colour),
      coastline: hexToRgb(palette.coastline),
      river: hexToRgb(palette.river),
    }
    paletteColourCache.set(palette, colours)
  }
  return colours
}

/**
 * @param {number} value
 * @returns {number} `value` clamped to [0, 1].
 */
function clamp01(value) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * @param {number} value
 * @returns {number} `value` clamped and rounded to a byte, 0 to 255.
 */
function clampByte(value) {
  if (value < 0) return 0
  if (value > 255) return 255
  return Math.round(value)
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * Hermite smoothstep, used to turn a hard threshold (is this pixel
 * land or sea, is it within the foam band) into a short antialiased
 * ramp instead of a one-pixel-wide step.
 *
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number} 0 at or before `edge0`, 1 at or after `edge1`.
 */
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * @param {string} hex e.g. `"#3b6a86"`.
 * @returns {{r: number, g: number, b: number}}
 */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/**
 * @param {{r: number, g: number, b: number}} a
 * @param {{r: number, g: number, b: number}} b
 * @param {number} t
 * @returns {{r: number, g: number, b: number}}
 */
function lerpRgb(a, b, t) {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) }
}

/**
 * Builds a landuse-enum-indexed colour lookup from `palette.json`'s
 * `landuse` block and `terrain.json`'s `landuseEnum`, so the hot
 * per-pixel sampling path never parses a hex string.
 *
 * @param {string[]} landuseEnum terrain.json's `landuseEnum`.
 * @param {Record<string, string>} paletteLanduse palette.json's `landuse` colours, by name.
 * @returns {{r: number, g: number, b: number}[]} Index-matched to `landuseEnum`.
 */
export function buildLanduseColourLookup(landuseEnum, paletteLanduse) {
  return landuseEnum.map((name) => hexToRgb(paletteLanduse[name] ?? '#888888'))
}

/**
 * Bilinearly samples a flat typed-array grid layer at fractional cell
 * coordinates, clamping to the grid edge rather than reading out of
 * bounds (DESIGN 9.4's "bilinear sample... for smooth relief").
 *
 * @param {Int16Array|Uint8Array|Float32Array} layer
 * @param {number} width
 * @param {number} height
 * @param {number} gx Fractional cell x.
 * @param {number} gy Fractional cell y.
 * @returns {number}
 */
/**
 * Samples a flat typed-array grid layer at fractional cell coordinates
 * by taking the *minimum* of the 4 surrounding cells, not interpolating
 * between them. Used for `riverField.js`'s distance field: a 1-cell-wide
 * river that jogs diagonally (the norm for a D8-traced path) has a
 * saddle point exactly between two diagonally-adjacent river cells
 * where plain bilinear interpolation of their distance values — 0 at
 * each river cell, but up to a full cell's worth at the two *other*
 * corners of that same square — averages out to a value larger than a
 * thin river's half-width, pinching the rendered line to nothing right
 * at every diagonal step. Taking the minimum instead means a point is
 * never considered farther from the river than its closest actual
 * neighbour, which removes the pinch entirely; the antialiased edge
 * still comes from the smoothstep against half-width where this value
 * is used, not from this sampling step.
 *
 * @param {Float32Array} layer
 * @param {number} width
 * @param {number} height
 * @param {number} gx Fractional cell x.
 * @param {number} gy Fractional cell y.
 * @returns {number}
 */
function minCornerSample(layer, width, height, gx, gy) {
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const cx0 = Math.min(Math.max(x0, 0), width - 1)
  const cy0 = Math.min(Math.max(y0, 0), height - 1)
  const cx1 = Math.min(Math.max(x0 + 1, 0), width - 1)
  const cy1 = Math.min(Math.max(y0 + 1, 0), height - 1)

  const v00 = layer[cy0 * width + cx0]
  const v10 = layer[cy0 * width + cx1]
  const v01 = layer[cy1 * width + cx0]
  const v11 = layer[cy1 * width + cx1]
  return Math.min(v00, v10, v01, v11)
}

/**
 * Bilinearly samples a flat typed-array grid layer at fractional cell
 * coordinates, clamping to the grid edge rather than reading out of
 * bounds (DESIGN 9.4's "bilinear sample... for smooth relief").
 *
 * @param {Int16Array|Uint8Array|Float32Array} layer
 * @param {number} width
 * @param {number} height
 * @param {number} gx Fractional cell x.
 * @param {number} gy Fractional cell y.
 * @returns {number}
 */
export function bilinearSample(layer, width, height, gx, gy) {
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const tx = gx - x0
  const ty = gy - y0
  const cx0 = Math.min(Math.max(x0, 0), width - 1)
  const cy0 = Math.min(Math.max(y0, 0), height - 1)
  const cx1 = Math.min(Math.max(x0 + 1, 0), width - 1)
  const cy1 = Math.min(Math.max(y0 + 1, 0), height - 1)

  const v00 = layer[cy0 * width + cx0]
  const v10 = layer[cy0 * width + cx1]
  const v01 = layer[cy1 * width + cx0]
  const v11 = layer[cy1 * width + cx1]

  const top = lerp(v00, v10, tx)
  const bottom = lerp(v01, v11, tx)
  return lerp(top, bottom, ty)
}

/**
 * Bilinearly blends the 4 surrounding cells' land-use colours (DESIGN
 * 9.4's "land-use blend"), rather than snapping to the nearest cell's
 * class, so adjacent-class boundaries fade smoothly instead of
 * stepping.
 *
 * @param {Uint8Array} landuse
 * @param {number} width
 * @param {number} height
 * @param {number} gx
 * @param {number} gy
 * @param {{r: number, g: number, b: number}[]} landuseColours From `buildLanduseColourLookup()`.
 * @returns {{r: number, g: number, b: number}}
 */
function bilinearLanduseColour(landuse, width, height, gx, gy, landuseColours) {
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const tx = gx - x0
  const ty = gy - y0
  const cx0 = Math.min(Math.max(x0, 0), width - 1)
  const cy0 = Math.min(Math.max(y0, 0), height - 1)
  const cx1 = Math.min(Math.max(x0 + 1, 0), width - 1)
  const cy1 = Math.min(Math.max(y0 + 1, 0), height - 1)

  const c00 = landuseColours[landuse[cy0 * width + cx0]]
  const c10 = landuseColours[landuse[cy0 * width + cx1]]
  const c01 = landuseColours[landuse[cy1 * width + cx0]]
  const c11 = landuseColours[landuse[cy1 * width + cx1]]

  return lerpRgb(lerpRgb(c00, c10, tx), lerpRgb(c01, c11, tx), ty)
}

/**
 * Hillshade from a north-west light (DESIGN 9.4), computed from the
 * elevation field's own local gradient (central differences on
 * bilinear-sampled elevation) rather than a precomputed normal map, so
 * it stays correct under arbitrary zoom and pan. Returned relative to
 * flat ground (gradient zero gives exactly 0, not the light's own
 * zenith angle), so a shade multiplier built from this never darkens
 * or brightens perfectly flat terrain.
 *
 * @param {object} grid
 * @param {number} gx
 * @param {number} gy
 * @param {{lightX: number, lightY: number, lightZ: number, reliefScale: number}} hillshadeRules palette.json's `hillshade` block.
 * @returns {number} 0 on flat ground; positive facing the light, negative facing away.
 */
function hillshadeDot(grid, gx, gy, hillshadeRules) {
  const { elev, width, height, cellMiles } = grid
  const eL = bilinearSample(elev, width, height, gx - 1, gy)
  const eR = bilinearSample(elev, width, height, gx + 1, gy)
  const eU = bilinearSample(elev, width, height, gx, gy - 1)
  const eD = bilinearSample(elev, width, height, gx, gy + 1)

  const dzdx = ((eR - eL) / (2 * cellMiles)) * hillshadeRules.reliefScale
  const dzdy = ((eD - eU) / (2 * cellMiles)) * hillshadeRules.reliefScale

  const nx = -dzdx
  const ny = -dzdy
  const nz = 1
  const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz)

  const { lightX, lightY, lightZ } = hillshadeRules
  const lightLength = Math.sqrt(lightX * lightX + lightY * lightY + lightZ * lightZ)

  const dot = (nx * lightX + ny * lightY + nz * lightZ) / (normalLength * lightLength)
  const flatDot = lightZ / lightLength // nx = ny = 0 on flat ground
  return dot - flatDot
}

/**
 * Deterministic cosmetic texture, so a flat colour field never looks
 * like a flat colour field (DESIGN 9.4's "small deterministic noise
 * for texture"). Two cheap fBm octaves only: this runs once per pixel,
 * and it is pure decoration, not a generation input.
 *
 * @param {number} worldX
 * @param {number} worldY
 * @param {{strength: number, scaleMiles: number}} textureNoiseRules palette.json's `textureNoise` block.
 * @returns {number} A multiplier close to 1 (1 - strength to 1 + strength).
 */
function textureNoiseMultiplier(worldX, worldY, textureNoiseRules) {
  const n = fbm2D(TEXTURE_NOISE_SEED, worldX / textureNoiseRules.scaleMiles, worldY / textureNoiseRules.scaleMiles, 2, 2, 0.5)
  return 1 + (n - 0.5) * 2 * textureNoiseRules.strength
}

/**
 * @param {{r: number, g: number, b: number}} colour
 * @param {number} factor
 * @returns {{r: number, g: number, b: number}}
 */
function scaleColour(colour, factor) {
  return { r: colour.r * factor, g: colour.g * factor, b: colour.b * factor }
}

/**
 * Positive-result modulo (`%` keeps the sign of its left operand in
 * JS), needed so a repeating pattern (hedgerow lines, reeds) reads the
 * same at negative world coordinates as it would if mirrored to positive.
 *
 * @param {number} value
 * @param {number} modulus
 * @returns {number}
 */
function floorMod(value, modulus) {
  return ((value % modulus) + modulus) % modulus
}

/**
 * A deterministic scatter of round "glyph" dots (DESIGN 9.4's tree
 * glyphs and heather speckle): world space is divided into a fixed-size
 * grid, each cell either has one jittered dot or none (`coverage`
 * controls the fraction that do), and a pixel's factor is how far
 * inside the dot it falls, smoothstepped for a soft edge. Deliberately
 * does not search neighbouring cells for a dot whose circle might
 * overlap this one (the usual full Worley-noise treatment): jitter and
 * radius are kept small relative to the cell so edge-clipping is rare,
 * trading a little organic irregularity for roughly a ninth of the
 * per-pixel cost. Built entirely from `worldX`/`worldY` (never a
 * tile-local coordinate), so the pattern is identical regardless of
 * which tile a pixel falls in — the Done-when's "no seams" requirement.
 *
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} seed
 * @param {number} cellMiles Size of one scatter cell.
 * @param {number} coverage Fraction of cells that contain a dot, 0 to 1.
 * @param {number} dotRadiusFraction Dot radius as a fraction of `cellMiles`.
 * @returns {number} 0 outside any dot, up to 1 at a dot's centre.
 */
function scatterDotFactor(worldX, worldY, seed, cellMiles, coverage, dotRadiusFraction) {
  const cx = Math.floor(worldX / cellMiles)
  const cy = Math.floor(worldY / cellMiles)

  const present = valueNoise2D(seed, cx, cy)
  if (present > coverage) return 0

  const jitterX = valueNoise2D(seed + 1, cx, cy)
  const jitterY = valueNoise2D(seed + 2, cx, cy)
  const centreX = (cx + 0.3 + jitterX * 0.4) * cellMiles
  const centreY = (cy + 0.3 + jitterY * 0.4) * cellMiles

  const dx = worldX - centreX
  const dy = worldY - centreY
  const dist = Math.sqrt(dx * dx + dy * dy)
  const radius = cellMiles * dotRadiusFraction
  return 1 - smoothstep(radius * 0.6, radius, dist)
}

/**
 * A repeating thin-line pattern (DESIGN 9.4's hedgerows and reeds):
 * lines run diagonally (`worldX + worldY`) spaced `spacingMiles` apart,
 * each `lineWidthMiles` wide with a smoothstepped edge.
 *
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} spacingMiles
 * @param {number} lineWidthMiles
 * @returns {number} 0 between lines, up to 1 exactly on a line.
 */
function lineStripeFactor(worldX, worldY, spacingMiles, lineWidthMiles) {
  const phase = floorMod(worldX + worldY, spacingMiles)
  const distanceToLine = Math.min(phase, spacingMiles - phase)
  return 1 - smoothstep(0, lineWidthMiles, distanceToLine)
}

/**
 * @param {string} hex A tint colour from `palette.json`'s `seasons.monthlyTintColours`.
 * @param {number} strength `seasons.tintStrength`.
 * @returns {{r: number, g: number, b: number}} A multiplier close to 1, the same idiom `textureNoiseMultiplier()` uses: each channel nudged toward (or away from) `hex`'s own channel value, scaled by `strength`.
 */
function seasonTintMultiplier(hex, strength) {
  const c = hexToRgb(hex)
  return {
    r: 1 + (c.r / 255 - 0.5) * 2 * strength,
    g: 1 + (c.g / 255 - 0.5) * 2 * strength,
    b: 1 + (c.b / 255 - 0.5) * 2 * strength,
  }
}

/**
 * Precomputes one tile-render's worth of seasonal rendering state from
 * `palette.json`'s optional `seasons` block and the sim's current
 * calendar month (PHASES.md T2.13: "subtle seasonal tint by month, snow
 * on high ground in winter, harvest colours on arable"). Called once per
 * tile render (`workers/tileWorker.js`), never once per pixel —
 * `sampleTerrainPixel()` runs up to 512x512 times per tile, so resolving
 * month-indexed arrays and parsing hex colours has to happen here, not
 * in the hot per-pixel path. A `null` return means "seasons off": every
 * per-pixel season branch below is skipped outright, matching this
 * project's established "no cost when off" idiom (`overlays.js`'s
 * `mode === 'none'`, `traffic.js`'s zoom-gate, both a single check
 * before any other work).
 *
 * @param {object} [seasonsRules] `palette.json`'s `seasons` block. Omitted (no block in a minimal test palette, or the feature not yet configured) disables seasons entirely.
 * @param {number} [monthIndex] 0-based calendar month (0 = January), from `sim/clock.js`'s `monthIndexOf()`. Omitted (the HUD toggle is off) disables seasons entirely, regardless of `seasonsRules`.
 * @returns {{tint: {r: number, g: number, b: number}, snowActive: boolean, snowLineMetres: number, snowFadeRangeMetres: number, snowColour: {r: number, g: number, b: number}, harvestActive: boolean, harvestColour: {r: number, g: number, b: number}, harvestStrength: number}|null}
 */
export function buildSeasonContext(seasonsRules, monthIndex) {
  if (!seasonsRules || monthIndex === undefined || monthIndex === null) return null
  return {
    tint: seasonTintMultiplier(seasonsRules.monthlyTintColours[monthIndex], seasonsRules.tintStrength),
    snowActive: seasonsRules.snowMonths.includes(monthIndex),
    snowLineMetres: seasonsRules.snowLineMetres,
    snowFadeRangeMetres: seasonsRules.snowFadeRangeMetres,
    snowColour: hexToRgb(seasonsRules.snowColour),
    harvestActive: seasonsRules.harvestMonths.includes(monthIndex),
    harvestColour: hexToRgb(seasonsRules.harvestColour),
    harvestStrength: seasonsRules.harvestStrength,
  }
}

/**
 * Applies DESIGN 9.4's `ppm >= 24` fine land cover for one land-use
 * class on top of an already-computed base colour: tree glyphs on
 * forest, hedgerow lines on arable, blotchy patches on pastoral,
 * heather speckle on moor, reed lines on marsh. Every other class is
 * unaffected (sea, lake and rock have no fine-cover treatment).
 *
 * @param {{r: number, g: number, b: number}} colour The colour so far.
 * @param {number} worldX
 * @param {number} worldY
 * @param {string} nearestLanduseName The land-use class name at the nearest grid cell (not bilinearly blended: a pattern needs one definite class to key off).
 * @returns {{r: number, g: number, b: number}}
 */
function applyFineLandCover(colour, worldX, worldY, nearestLanduseName) {
  switch (nearestLanduseName) {
    case 'forest': {
      const f = scatterDotFactor(worldX, worldY, TREE_SEED, 0.55, 0.6, 0.3)
      return scaleColour(colour, 1 - f * 0.25)
    }
    case 'arable': {
      const f = lineStripeFactor(worldX, worldY, 0.6, 0.05)
      return scaleColour(colour, 1 - f * 0.3)
    }
    case 'pastoral': {
      const n = fbm2D(PASTURE_PATCH_SEED, worldX / 0.8, worldY / 0.8, 2, 2, 0.5)
      return scaleColour(colour, 1 + (n - 0.5) * 0.25)
    }
    case 'moor': {
      const f = scatterDotFactor(worldX, worldY, HEATHER_SEED, 0.18, 0.5, 0.35)
      return scaleColour(colour, 1 + f * 0.3)
    }
    case 'marsh': {
      const f = lineStripeFactor(worldX, worldY, 0.12, 0.03)
      return scaleColour(colour, 1 - f * 0.25)
    }
    default:
      return colour
  }
}

/**
 * Samples the final terrain colour at one world point (DESIGN 9.4):
 * land-use blend tinted by soil and rain, hillshaded, blended against
 * a sea-depth ramp (itself tinted toward the local land-use colour, so
 * a lake reads a different hue from the open sea) across a
 * signed-distance coastline with a foam band and a crisp stroke, with
 * rivers drawn as variable-width curves and, at `ppm >= 24`,
 * deterministic fine land cover, then given a small deterministic
 * texture.
 *
 * @param {object} options
 * @param {object} options.grid A fully generated world grid (elev, landuse, soil, rain, cellMiles, width, height).
 * @param {Float32Array} options.sdf From `coastlineSdf.js`'s `buildCoastlineSdf()`.
 * @param {number} options.worldX World x coordinate, in miles.
 * @param {number} options.worldY World y coordinate, in miles.
 * @param {{r: number, g: number, b: number}[]} options.landuseColours From `buildLanduseColourLookup()`.
 * @param {object} options.palette The validated `palette.json` rules (hillshade, seaDepth, foam, coastline, river, riverWidth, fineLandCover, textureNoise).
 * @param {string[]} [options.landuseEnum] `terrain.json`'s `landuseEnum`. Only needed for fine land cover; omit to skip it entirely regardless of `ppm`.
 * @param {Float32Array} [options.riverDistance] From `riverField.js`'s `buildRiverFields()`. Omit to render no rivers at all.
 * @param {Float32Array} [options.riverHalfWidth] From `riverField.js`'s `buildRiverFields()`.
 * @param {number} [options.ppm] This tile's effective pixels-per-mile, for the `ppm >= 24` fine-land-cover gate. Omit (or `landuseEnum` omit) to always skip fine land cover.
 * @param {ReturnType<typeof buildSeasonContext>} [options.season] PHASES.md T2.13: precomputed seasonal state from `buildSeasonContext()`. Omit (or pass `null`, what that function returns when seasons are off) to skip every seasonal branch below entirely — no tint, no snow, no harvest colour, at zero added per-pixel cost.
 * @returns {{r: number, g: number, b: number}} 0-255 integer channels.
 */
export function sampleTerrainPixel({ grid, sdf, worldX, worldY, landuseColours, palette, landuseEnum, riverDistance, riverHalfWidth, ppm, season }) {
  const { width, height, cellMiles, elev, soil, rain } = grid
  const gx = worldX / cellMiles
  const gy = worldY / cellMiles
  const paletteColours = getPaletteColours(palette)

  const sdfValue = bilinearSample(sdf, width, height, gx, gy)
  const coastHalfWidthMiles = cellMiles * 0.5
  const landFactor = smoothstep(-coastHalfWidthMiles, coastHalfWidthMiles, sdfValue)

  const rawLanduseColour = bilinearLanduseColour(grid.landuse, width, height, gx, gy, landuseColours)

  // The nearest (not bilinearly blended) cell's land-use class name,
  // needed by both the ppm-gated fine land cover below and (PHASES.md
  // T2.13) the harvest-colour check, which isn't ppm-gated — harvest
  // gold on a sea of arable fields is a broad landscape mood, visible
  // at any zoom, not a close-up texture detail. Computed once here,
  // whenever a caller passes `landuseEnum` at all, so neither consumer
  // repeats the same lookup.
  let nearestLanduseName
  if (landuseEnum) {
    const nearestX = Math.min(Math.max(Math.round(gx), 0), width - 1)
    const nearestY = Math.min(Math.max(Math.round(gy), 0), height - 1)
    nearestLanduseName = landuseEnum[grid.landuse[nearestY * width + nearestX]]
  }

  // Land colour: land-use blend, tinted by soil fertility (richer soils
  // nudged greener) and rainfall (wetter land nudged cooler/bluer),
  // then (T2.13) golden harvest colour on arable in harvest months,
  // then shaded by the elevation gradient, then (T2.13) blended toward
  // snow above the snow line in winter months.
  const soilByte = bilinearSample(soil, width, height, gx, gy)
  const rainByte = bilinearSample(rain, width, height, gx, gy)
  const soilTint = (soilByte / 255 - 0.5) * 0.15
  const rainTint = (rainByte / 255 - 0.5) * 0.1
  let landColour = {
    r: rawLanduseColour.r * (1 - rainTint * 0.5),
    g: rawLanduseColour.g * (1 + soilTint),
    b: rawLanduseColour.b * (1 + rainTint * 0.5),
  }
  if (season && season.harvestActive && nearestLanduseName === 'arable') {
    landColour = lerpRgb(landColour, season.harvestColour, season.harvestStrength)
  }
  const shade = 1 + hillshadeDot(grid, gx, gy, palette.hillshade) * palette.hillshade.strength
  landColour = { r: landColour.r * shade, g: landColour.g * shade, b: landColour.b * shade }

  // Elevation (world metres, negative below sea level), reused below for
  // both the sea depth ramp and, when seasons are enabled, the winter
  // snow line.
  const elevation = bilinearSample(elev, width, height, gx, gy)
  if (season && season.snowActive && elevation > season.snowLineMetres) {
    const snowBlend = smoothstep(season.snowLineMetres, season.snowLineMetres + season.snowFadeRangeMetres, elevation)
    landColour = lerpRgb(landColour, season.snowColour, snowBlend)
  }

  // Sea colour: a depth ramp from the same elevation field (negative
  // below sea level), shallow near the coast, deep further out, tinted
  // toward the local land-use colour so a lake (landuse class 'lake')
  // reads a visibly different hue from the open sea (class 'sea')
  // rather than both sharing one identical ramp.
  const depthFactor = clamp01(Math.max(0, -elevation) / palette.seaDepth.depthScaleMetres)
  const depthRamp = lerpRgb(paletteColours.seaShallow, paletteColours.seaDeep, depthFactor)
  const seaColour = lerpRgb(depthRamp, rawLanduseColour, 0.35)

  let colour = lerpRgb(seaColour, landColour, landFactor)

  // Rivers: a variable-width curve from riverField.js's continuous
  // distance/half-width fields (DESIGN 9.4), not a traced polyline —
  // see riverField.js for why. Naturally fades out over water (a
  // river's own `riverHalfWidth` is 0 at the river cell's sea/lake
  // mouth, but bilinear sampling blends in the last land cell's
  // nonzero width for a few pixels past the shore), which is exactly
  // the Done-when's "connect smoothly to the sea with no gaps".
  if (riverDistance && riverHalfWidth) {
    // riverHalfWidth still blends smoothly (a real taper looks right);
    // riverDistance uses the minimum of the 4 surrounding cells instead
    // (see minCornerSample's own doc comment) so a diagonal river jog
    // never pinches shut between cells.
    let riverHalfWidthHere = bilinearSample(riverHalfWidth, width, height, gx, gy)
    if (riverHalfWidthHere > 0) {
      if (ppm !== undefined) {
        const minHalfWidthMiles = (MIN_RIVER_SCREEN_PIXELS / 2) / ppm
        riverHalfWidthHere = Math.max(riverHalfWidthHere, minHalfWidthMiles)
      }
      const riverDistanceHere = minCornerSample(riverDistance, width, height, gx, gy)
      const riverFactor = 1 - smoothstep(riverHalfWidthHere * 0.6, riverHalfWidthHere, riverDistanceHere)
      if (riverFactor > 0) colour = lerpRgb(colour, paletteColours.river, riverFactor)
    }
  }

  // Fine land cover (DESIGN 9.4: "at ppm >= 24"): gated by zoom so
  // Region/Area tiles, which cover far more world area per pixel,
  // never pay for texture nobody can resolve anyway. Keyed off the
  // *nearest* cell's land-use class, not the bilinear blend used for
  // colour above — a pattern needs one definite class to choose
  // between tree glyphs, hedgerows, patches, speckle or reeds.
  if (landuseEnum && ppm !== undefined && ppm >= palette.fineLandCover.minPpm) {
    colour = applyFineLandCover(colour, worldX, worldY, nearestLanduseName)
  }

  // Foam: a soft band hugging the coastline on both sides, peaking
  // exactly at the shore and fading out by `foam.widthMiles`. A
  // continuous function of distance from the coast, not a one-sided
  // threshold: a hard cutoff right at the sea/land boundary (where the
  // land/sea blend itself is still mid-transition) would show up as a
  // visible seam.
  const foamFactor = clamp01(1 - Math.abs(sdfValue) / palette.foam.widthMiles) * 0.7
  if (foamFactor > 0) {
    colour = lerpRgb(colour, paletteColours.foam, foamFactor)
  }

  // A crisp coastline stroke, narrower than the land/sea antialiasing
  // band, so the shoreline itself stays a sharp line at any zoom.
  const strokeHalfWidthMiles = cellMiles * 0.12
  const strokeFactor = (1 - smoothstep(0, strokeHalfWidthMiles, Math.abs(sdfValue))) * 0.5
  if (strokeFactor > 0) {
    colour = lerpRgb(colour, paletteColours.coastline, strokeFactor)
  }

  const noise = textureNoiseMultiplier(worldX, worldY, palette.textureNoise)
  colour = { r: colour.r * noise, g: colour.g * noise, b: colour.b * noise }

  // Subtle whole-scene monthly tint (PHASES.md T2.13), applied last so
  // it nudges the final land-or-sea colour alike, after every other
  // effect (rivers, foam, coastline, texture) has already settled it.
  if (season) {
    colour = { r: colour.r * season.tint.r, g: colour.g * season.tint.g, b: colour.b * season.tint.b }
  }

  return { r: clampByte(colour.r), g: clampByte(colour.g), b: clampByte(colour.b) }
}
