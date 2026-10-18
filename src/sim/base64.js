/**
 * Base64 encoding for a Uint8Array, chunked to stay well under the
 * argument-count limit `String.fromCharCode.apply()`/spread would hit
 * on a ~100 KB map blob (DESIGN 5.1: typically under 150 KB, but never
 * assume a size cap holds forever).
 *
 * @module sim/base64
 */

/** @type {number} Bytes per chunk; comfortably under engines' typical ~65536-argument apply() limit. */
const CHUNK_SIZE = 8192

/**
 * Encodes a Uint8Array as a base64 string.
 *
 * @param {Uint8Array} bytes The bytes to encode.
 * @returns {string} The base64-encoded string.
 */
export function uint8ArrayToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE)
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}

/**
 * Decodes a base64 string back to a Uint8Array.
 *
 * @param {string} base64 The base64-encoded string.
 * @returns {Uint8Array} The decoded bytes.
 */
export function base64ToUint8Array(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
