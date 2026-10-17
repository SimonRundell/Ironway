#!/usr/bin/env node
/**
 * Debug tool for T1.03-T1.06: generates an island for one or more
 * seeds and writes ASCII previews of each into scripts/out/, for a
 * human to eyeball the island mask, mountains, coastline, lakes,
 * rivers, land use and resource deposits.
 *
 * Usage:
 *   node scripts/mapgen-preview.mjs [seed ...]
 *
 * With no arguments, previews the five golden seeds (ironway-001 to
 * ironway-005).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { loadRulesNode } from '../src/sim/rules.js'
import { createWorldGrid, indexOf } from '../src/sim/mapgen/grid.js'
import { generateIsland } from '../src/sim/mapgen/island.js'
import { generateRain } from '../src/sim/mapgen/climate.js'
import { generateHydrology } from '../src/sim/mapgen/hydrology.js'
import { generateSlope } from '../src/sim/mapgen/slope.js'
import { generateCoast } from '../src/sim/mapgen/coast.js'
import { generateSoil } from '../src/sim/mapgen/soil.js'
import { generateResources, RESOURCE } from '../src/sim/mapgen/resources.js'
import { generateSettlements } from '../src/sim/mapgen/settlements.js'
import { createNameGenerator } from '../src/sim/names.js'

const DEFAULT_SEEDS = ['ironway-001', 'ironway-002', 'ironway-003', 'ironway-004', 'ironway-005']

/** @type {readonly string[]} Sea (deep to shallow) and land (low to high) ramp. */
const SEA_RAMP = [' ', '.', ':']
const LAND_RAMP = [',', '-', '+', '*', '^', '#', '@']
const LAKE_CHAR = '~'

/** @type {Record<string, string>} One ASCII character per `landuseEnum` class. */
const LANDUSE_CHARS = {
  sea: ' ',
  lake: '~',
  arable: 'a',
  mixed: 'm',
  pastoral: 'p',
  forest: 'f',
  moor: 'o',
  marsh: 'w',
  rock: '^',
}

/** @type {Record<number, string>} One ASCII character per `RESOURCE` enum value, drawn over land use. */
const RESOURCE_CHARS = {
  [RESOURCE.COAL]: 'C',
  [RESOURCE.IRON]: 'I',
  [RESOURCE.STONE]: 'S',
  [RESOURCE.CLAY]: 'Y',
}

/** @type {Record<string, string>} One ASCII character per settlement kind, drawn over everything else. */
const SETTLEMENT_CHARS = {
  capital: '#',
  city: 'O',
  town: 'T',
  village: 'V',
  hamlet: 'H',
}

/**
 * Renders a grid's water/elev/river/coast layers as a plain-text ASCII
 * map. Rivers are drawn as their width class digit (1-5), and selected
 * harbour candidates as `E` (estuary) or `H` (plain), both taking
 * priority over the underlying terrain character so they stand out.
 *
 * @param {object} grid A generated world grid.
 * @param {number} mountainLineMetres Elevation at which land is drawn as the highest ramp character.
 * @param {Set<number>} estuaryHarbourIndices Cell indices of selected estuary harbour candidates.
 * @param {Set<number>} plainHarbourIndices Cell indices of selected non-estuary harbour candidates.
 * @returns {string} The rendered map, one line per row.
 */
function renderAscii(grid, mountainLineMetres, estuaryHarbourIndices, plainHarbourIndices) {
  const lines = []

  for (let y = 0; y < grid.height; y++) {
    let line = ''
    for (let x = 0; x < grid.width; x++) {
      const i = indexOf(grid, x, y)

      if (estuaryHarbourIndices.has(i)) {
        line += 'E'
      } else if (plainHarbourIndices.has(i)) {
        line += 'H'
      } else if (grid.water[i] === 1) {
        const depthStep = Math.min(SEA_RAMP.length - 1, Math.floor(-grid.elev[i] / 70))
        line += SEA_RAMP[depthStep]
      } else if (grid.water[i] === 2) {
        line += LAKE_CHAR
      } else if (grid.river[i] > 0) {
        line += String(grid.river[i])
      } else {
        const step = Math.min(LAND_RAMP.length - 1, Math.floor((grid.elev[i] / mountainLineMetres) * (LAND_RAMP.length - 2)))
        line += LAND_RAMP[Math.max(0, step)]
      }
    }
    lines.push(line)
  }

  return lines.join('\n') + '\n'
}

/**
 * Renders a grid's land-use layer as a plain-text ASCII map, one
 * character per `landuseEnum` class, with resource deposits drawn over
 * the top as a capital letter (coal, iron, stone, clay).
 *
 * @param {object} grid A generated world grid, after generateSoil() and generateResources().
 * @param {string[]} landuseEnum terrain.json's `landuseEnum`.
 * @param {Map<number, string>} settlementChars Cell index to settlement-kind character, drawn over everything else.
 * @returns {string} The rendered map, one line per row.
 */
