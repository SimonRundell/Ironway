/**
 * Validates a freshly generated world against every DESIGN.md 5.3
 * rule, so `generateWorld`'s retry loop can tell a good island from a
 * one-in-a-hundred bad roll. Pure checks over the already-generated
 * grid, settlements, links and deposits; never mutates anything.
 *
 * @module sim/mapgen/validate
 */

import { indexOf } from './grid.js'
import { COAST_FLAG } from './coast.js'

/**
 * Finds every 8-connected component of cells matching `match`.
 *
 * @param {object} grid The world grid.
 * @param {(index: number) => boolean} match Which cells belong to a component.
 * @returns {number[][]} One array of cell indices per component.
 */
function findComponents(grid, match) {
  const { width, height } = grid
  const size = width * height
  const visited = new Uint8Array(size)
  const components = []
  const offsets = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]

  for (let start = 0; start < size; start++) {
    if (!match(start) || visited[start]) continue

    const component = []
    const stack = [start]
    visited[start] = 1

    while (stack.length > 0) {
      const i = stack.pop()
      component.push(i)
      const x = i % width
      const y = Math.floor(i / width)

      for (const [dx, dy] of offsets) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const ni = indexOf(grid, nx, ny)
        if (match(ni) && !visited[ni]) {
          visited[ni] = 1
          stack.push(ni)
        }
      }
    }

    components.push(component)
  }

  return components
}

