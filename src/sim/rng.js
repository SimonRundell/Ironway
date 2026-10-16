/**
 * Deterministic random number generation. No `Math.random` anywhere:
 * every stream is derived from a seed, so a run can be replayed
 * exactly (see DESIGN.md 4.5). Only `+ - * /`, `Math.floor` and integer
 * hashing are used, so results are identical across JS engines.
 *
 * @module sim/rng
 */

/**
 * Hashes a string to an unsigned 32-bit integer using FNV-1a. Pure
 * integer arithmetic (`Math.imul` for the exact 32-bit multiply), so
 * the result is identical on every engine.
 *
 * @param {string} str The string to hash.
 * @returns {number} An unsigned 32-bit integer.
 */
export function hashString(str) {
  let hash = 0x811c9dc5 // FNV offset basis (32-bit)

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) // FNV prime (32-bit)
  }

  return hash >>> 0
}

/**
 * The mulberry32 PRNG: a small, fast, well-distributed generator with
 * a 32-bit state. Public domain algorithm, reproduced here verbatim.
 *
 * @param {number} seed Unsigned 32-bit seed.
 * @returns {() => number} A function returning the next float in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0

  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Derives a named, deterministic random stream from a seed and any
 * number of further keys. The same seed and keys always produce the
 * same stream, in any order of calls, on any machine. Use a fresh key
 * for each independent purpose, e.g. `rngFor(seed, 'mapgen', 'mountains')`
 * or `rngFor(seed, 'tick', gameDay, entityId, 'breakdown')`.
 *
 * @param {string} seed The save's seed.
 * @param {...(string|number)} keys Further keys identifying this stream.
 * @returns {() => number} A function returning the next float in [0, 1).
 */
export function rngFor(seed, ...keys) {
  const combined = [seed, ...keys].join('|')
  return mulberry32(hashString(combined))
}

/**
 * Draws a uniformly distributed integer in [min, max], inclusive.
 *
 * @param {() => number} rng A stream from rngFor().
 * @param {number} min Lower bound, inclusive.
 * @param {number} max Upper bound, inclusive.
 * @returns {number} An integer in [min, max].
 */
export function int(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

/**
 * Picks a uniformly random element from an array.
 *
 * @template T
 * @param {() => number} rng A stream from rngFor().
 * @param {T[]} array Non-empty array to pick from.
 * @returns {T} The chosen element.
 */
export function pick(rng, array) {
  return array[int(rng, 0, array.length - 1)]
}

/**
 * Returns a new array containing the same elements in a uniformly
 * random order (Fisher-Yates). Does not mutate the input.
 *
 * @template T
 * @param {() => number} rng A stream from rngFor().
 * @param {T[]} array The array to shuffle.
 * @returns {T[]} A shuffled copy.
 */
export function shuffle(rng, array) {
  const result = array.slice()

  for (let i = result.length - 1; i > 0; i--) {
    const j = int(rng, 0, i)
    ;[result[i], result[j]] = [result[j], result[i]]
  }

  return result
}

/**
 * Draws an approximately normally distributed value using the
 * Irwin-Hall (sum of uniforms) approximation: the sum of 12 draws in
 * [0, 1) has mean 6 and variance 1, so subtracting 6 gives a
 * approximately standard normal value. Deliberately avoids Box-Muller
 * (which needs `Math.log`/`Math.sin`) to stay within the exact-arithmetic
 * rule in DESIGN 4.5.
 *
 * @param {() => number} rng A stream from rngFor().
 * @param {number} [mean] Distribution mean.
 * @param {number} [stdDev] Distribution standard deviation.
 * @returns {number} A pseudo-normally distributed value.
 */
export function gaussian(rng, mean = 0, stdDev = 1) {
  let sum = 0
  for (let i = 0; i < 12; i++) {
    sum += rng()
  }
  return mean + (sum - 6) * stdDev
}
