#!/usr/bin/env node
/**
 * Debug tool for T1.03-T1.11: generates an island for one or more
 * seeds and writes ASCII previews of each into scripts/out/, for a
 * human to eyeball the island mask, mountains, coastline, lakes,
 * rivers, land use, resource deposits, settlements, the link network
 * and industries.
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
import { generateLinks } from '../src/sim/mapgen/links.js'
import { generateIndustries } from '../src/sim/mapgen/industries.js'
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

/** @type {Record<string, string>} One ASCII character per link mode, drawn over the sea/land background. */
const LINK_CHARS = { road: 'o', rail: '=', sea: '-' }

/** @type {Record<string, number>} Draw priority when two link modes overlap the same cell; higher wins. */
const LINK_PRIORITY = { sea: 1, road: 2, rail: 3 }

/**
 * Bresenham's line algorithm between two grid cells, so a link's
 * sparse, simplified `path` waypoints can be drawn as a continuous
 * line in the ASCII preview.
 *
 * @param {number} x0 Start x.
 * @param {number} y0 Start y.
 * @param {number} x1 End x.
 * @param {number} y1 End y.
 * @returns {[number, number][]} Every cell the line crosses, inclusive of both ends.
 */
function rasterizeLine(x0, y0, x1, y1) {
  const points = []
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x1 > x0 ? 1 : -1
  const sy = y1 > y0 ? 1 : -1
  let x = x0
  let y = y0
  let err = dx - dy

  while (true) {
    points.push([x, y])
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
  }

  return points
}

/** @type {Record<string, string>} One ASCII character per industry tier, drawn over link lines but under settlements. */
const INDUSTRY_CHARS = { primary: '*', secondary: '+', tertiary: '%' }

/**
 * Renders the link network over a plain sea/land background: roads
 * (`o`), rail (`=`) and sea lanes (`-`), with industries (`*` primary,
 * `+` secondary) and settlement markers drawn on top, settlements
 * taking final priority. Virtual world links (no real path) are
 * skipped.
 *
 * @param {object} grid A generated world grid.
 * @param {import('../src/sim/state.js').Settlement[]} settlements Placed settlements.
 * @param {import('../src/sim/state.js').Link[]} links Generated links (including tramways).
 * @param {import('../src/sim/state.js').Industry[]} industries Placed industries.
 * @param {Map<string, string>} industryTierById Industry type id to tier, for the character choice.
 * @returns {string} The rendered map, one line per row.
 */
function renderLinks(grid, settlements, links, industries, industryTierById) {
  const drawn = new Map()

  for (const link of links) {
    if (link.bType === 'w') continue
    const ch = LINK_CHARS[link.mode]
    const priority = LINK_PRIORITY[link.mode]

    for (let i = 1; i < link.path.length; i++) {
      const x0 = Math.round(link.path[i - 1][0] / grid.cellMiles)
      const y0 = Math.round(link.path[i - 1][1] / grid.cellMiles)
      const x1 = Math.round(link.path[i][0] / grid.cellMiles)
      const y1 = Math.round(link.path[i][1] / grid.cellMiles)

      for (const [x, y] of rasterizeLine(x0, y0, x1, y1)) {
        if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) continue
        const key = indexOf(grid, x, y)
        const existing = drawn.get(key)
        if (!existing || priority >= existing.priority) drawn.set(key, { ch, priority })
      }
    }
  }

  for (const ind of industries) {
    const x = Math.round(ind.x / grid.cellMiles)
    const y = Math.round(ind.y / grid.cellMiles)
    const ch = INDUSTRY_CHARS[industryTierById.get(ind.typeId)] ?? '?'
    drawn.set(indexOf(grid, x, y), { ch, priority: Infinity - 1 })
  }

  for (const s of settlements) {
    const x = Math.round(s.x / grid.cellMiles)
    const y = Math.round(s.y / grid.cellMiles)
    drawn.set(indexOf(grid, x, y), { ch: SETTLEMENT_CHARS[s.kind] ?? '?', priority: Infinity })
  }

  const lines = []
  for (let y = 0; y < grid.height; y++) {
    let line = ''
    for (let x = 0; x < grid.width; x++) {
      const i = indexOf(grid, x, y)
      const cell = drawn.get(i)
      if (cell) {
        line += cell.ch
      } else {
        line += grid.water[i] === 1 ? ' ' : grid.water[i] === 2 ? '~' : '.'
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
    const links = generateLinks(grid, seed, rules.mapgen, rules.terrain, settlements)
    const { industries, tramwayLinks } = generateIndustries(grid, seed, rules.mapgen, rules.industries, rules.terrain, settlements, deposits, 1830, links)
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

    const industryTierById = new Map(rules.industries.map((d) => [d.id, d.tier]))
    const allLinksWithTramways = [...links, ...tramwayLinks]

    const linksAscii = renderLinks(grid, settlements, allLinksWithTramways, industries, industryTierById)
    const linksOutPath = `scripts/out/${seed}-links.txt`
    writeFileSync(linksOutPath, linksAscii)

    const roadMiles = links.filter((l) => l.mode === 'road').reduce((sum, l) => sum + l.lengthMi, 0)
    const railMiles = links.filter((l) => l.mode === 'rail').reduce((sum, l) => sum + l.lengthMi, 0) + tramwayLinks.reduce((sum, l) => sum + l.lengthMi, 0)
    const seaMiles = links.filter((l) => l.mode === 'sea' && l.bType === 's').reduce((sum, l) => sum + l.lengthMi, 0)
    console.log(
      `  links: road ${links.filter((l) => l.mode === 'road').length} (${roadMiles.toFixed(0)}mi), ` +
      `rail ${links.filter((l) => l.mode === 'rail').length + tramwayLinks.length} (${railMiles.toFixed(0)}mi, ${(100 * railMiles / roadMiles).toFixed(1)}% of road, incl. ${tramwayLinks.length} tramways), ` +
      `sea ${links.filter((l) => l.mode === 'sea' && l.bType === 's').length} (${seaMiles.toFixed(0)}mi), ` +
      `world ${links.filter((l) => l.bType === 'w').length} -> ${linksOutPath}`,
    )

    const byTier = {}
    for (const ind of industries) {
      const tier = industryTierById.get(ind.typeId)
      byTier[tier] = (byTier[tier] ?? 0) + 1
    }
    console.log(
      `  industries: ${industries.length} total (primary ${byTier.primary ?? 0}, secondary ${byTier.secondary ?? 0}), ` +
      `tramways ${tramwayLinks.length}`,
    )
  }
}

main()