/**
 * Land fraction within the configured band, and exactly one landmass
 * large enough to be "major" (anything else should already have been
 * filtered out by island.js's own step 4, so finding a second big one
 * here would mean that invariant broke).
 *
 * @param {object} grid The world grid.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkLandFraction(grid, mapgenRules) {
  const errors = []
  const v = mapgenRules.validation

  let land = 0
  for (let i = 0; i < grid.water.length; i++) if (grid.water[i] === 0) land++
  const fraction = land / grid.water.length

  if (fraction < v.landFractionMin || fraction > v.landFractionMax) {
    errors.push(`land fraction ${(fraction * 100).toFixed(1)}% outside [${v.landFractionMin * 100}, ${v.landFractionMax * 100}]`)
  }

  const components = findComponents(grid, (i) => grid.water[i] === 0)
  components.sort((a, b) => b.length - a.length)
  const secondLargest = components[1]?.length ?? 0
  if (secondLargest >= mapgenRules.seaLevel.maxIsletCells) {
    errors.push(`found a second landmass of ${secondLargest} cells (not a small islet) alongside the main one`)
  }

  return errors
}

/**
 * At least 3 rivers with source-to-sea length over 100 miles, and
 * every river cell's flow path eventually reaches the sea or a lake
 * (hydrology.js's priority-flood already guarantees this by
 * construction; re-checking here catches a regression, not a normal
 * failure).
 *
 * @param {object} grid The world grid.
 * @param {Int32Array} flowTo Per-cell downstream cell index, from generateHydrology().
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkRivers(grid, flowTo, mapgenRules) {
  const errors = []
  const v = mapgenRules.validation
  const cellMiles = grid.cellMiles

  const hasUpstreamRiver = new Uint8Array(grid.width * grid.height)
  for (let i = 0; i < flowTo.length; i++) {
    if (grid.river[i] > 0 && flowTo[i] !== -1 && grid.river[flowTo[i]] > 0) hasUpstreamRiver[flowTo[i]] = 1
  }

  let longRivers = 0
  for (let i = 0; i < flowTo.length; i++) {
    if (grid.river[i] === 0 || hasUpstreamRiver[i]) continue

    let current = i
    let lengthMiles = 0
    let reachedWater = false
    const limit = grid.width * grid.height + 10

    for (let steps = 0; steps < limit; steps++) {
      const next = flowTo[current]
      if (next === -1) break
      const x1 = current % grid.width
      const y1 = Math.floor(current / grid.width)
      const x2 = next % grid.width
      const y2 = Math.floor(next / grid.width)
      const diagonal = x1 !== x2 && y1 !== y2
      lengthMiles += diagonal ? cellMiles * Math.SQRT2 : cellMiles

      if (grid.water[next] === 1 || grid.water[next] === 2) {
        reachedWater = true
        break
      }
      current = next
    }

    if (!reachedWater) errors.push(`a river starting at cell ${i} never reaches the sea or a lake`)
    if (lengthMiles >= v.minRiverLengthMiles) longRivers++
  }

  if (longRivers < v.minRiverCount) {
    errors.push(`only ${longRivers} rivers over ${v.minRiverLengthMiles} miles (need ${v.minRiverCount})`)
  }

  return errors
}

/**
 * At least one mountain range: `rock` cells totalling the configured
 * minimum.
 *
 * @param {object} grid The world grid.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkRockCells(grid, terrainRules, mapgenRules) {
  const rockIndex = terrainRules.landuseEnum.indexOf('rock')
  let rockCells = 0
  for (let i = 0; i < grid.landuse.length; i++) if (grid.landuse[i] === rockIndex) rockCells++

  if (rockCells < mapgenRules.validation.minRockCells) {
    return [`only ${rockCells} rock cells (need ${mapgenRules.validation.minRockCells})`]
  }
  return []
}

/**
 * Harbour candidate and estuary-harbour minimums.
 *
 * @param {object[]} harbourCandidates From generateCoast().
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkHarbours(harbourCandidates, mapgenRules) {
  const errors = []
  const v = mapgenRules.validation

  if (harbourCandidates.length < v.minHarbourCandidates) {
    errors.push(`only ${harbourCandidates.length} harbour candidates (need ${v.minHarbourCandidates})`)
  }
  const estuaryCount = harbourCandidates.filter((c) => c.isEstuary).length
  if (estuaryCount < v.minEstuaryHarbours) {
    errors.push(`only ${estuaryCount} estuary harbours (need ${v.minEstuaryHarbours})`)
  }

  return errors
}

/**
 * Minimum land-use percentages: arable, pastoral, forest at least 5%
 * each; marsh at least 1%.
 *
 * @param {object} grid The world grid.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkLanduseShares(grid, terrainRules, mapgenRules) {
  const v = mapgenRules.validation
  const indexOfKind = {}
  terrainRules.landuseEnum.forEach((name, i) => { indexOfKind[name] = i })

  let land = 0
  const counts = {}
  for (let i = 0; i < grid.landuse.length; i++) {
    if (grid.water[i] !== 0) continue
    land++
    counts[grid.landuse[i]] = (counts[grid.landuse[i]] ?? 0) + 1
  }

  const pct = (kind) => (land === 0 ? 0 : (counts[indexOfKind[kind]] ?? 0) / land * 100)
  const errors = []

  if (pct('arable') < v.minArablePercent) errors.push(`arable ${pct('arable').toFixed(1)}% below ${v.minArablePercent}%`)
  if (pct('pastoral') < v.minPastoralPercent) errors.push(`pastoral ${pct('pastoral').toFixed(1)}% below ${v.minPastoralPercent}%`)
  if (pct('forest') < v.minForestPercent) errors.push(`forest ${pct('forest').toFixed(1)}% below ${v.minForestPercent}%`)
  if (pct('marsh') < v.minMarshPercent) errors.push(`marsh ${pct('marsh').toFixed(1)}% below ${v.minMarshPercent}%`)

  return errors
}

/**
 * Settlement counts within DESIGN 5.4's per-kind ranges, and the
 * capital within `capitalMaxMilesFromHarbour` of a harbour candidate
 * or estuary cell.
 *
 * @param {object} grid The world grid.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {object} settlementsRules The validated settlements.json rules.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkSettlements(grid, settlements, settlementsRules, mapgenRules) {
  const errors = []
  const byKind = {}
  for (const s of settlements) (byKind[s.kind] ??= []).push(s)

  for (const kind of settlementsRules.kinds) {
    const count = (byKind[kind.id] ?? []).length
    if (count < kind.count.min || count > kind.count.max) {
      errors.push(`${kind.id} count ${count} outside [${kind.count.min}, ${kind.count.max}]`)
    }
  }

  const capital = settlements.find((s) => s.kind === 'capital')
  if (!capital) {
    errors.push('no capital was placed')
  } else {
    let nearestMiles = Infinity
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const i = indexOf(grid, x, y)
        if ((grid.coast[i] & (COAST_FLAG.HARBOUR_CANDIDATE | COAST_FLAG.ESTUARY)) === 0) continue
        const dx = x * grid.cellMiles - capital.x
        const dy = y * grid.cellMiles - capital.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < nearestMiles) nearestMiles = d
      }
    }
    if (nearestMiles > mapgenRules.validation.capitalMaxMilesFromHarbour) {
      errors.push(`capital is ${nearestMiles.toFixed(1)} miles from the nearest harbour/estuary (max ${mapgenRules.validation.capitalMaxMilesFromHarbour})`)
    }
  }

  return errors
}

/**
 * Every settlement reachable from the capital by road; every port
 * reachable by sea from every other port.
 *
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {import('../state.js').Link[]} links The full link network.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkConnectivity(settlements, links) {
  const errors = []
  const idToIndex = new Map(settlements.map((s, i) => [s.id, i]))

  /**
   * @param {number} n Node count.
   * @returns {{find: (x: number) => number, union: (a: number, b: number) => void}}
   */
  function unionFind(n) {
    const parent = Array.from({ length: n }, (_, i) => i)
    const find = (x) => { while (parent[x] !== x) x = parent[x]; return x }
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb }
    return { find, union }
  }

  const roadUf = unionFind(settlements.length)
  for (const l of links) {
    if (l.mode === 'road') roadUf.union(idToIndex.get(l.aId), idToIndex.get(l.bId))
  }
  const capital = settlements.find((s) => s.kind === 'capital')
  if (capital) {
    const capitalRoot = roadUf.find(idToIndex.get(capital.id))
    const unreachable = settlements.filter((s) => roadUf.find(idToIndex.get(s.id)) !== capitalRoot)
    if (unreachable.length > 0) {
      errors.push(`${unreachable.length} settlements are not reachable from the capital by road`)
    }
  }

  const ports = settlements.filter((s) => s.portTier > 0)
  if (ports.length >= 2) {
    const seaUf = unionFind(settlements.length)
    for (const l of links) {
      if (l.mode === 'sea' && l.bType === 's') seaUf.union(idToIndex.get(l.aId), idToIndex.get(l.bId))
    }
    const firstRoot = seaUf.find(idToIndex.get(ports[0].id))
    const unreachable = ports.filter((p) => seaUf.find(idToIndex.get(p.id)) !== firstRoot)
    if (unreachable.length > 0) {
      errors.push(`${unreachable.length} ports are not reachable by sea from the others`)
    }
  }

  return errors
}