function renderLanduse(grid, landuseEnum, settlementChars) {
  const lines = []

  for (let y = 0; y < grid.height; y++) {
    let line = ''
    for (let x = 0; x < grid.width; x++) {
      const i = indexOf(grid, x, y)
      const settlementChar = settlementChars.get(i)
      const resourceChar = RESOURCE_CHARS[grid.resource[i]]
      if (settlementChar) {
        line += settlementChar
      } else if (resourceChar) {
        line += resourceChar
      } else {
        line += LANDUSE_CHARS[landuseEnum[grid.landuse[i]]] ?? '?'
      }
    }
    lines.push(line)
  }

  return lines.join('\n') + '\n'
}

async function main() {
  const seeds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SEEDS
  const rules = await loadRulesNode('public/data')

  mkdirSync('scripts/out', { recursive: true })

  for (const seed of seeds) {
    const grid = createWorldGrid(rules.mapgen.grid.width, rules.mapgen.grid.height, rules.mapgen.grid.cellMiles)
    const start = Date.now()
    generateIsland(grid, seed, rules.mapgen)
    generateRain(grid, rules.mapgen.climate)
    generateHydrology(grid, rules.mapgen.hydrology)
    generateSlope(grid, rules.mapgen.slope)
    const { harbourCandidates } = generateCoast(grid, rules.mapgen)
    generateSoil(grid, seed, rules.mapgen, rules.terrain)
    const deposits = generateResources(grid, seed, rules.mapgen)
    const nameGen = createNameGenerator(seed, rules.names)
    const settlements = generateSettlements(grid, seed, rules.mapgen, rules.settlements, rules.terrain, rules.classes, nameGen)
    const elapsedMs = Date.now() - start

    let land = 0
    let lake = 0
    let river = 0
    let rockCells = 0
    const landuseCounts = {}
    for (let i = 0; i < grid.water.length; i++) {
      if (grid.water[i] === 0) land++
      if (grid.water[i] === 2) lake++
      if (grid.river[i] > 0) river++
      if (grid.elev[i] >= rules.mapgen.soil.mountainLineMetres) rockCells++
      landuseCounts[grid.landuse[i]] = (landuseCounts[grid.landuse[i]] ?? 0) + 1
    }

    const estuaryHarbourIndices = new Set(harbourCandidates.filter((c) => c.isEstuary).map((c) => c.index))
    const plainHarbourIndices = new Set(harbourCandidates.filter((c) => !c.isEstuary).map((c) => c.index))

    const ascii = renderAscii(grid, rules.mapgen.soil.mountainLineMetres, estuaryHarbourIndices, plainHarbourIndices)
    const outPath = `scripts/out/${seed}.txt`
    writeFileSync(outPath, ascii)

    const settlementChars = new Map()
    for (const s of settlements) {
      const sx = Math.round(s.x / grid.cellMiles)
      const sy = Math.round(s.y / grid.cellMiles)
      settlementChars.set(indexOf(grid, sx, sy), SETTLEMENT_CHARS[s.kind] ?? '?')
    }

    const landuseAscii = renderLanduse(grid, rules.terrain.landuseEnum, settlementChars)
    const landuseOutPath = `scripts/out/${seed}-landuse.txt`
    writeFileSync(landuseOutPath, landuseAscii)

    const landuseIndex = {}
    rules.terrain.landuseEnum.forEach((name, index) => { landuseIndex[name] = index })
    const pct = (name) => (100 * (landuseCounts[landuseIndex[name]] ?? 0) / land).toFixed(1)

    const landFraction = (land / grid.water.length * 100).toFixed(1)
    console.log(
      `${seed}: ${elapsedMs}ms, land ${landFraction}%, rock cells ${rockCells}, ` +
      `lake cells ${lake}, river cells ${river}, harbours ${harbourCandidates.length} ` +
      `(${estuaryHarbourIndices.size} estuary) -> ${outPath}`,
    )
    console.log(
      `  land use: arable ${pct('arable')}%, pastoral ${pct('pastoral')}%, forest ${pct('forest')}%, ` +
      `marsh ${pct('marsh')}%, mixed ${pct('mixed')}%, moor ${pct('moor')}%, rock ${pct('rock')}% -> ${landuseOutPath}`,
    )
    console.log(
      `  resources: coal ${deposits.coal.length}, iron ${deposits.iron.length}, ` +
      `stone ${deposits.stone.length}, clay ${deposits.clay.length}`,
    )

    const byKind = {}
    for (const s of settlements) (byKind[s.kind] ??= []).push(s)
    const totalPop = settlements.reduce((sum, s) => sum + Object.values(s.pop).reduce((a, c) => a + c.pop, 0), 0)
    const ports = settlements.filter((s) => s.portTier > 0).length
    console.log(
      `  settlements: capital ${byKind.capital?.length ?? 0}, city ${byKind.city?.length ?? 0}, ` +
      `town ${byKind.town?.length ?? 0}, village ${byKind.village?.length ?? 0}, hamlet ${byKind.hamlet?.length ?? 0}, ` +
      `ports ${ports}, total population ${totalPop.toLocaleString()}`,
    )
  }
}

main()
