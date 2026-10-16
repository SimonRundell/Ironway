/**
 * Deterministic checksum over any plain-data state (typed arrays,
 * arrays, plain objects, numbers, strings, booleans, null), used by
 * tests to prove two simulation runs produced byte-identical results
 * (DESIGN.md 4.5). Object keys are sorted during serialisation so the
 * result does not depend on insertion order.
 *
 * Uses 64-bit FNV-1a via BigInt, which is exact integer arithmetic (no
 * floating point), and formats as 16 lowercase hex characters to match
 * the `save_map.checksum CHAR(16)` column (see api/sql/001_schema.sql).
 *
 * @module sim/checksum
 */

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/**
 * Serialises any supported value to a canonical string: identical
 * logical content always produces an identical string, regardless of
 * object key order.
 *
 * @param {*} value The value to serialise.
 * @returns {string} A canonical, type-tagged string representation.
 * @throws {TypeError} If `value` is a type checksum() cannot serialise
 *   (e.g. a function or a symbol).
 */
function canonicalize(value) {
  if (value === null) {
    return 'z'
  }

  const type = typeof value

  if (type === 'number') {
    return `n:${value}`
  }
  if (type === 'boolean') {
    return `b:${value}`
  }
  if (type === 'string') {
    return `s:${value.length}:${value}`
  }

  if (ArrayBuffer.isView(value)) {
    let out = `t:${value.constructor.name}:${value.length}:`
    for (let i = 0; i < value.length; i++) {
      out += `${value[i]},`
    }
    return out
  }

  if (Array.isArray(value)) {
    let out = `a:${value.length}:`
    for (const item of value) {
      out += `${canonicalize(item)};`
    }
    return out
  }

  if (type === 'object') {
    const keys = Object.keys(value).sort()
    let out = `o:${keys.length}:`
    for (const key of keys) {
      out += `${key}=${canonicalize(value[key])};`
    }
    return out
  }

  throw new TypeError(`checksum: cannot serialise a value of type "${type}".`)
}

/**
 * Computes 64-bit FNV-1a over a string, using BigInt for exact integer
 * arithmetic throughout.
 *
 * @param {string} str The canonical string to hash.
 * @returns {bigint} The 64-bit hash.
 */
function fnv1a64(str) {
  let hash = FNV64_OFFSET_BASIS

  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i))
    hash = (hash * FNV64_PRIME) & MASK_64
  }

  return hash
}

/**
 * Computes a deterministic checksum of any plain-data state.
 *
 * @param {*} state The world or simulation state to checksum.
 * @returns {string} A 16-character lowercase hex checksum.
 */
export function checksum(state) {
  const hash = fnv1a64(canonicalize(state))
  return hash.toString(16).padStart(16, '0')
}