/**
 * Resource deposit guarantees from DESIGN 5.2 step 11: minimum
 * deposit counts per type, and enough coal-iron pairs within chain
 * distance of each other. Already guaranteed by construction in
 * resources.js; re-checked here as a regression safety net.
 *
 * @param {{coal: object[], iron: object[], stone: object[], clay: object[]}} deposits From sim/mapgen/resources.js.
 * @param {number} cellMiles The grid's cell size, for the proximity check.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {string[]} Error messages; empty if this check passes.
 */
function checkResources(deposits, cellMiles, mapgenRules) {
  const p = mapgenRules.resources
  const errors = []

  if (deposits.coal.length < p.minCoalDeposits) errors.push(`only ${deposits.coal.length} coal deposits (need ${p.minCoalDeposits})`)
  if (deposits.iron.length < p.minIronDeposits) errors.push(`only ${deposits.iron.length} iron deposits (need ${p.minIronDeposits})`)
  if (deposits.stone.length < p.minStoneDeposits) errors.push(`only ${deposits.stone.length} stone deposits (need ${p.minStoneDeposits})`)
  if (deposits.clay.length < p.minClayDeposits) errors.push(`only ${deposits.clay.length} clay deposits (need ${p.minClayDeposits})`)

  let pairs = 0
  for (const c of deposits.coal) {
    for (const i of deposits.iron) {
      const dx = (c.x - i.x) * cellMiles
      const dy = (c.y - i.y) * cellMiles
      if (Math.sqrt(dx * dx + dy * dy) <= p.coalIronProximityMiles) pairs++
    }
  }
  if (pairs < p.minCoalIronPairsWithinProximity) {
    errors.push(`only ${pairs} coal-iron pairs within ${p.coalIronProximityMiles} miles (need ${p.minCoalIronPairsWithinProximity})`)
  }

  return errors
}

/**
 * Validates a freshly generated world against every DESIGN.md 5.3
 * rule.
 *
 * @param {object} ctx
 * @param {object} ctx.grid The generated world grid.
 * @param {Int32Array} ctx.flowTo Per-cell downstream cell index, from generateHydrology().
 * @param {object[]} ctx.harbourCandidates From generateCoast().
 * @param {import('../state.js').Settlement[]} ctx.settlements Placed settlements.
 * @param {import('../state.js').Link[]} ctx.links The full link network (main plus tramways).
 * @param {{coal: object[], iron: object[], stone: object[], clay: object[]}} ctx.deposits From generateResources().
 * @param {number} ctx.generationTimeMs Wall-clock time for this attempt's generation, in milliseconds.
 * @param {object} ctx.mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} ctx.terrainRules The validated terrain.json rules.
 * @param {object} ctx.settlementsRules The validated settlements.json rules.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateWorld(ctx) {
  const {
    grid, flowTo, harbourCandidates, settlements, links, deposits,
    generationTimeMs, mapgenRules, terrainRules, settlementsRules,
  } = ctx

  const errors = [
    ...checkLandFraction(grid, mapgenRules),
    ...checkRivers(grid, flowTo, mapgenRules),
    ...checkRockCells(grid, terrainRules, mapgenRules),
    ...checkHarbours(harbourCandidates, mapgenRules),
    ...checkLanduseShares(grid, terrainRules, mapgenRules),
    ...checkSettlements(grid, settlements, settlementsRules, mapgenRules),
    ...checkConnectivity(settlements, links),
    ...checkResources(deposits, grid.cellMiles, mapgenRules),
  ]

  const generationTimeLimitMs = mapgenRules.validation.generationTimeLimitSeconds * 1000
  if (generationTimeMs > generationTimeLimitMs) {
    errors.push(`generation took ${generationTimeMs}ms, over the ${generationTimeLimitMs}ms limit`)
  }

  return { valid: errors.length === 0, errors }
}
