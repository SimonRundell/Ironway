import { fbm2D } from '../../sim/noise.js'

/**
 * Per-pixel terrain colour sampling (DESIGN 9.4, PHASES T2.04): bilinear
 * elevation and land-use sampling for smooth relief with no cell
 * blockiness, hillshade from a north-west light, a sea depth gradient,
 * a signed-distance coastline with a foam band, soil/rain tinting, and
 * a small deterministic noise texture. Pure maths over typed-array
 * grid layers and a `Float32Array` SDF (from `coastlineSdf.js`) — no
 * canvas, no worker — so it is unit testable directly;
 * `workers/tileWorker.js` is the only caller that actually writes
 * pixels with it.
 *
 * @module render/terrain/sampleTerrain
 */

/** @type {number} Fixed seed for the cosmetic texture-noise layer. Deliberately not tied to the world's own seed: the noise only breaks up flat colour, it is not part of the generator, so every world can share one constant. */
const TEXTURE_NOISE_SEED = 90125

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
 * @type {WeakMap<object, {seaShallow: object, seaDeep: object, foam: object, coastline: object}>}
 */
const paletteColourCache = new WeakMap()

/**
 * @param {object} palette The validated `palette.json` rules.
 * @returns {{seaShallow: {r,g,b}, seaDeep: {r,g,b}, foam: {r,g,b}, coastline: {r,g,b}}}
 */
function getPaletteColours(palette) {
  let colours = paletteColourCache.get(palette)
  if (!colours) {
    colours = {
      seaShallow: hexToRgb(palette.seaDepth.shallow),
      seaDeep: hexToRgb(palette.seaDepth.deep),
      foam: hexToRgb(palette.foam.colour),
      coastline: hexToRgb(palette.coastline),
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
 * Samples the final terrain colour at one world point (DESIGN 9.4):
 * land-use blend tinted by soil and rain, hillshaded, blended against
 * a sea-depth ramp across a signed-distance coastline with a foam
 * band and a crisp stroke, then given a small deterministic texture.
 *
 * @param {object} options
 * @param {object} options.grid A fully generated world grid (elev, landuse, soil, rain, cellMiles, width, height).
 * @param {Float32Array} options.sdf From `coastlineSdf.js`'s `buildCoastlineSdf()`.
 * @param {number} options.worldX World x coordinate, in miles.
 * @param {number} options.worldY World y coordinate, in miles.
 * @param {{r: number, g: number, b: number}[]} options.landuseColours From `buildLanduseColourLookup()`.
 * @param {object} options.palette The validated `palette.json` rules (hillshade, seaDepth, foam, coastline, textureNoise).
 * @returns {{r: number, g: number, b: number}} 0-255 integer channels.
 */
export function sampleTerrainPixel({ grid, sdf, worldX, worldY, landuseColours, palette }) {
  const { width, height, cellMiles, elev, soil, rain } = grid
  const gx = worldX / cellMiles
  const gy = worldY / cellMiles
  const paletteColours = getPaletteColours(palette)

  const sdfValue = bilinearSample(sdf, width, height, gx, gy)
  const coastHalfWidthMiles = cellMiles * 0.5
  const landFactor = smoothstep(-coastHalfWidthMiles, coastHalfWidthMiles, sdfValue)

  // Land colour: land-use blend, tinted by soil fertility (richer soils
  // nudged greener) and rainfall (wetter land nudged cooler/bluer),
  // then shaded by the elevation gradient.
  let landColour = bilinearLanduseColour(grid.landuse, width, height, gx, gy, landuseColours)
  const soilByte = bilinearSample(soil, width, height, gx, gy)
  const rainByte = bilinearSample(rain, width, height, gx, gy)
  const soilTint = (soilByte / 255 - 0.5) * 0.15
  const rainTint = (rainByte / 255 - 0.5) * 0.1
  landColour = {
    r: landColour.r * (1 - rainTint * 0.5),
    g: landColour.g * (1 + soilTint),
    b: landColour.b * (1 + rainTint * 0.5),
  }
  const shade = 1 + hillshadeDot(grid, gx, gy, palette.hillshade) * palette.hillshade.strength
  landColour = { r: landColour.r * shade, g: landColour.g * shade, b: landColour.b * shade }

  // Sea colour: a depth ramp from the same elevation field (negative
  // below sea level), shallow near the coast, deep further out.
  const elevation = bilinearSample(elev, width, height, gx, gy)
  const depthFactor = clamp01(Math.max(0, -elevation) / palette.seaDepth.depthScaleMetres)
  const seaColour = lerpRgb(paletteColours.seaShallow, paletteColours.seaDeep, depthFactor)

  let colour = lerpRgb(seaColour, landColour, landFactor)

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

  return { r: clampByte(colour.r), g: clampByte(colour.g), b: clampByte(colour.b) }
}
