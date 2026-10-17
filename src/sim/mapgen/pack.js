/**
 * Packs a world grid into DESIGN.md 5.1's blob format and unpacks it
 * back: a small self-describing header (magic, generator version,
 * width, height, cell size, then a layer table of name/type pairs)
 * followed by each layer's raw bytes, the whole thing gzipped with
 * fflate. The blob is authoritative once created: `unpackWorld()`
 * always reconstructs exactly the grid that was packed, never
 * reapplying today's generator logic to it.
 *
 * @module sim/mapgen/pack
 */

import { gunzipSync, gzipSync } from 'fflate'
import { createWorldGrid } from './grid.js'

/** @type {number} This generator's version, recorded in every packed blob and in `saves`/`save_map`. */
export const GENERATOR_VERSION = 1

/** @type {number} A fixed sentinel at the start of every blob (ASCII "IRNW" read little-endian), to catch corrupt or unrelated data early. */
const MAGIC = 0x57_4e_52_49

/**
 * Layer names, in the exact order createWorldGrid() creates them
 * (DESIGN 5.1). `region` is Uint16, not the Uint8 DESIGN's table
 * literally lists — see DECISIONS.md T1.09: settlement counts can
 * exceed 255, so a real id would silently wrap in a true Uint8.
 *
 * @type {readonly string[]}
 */
const LAYER_NAMES = Object.freeze([
  'elev', 'water', 'flow', 'river', 'rain', 'soil', 'arable', 'pastoral',
  'landuse', 'slope', 'coast', 'shelter', 'resource', 'richness', 'region',
])

/** @type {readonly Function[]} Typed array constructor per type code (the array's index is the code). */
const TYPE_CTORS = Object.freeze([Int16Array, Uint16Array, Uint8Array])

/**
 * @param {Function} ctor A typed array constructor.
 * @returns {number} Its type code.
 * @throws {Error} If the constructor isn't one pack.js knows how to round-trip.
 */
function typeCodeOf(ctor) {
  const code = TYPE_CTORS.indexOf(ctor)
  if (code === -1) throw new Error(`pack: unsupported typed array constructor "${ctor.name}".`)
  return code
}

/**
 * Packs a world grid into a gzipped blob.
 *
 * @param {object} grid A fully generated world grid (see sim/mapgen/grid.js).
 * @param {number} [generatorVersion] Defaults to this build's GENERATOR_VERSION.
 * @returns {Uint8Array} The gzipped blob, ready for `save_map.blob`.
 */
export function packWorld(grid, generatorVersion = GENERATOR_VERSION) {
  const fixed = new Uint8Array(14)
  const fixedView = new DataView(fixed.buffer)
  fixedView.setUint32(0, MAGIC, true)
  fixedView.setUint16(4, generatorVersion, true)
  fixedView.setUint16(6, grid.width, true)
  fixedView.setUint16(8, grid.height, true)
  fixedView.setUint16(10, grid.cellMiles, true)
  fixedView.setUint16(12, LAYER_NAMES.length, true)

  const tableParts = [fixed]
  for (const name of LAYER_NAMES) {
    const nameBytes = new TextEncoder().encode(name)
    const entry = new Uint8Array(2 + nameBytes.length)
    entry[0] = nameBytes.length
    entry.set(nameBytes, 1)
    entry[1 + nameBytes.length] = typeCodeOf(grid[name].constructor)
    tableParts.push(entry)
  }

  const layerParts = LAYER_NAMES.map((name) => {
    const layer = grid[name]
    return new Uint8Array(layer.buffer, layer.byteOffset, layer.byteLength)
  })

  const parts = [...tableParts, ...layerParts]
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    combined.set(part, offset)
    offset += part.length
  }

  return gzipSync(combined)
}

/**
 * Unpacks a blob from packWorld() back into a world grid.
 *
 * @param {Uint8Array} blob A gzipped blob from packWorld().
 * @returns {{grid: object, generatorVersion: number}} The reconstructed grid and the version it was packed with.
 * @throws {Error} If the blob's magic number doesn't match (not a valid, or not an Ironway, blob).
 */
export function unpackWorld(blob) {
  const combined = gunzipSync(blob)
  const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength)

  const magic = view.getUint32(0, true)
  if (magic !== MAGIC) {
    throw new Error('unpackWorld: not a valid Ironway world blob (bad magic number).')
  }

  const generatorVersion = view.getUint16(4, true)
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  const cellMiles = view.getUint16(10, true)
  const layerCount = view.getUint16(12, true)

  let offset = 14
  const layers = []
  for (let i = 0; i < layerCount; i++) {
    const nameLength = combined[offset]
    const name = new TextDecoder().decode(combined.subarray(offset + 1, offset + 1 + nameLength))
    const typeCode = combined[offset + 1 + nameLength]
    layers.push({ name, typeCode })
    offset += 2 + nameLength
  }

  const grid = createWorldGrid(width, height, cellMiles)
  const elementCount = width * height

  for (const { name, typeCode } of layers) {
    const Ctor = TYPE_CTORS[typeCode]
    const byteLength = elementCount * Ctor.BYTES_PER_ELEMENT
    // .slice() copies into a fresh, zero-offset buffer, so the typed
    // array view below is always correctly aligned regardless of
    // where this layer happened to fall in the combined byte stream.
    const slice = combined.slice(offset, offset + byteLength)
    grid[name] = new Ctor(slice.buffer)
    offset += byteLength
  }

  return { grid, generatorVersion }
}
