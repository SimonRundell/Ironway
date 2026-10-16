/**
 * Seeded 2D value noise, fBm, ridged noise and domain warp for the map
 * generator. Built entirely from integer hashing and polynomial
 * interpolation (no `Math.sin`, no fractional `Math.pow`), so results
 * are bit-identical across JS engines, per DESIGN.md 4.5. Value noise
 * (rather than gradient/simplex noise) is what DESIGN 5.2 step 2 asks
 * for directly ("fBm value... noise"), and it sidesteps gradient-angle
 * maths entirely.
 *
 * @module sim/noise
 */

/**
 * Hashes a seed and an integer lattice coordinate to a float in
 * [0, 1). Pure integer mixing (xor, shift, `Math.imul`), so it is exact
 * and deterministic across engines.
 *
 * @param {number} seed Stream seed (any 32-bit integer).
 * @param {number} ix Lattice x coordinate (integer).
 * @param {number} iy Lattice y coordinate (integer).
 * @returns {number} A float in [0, 1).
 */
function latticeHash(seed, ix, iy) {
  let h = seed | 0
  h = Math.imul(h ^ ix, 0x27d4eb2d)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ iy, 0xc2b2ae35)
  h ^= h >>> 13
  h = Math.imul(h, 0x27d4eb2d)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * Ken Perlin's improved fade curve: a quintic polynomial with zero
 * first and second derivatives at 0 and 1, so interpolated lattices
 * join smoothly. Polynomial only, no trig.
 *
 * @param {number} t A value in [0, 1].
 * @returns {number} The eased value in [0, 1].
 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * Linear interpolation.
 *
 * @param {number} a Value at t = 0.
 * @param {number} b Value at t = 1.
 * @param {number} t Interpolation factor.
 * @returns {number} The interpolated value.
 */
function lerp(a, b, t) {
  return a + t * (b - a)
}

/**
 * Samples 2D seeded value noise at any real-valued coordinate.
 * Deterministic: the same seed and coordinate always give the same
 * result, on any machine.
 *
 * @param {number} seed Stream seed.
 * @param {number} x World x coordinate.
 * @param {number} y World y coordinate.
 * @returns {number} A value in [0, 1).
 */
export function valueNoise2D(seed, x, y) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = x0 + 1
  const y1 = y0 + 1

  const sx = fade(x - x0)
  const sy = fade(y - y0)

  const n00 = latticeHash(seed, x0, y0)
  const n10 = latticeHash(seed, x1, y0)
  const n01 = latticeHash(seed, x0, y1)
  const n11 = latticeHash(seed, x1, y1)

  const ix0 = lerp(n00, n10, sx)
  const ix1 = lerp(n01, n11, sx)

  return lerp(ix0, ix1, sy)
}

/**
 * Fractal Brownian motion: sums several octaves of value noise at
 * increasing frequency and decreasing amplitude, normalised back to
 * roughly [0, 1). Each octave uses a distinct derived seed so the
 * layers are not simple rescalings of one another.
 *
 * @param {number} seed Stream seed.
 * @param {number} x World x coordinate.
 * @param {number} y World y coordinate.
 * @param {number} [octaves] Number of noise layers to sum.
 * @param {number} [lacunarity] Frequency multiplier per octave.
 * @param {number} [gain] Amplitude multiplier per octave.
 * @returns {number} A value in [0, 1).
 */
export function fbm2D(seed, x, y, octaves = 6, lacunarity = 2, gain = 0.5) {
  let amplitude = 1
  let frequency = 1
  let sum = 0
  let maxAmplitude = 0

  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise2D(seed + i * 1013, x * frequency, y * frequency)
    maxAmplitude += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }

  return sum / maxAmplitude
}

/**
 * Ridged multifractal noise: folds each octave of value noise around
 * its midpoint and squares it, producing sharp ridges rather than
 * rolling hills. Used for mountain spines (DESIGN 5.2 step 3).
 *
 * @param {number} seed Stream seed.
 * @param {number} x World x coordinate.
 * @param {number} y World y coordinate.
 * @param {number} [octaves] Number of noise layers to sum.
 * @param {number} [lacunarity] Frequency multiplier per octave.
 * @param {number} [gain] Amplitude multiplier per octave.
 * @returns {number} A value in [0, 1), peaking sharply along ridges.
 */
export function ridgedNoise2D(seed, x, y, octaves = 6, lacunarity = 2, gain = 0.5) {
  let amplitude = 1
  let frequency = 1
  let sum = 0
  let maxAmplitude = 0

  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(seed + i * 1013, x * frequency, y * frequency)
    const ridge = 1 - Math.abs(2 * n - 1)
    sum += amplitude * ridge * ridge
    maxAmplitude += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }

  return sum / maxAmplitude
}

/**
 * Displaces a coordinate by two independent low-frequency fBm fields
 * before the caller samples its own noise there, producing the
 * "domain-warped ellipse" look DESIGN 5.2 step 1 asks for (organic,
 * non-radially-symmetric shapes from an otherwise regular field).
 *
 * @param {number} seed Stream seed.
 * @param {number} x World x coordinate.
 * @param {number} y World y coordinate.
 * @param {number} strength Maximum displacement, in the same units as x/y.
 * @param {number} [octaves] Octaves used for the two warp fields.
 * @returns {[number, number]} The displaced [x, y] coordinate.
 */
export function domainWarp2D(seed, x, y, strength, octaves = 2) {
  const warpX = x + strength * (fbm2D(seed + 7919, x, y, octaves, 2, 0.5) * 2 - 1)
  const warpY = y + strength * (fbm2D(seed + 7927, x, y, octaves, 2, 0.5) * 2 - 1)
  return [warpX, warpY]
}
