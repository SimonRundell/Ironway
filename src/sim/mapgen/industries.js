/**
 * Places the initial set of industries: evaluates each industry's
 * siting rules against the grid, scores and picks sites (era-gated to
 * the save's start year), assigns a home settlement for labour, and
 * builds colliery tramways from coal/iron mines to the nearest town or
 * port. DESIGN.md 5.6, Appendix B.
 *
 * @module sim/mapgen/industries
 */

import { computeDistanceFromSources, indexOf, isInBounds, neighbours8 } from './grid.js'
import { int, rngFor } from '../rng.js'
import { COAST_FLAG } from './coast.js'
import { RESOURCE } from './resources.js'
import { computeBuildableMask } from './settlements.js'
import { KIND_RANK, routeTerrainLink } from './links.js'

/**
 * Flattens an industry's `siteRules` array into plain rule strings,
 * unwrapping any `{any: [...]}` groups. Used only to scan for which
 * rule *kinds* (town thresholds, near: cargoes) appear anywhere in
 * industries.json, not for evaluating eligibility itself.
 *
 * @param {(string|{any: string[]})[]} siteRules An industry's siteRules.
 * @returns {string[]} Every plain rule string, any-groups included.
 */
function flattenRules(siteRules) {
  const flat = []
  for (const rule of siteRules) {
    if (rule && typeof rule === 'object' && Array.isArray(rule.any)) flat.push(...rule.any)
    else flat.push(rule)
  }
  return flat
}

/**
 * Whether a cell is dry riverside land: itself not a river cell, but
 * within `radiusCells` of one of at least `minWidthClass` (DESIGN
 * 5.6's `river` rule; default radius is 1, so this is a cheap local
 * check rather than a BFS). The cell itself is deliberately excluded
 * even when it meets `minWidthClass` — a river cell *is* the channel,
 * not the bank, and siting a mill or ironworks there put the building
 * literally in the river once rendered (T2.09's own river-stroke runs
 * straight through a river cell's centre, exactly where a building
 * sited on that cell would be drawn too).
 *
 * @param {object} grid The world grid.
 * @param {number} i A cell index.
 * @param {number} minWidthClass Minimum river width class.
 * @param {number} radiusCells Search radius, in cells.
 * @returns {boolean}
 */
function isNearRiver(grid, i, minWidthClass, radiusCells) {
  if (grid.river[i] >= minWidthClass) return false
  const x = i % grid.width
  const y = Math.floor(i / grid.width)
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      if (dx === 0 && dy === 0) continue
      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(grid, nx, ny)) continue
      if (grid.river[indexOf(grid, nx, ny)] >= minWidthClass) return true
    }
  }
  return false
}

/**
 * Whether a cell is `forest` or adjacent to one (DESIGN 5.6's `forest`
 * rule).
 *
 * @param {object} grid The world grid.
 * @param {number} forestIndex terrain.json's landuseEnum index for `forest`.
 * @param {number} i A cell index.
 * @returns {boolean}
 */
function isForestOrAdjacent(grid, forestIndex, i) {
  if (grid.landuse[i] === forestIndex) return true
  const x = i % grid.width
  const y = Math.floor(i / grid.width)
  for (const [nx, ny] of neighbours8(grid, x, y)) {
    if (grid.landuse[indexOf(grid, nx, ny)] === forestIndex) return true
  }
  return false
}

/**
 * Multi-source BFS distance (in cells) to the nearest settlement cell
 * of rank `maxRank` or better (smaller rank number = bigger kind),
 * for `town:<kind>` siting rules.
 *
 * @param {object} grid The world grid.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {number} maxRank The largest (worst) `KIND_RANK` value that still qualifies.
 * @returns {Int32Array} Distance in cells; -1 if no qualifying settlement exists at all.
 */
function computeDistanceToKindOrLarger(grid, settlements, maxRank) {
  const sourceCells = new Set()
  for (const s of settlements) {
    if (KIND_RANK[s.kind] <= maxRank) {
      sourceCells.add(indexOf(grid, Math.round(s.x / grid.cellMiles), Math.round(s.y / grid.cellMiles)))
    }
  }
  return computeDistanceFromSources(grid, (i) => sourceCells.has(i))
}

/**
 * Evaluates one siting rule (a plain string, or `{any: [...]}`) at a
 * cell against precomputed context. `near:<cargo>` is DESIGN 5.6's one
 * soft rule ("prefer") and always passes here; it only ever affects
 * scoring, in `scoreCandidate()`.
 *
 * @param {string|{any: string[]}} rule One siting rule.
 * @param {number} i A cell index.
 * @param {object} ctx Precomputed lookups; see buildSitingContext().
 * @returns {boolean} Whether the cell satisfies this rule.
 */
export function evaluateSiteRule(rule, i, ctx) {
  if (rule && typeof rule === 'object' && Array.isArray(rule.any)) {
    return rule.any.some((sub) => evaluateSiteRule(sub, i, ctx))
  }

  if (rule.startsWith('resource:')) {
    const name = rule.slice('resource:'.length).toUpperCase()
    return ctx.grid.resource[i] === RESOURCE[name]
  }
  if (rule === 'river') {
    return isNearRiver(ctx.grid, i, ctx.params.riverMinWidthClass, ctx.params.riverSitingRadiusCells)
  }
  if (rule === 'coast') {
    return (ctx.grid.coast[i] & COAST_FLAG.COASTAL) !== 0
  }
  if (rule === 'harbour') {
    return ctx.distanceToHarbourOrEstuary[i] <= ctx.harbourRadiusCells
  }
  if (rule === 'forest') {
    return isForestOrAdjacent(ctx.grid, ctx.forestIndex, i)
  }
  if (rule.startsWith('town:')) {
    const kind = rule.slice('town:'.length)
    return ctx.distanceByTownKind.get(kind)[i] <= ctx.townRadiusCells
  }
  if (rule.startsWith('near:')) {
    return true
  }
  return false
}

/**
 * Builds the precomputed lookups `evaluateSiteRule()` needs, shared
 * across every industry type so each BFS/scan runs only once per
 * generation regardless of how many industries use it.
 *
 * @param {object} grid The world grid.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {object[]} industriesCatalogue The validated industries.json entries.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @returns {object} The siting context.
 */
export function buildSitingContext(grid, mapgenRules, terrainRules, industriesCatalogue, settlements) {
  const params = mapgenRules.industries

  const townKinds = new Set()
  for (const ind of industriesCatalogue) {
    for (const rule of flattenRules(ind.siteRules)) {
      if (typeof rule === 'string' && rule.startsWith('town:')) townKinds.add(rule.slice('town:'.length))
    }
  }
  const distanceByTownKind = new Map()
  for (const kind of townKinds) {
    distanceByTownKind.set(kind, computeDistanceToKindOrLarger(grid, settlements, KIND_RANK[kind]))
  }

  return {
    grid,
    params,
    forestIndex: terrainRules.landuseEnum.indexOf('forest'),
    distanceToHarbourOrEstuary: computeDistanceFromSources(
      grid,
      (i) => (grid.coast[i] & (COAST_FLAG.HARBOUR_CANDIDATE | COAST_FLAG.ESTUARY)) !== 0,
    ),
    harbourRadiusCells: params.harbourSitingRadiusMiles / grid.cellMiles,
    townRadiusCells: params.townSitingRadiusMiles / grid.cellMiles,
    distanceByTownKind,
  }
}

/**
 * Finds, for every land cell, the nearest settlement within
 * `radiusMiles` (DESIGN 5.6: "a homeSettlementId (nearest settlement
 * within 10 miles) which supplies its labour"). Shared by every
 * industry: computed once, not per type.
 *
 * @param {object} grid The world grid.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {number} radiusMiles The labour-catchment radius.
 * @returns {Uint16Array} Settlement id per cell, 0 if none within range.
 */
function computeHomeSettlementIds(grid, settlements, radiusMiles) {
  const { width, height, cellMiles, water } = grid
  const homeId = new Uint16Array(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = indexOf(grid, x, y)
      if (water[i] !== 0) continue

      let bestId = 0
      let bestDistance = Infinity
      for (const s of settlements) {
        const dx = x * cellMiles - s.x
        const dy = y * cellMiles - s.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < bestDistance) {
          bestDistance = d
          bestId = s.id
        }
      }
      if (bestDistance <= radiusMiles) homeId[i] = bestId
    }
  }

  return homeId
}

/**
 * Places one instance of a resource-sited primary industry (DESIGN
 * 5.6's `resource:<id>` rule) on every qualifying deposit's centre
 * cell — one node, one industry, matching `maxPerNode` for every
 * resource primary in industries.json (always 1).
 *
 * @param {object} ind The industry definition.
 * @param {object[]} depositList Deposits of the matching resource type (see sim/mapgen/resources.js).
 * @param {Uint8Array} buildable From computeBuildableMask().
 * @param {Uint16Array} homeSettlementId Per-cell home settlement id, 0 if none.
 * @param {Set<number>} claimed Cells already used by any industry; updated in place.
 * @returns {{index: number, homeSettlementId: number}[]} Placement sites.
 */
function placeOnDeposits(ind, depositList, buildable, homeSettlementId, claimed) {
  const sites = []
  for (const deposit of depositList) {
    const i = deposit.centreIndex
    if (claimed.has(i) || !buildable[i] || homeSettlementId[i] === 0) continue
    claimed.add(i)
    sites.push({ index: i, homeSettlementId: homeSettlementId[i] })
  }
  return sites
}

/**
 * Places a terrain- or town-sited industry: scans every eligible cell,
 * scores it (a `near:<cargo>` proximity bonus, if the industry has
 * one, plus a small deterministic jitter so otherwise-tied cells don't
 * cluster unnaturally), then greedily takes the best-scoring cells up
 * to a randomly drawn count, skipping any home settlement that has
 * already reached this industry's `maxPerNode`.
 *
 * @param {object} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {object} ind The industry definition.
 * @param {object} ctx From buildSitingContext().
 * @param {Uint8Array} buildable From computeBuildableMask().
 * @param {Uint16Array} homeSettlementId Per-cell home settlement id, 0 if none.
 * @param {Set<number>} claimed Cells already used by any industry; updated in place.
 * @param {{typeId: string, index: number}[]} placedSoFar Every industry placed before this one, for `near:` lookups.
 * @param {Map<string, object>} industryById Industry id to definition, for `near:` output lookups.
 * @returns {{index: number, homeSettlementId: number}[]} Placement sites.
 */
function placeByScore(grid, seed, ind, ctx, buildable, homeSettlementId, claimed, placedSoFar, industryById) {
  const params = ctx.params

  const nearRule = flattenRules(ind.siteRules).find((r) => typeof r === 'string' && r.startsWith('near:'))
  const nearCargo = nearRule ? nearRule.slice('near:'.length) : null
  const nearRadiusCells = params.nearCargoRadiusMiles / grid.cellMiles
  const producerCells = nearCargo
    ? placedSoFar.filter((p) => nearCargo in industryById.get(p.typeId).outputs).map((p) => p.index)
    : []

  const candidates = []
  for (let i = 0; i < buildable.length; i++) {
    if (!buildable[i] || claimed.has(i) || homeSettlementId[i] === 0) continue
    if (!ind.siteRules.some((rule) => evaluateSiteRule(rule, i, ctx))) continue
    candidates.push(i)
  }

  const scored = candidates.map((i) => {
    let score = (rngFor(seed, 'industries', ind.id, 'jitter', i)() - 0.5) * params.jitterStrength

    if (nearCargo && producerCells.length > 0) {
      const x = i % grid.width
      const y = Math.floor(i / grid.width)
      let minDistCells = Infinity
      for (const pc of producerCells) {
        const px = pc % grid.width
        const py = Math.floor(pc / grid.width)
        const d = Math.sqrt((x - px) ** 2 + (y - py) ** 2)
        if (d < minDistCells) minDistCells = d
      }
      if (minDistCells <= nearRadiusCells) score += params.nearCargoBonus
    }

    return { i, score }
  })
  scored.sort((a, b) => b.score - a.score)

  const count = int(rngFor(seed, 'industries', ind.id, 'count'), params.countMin, params.countMax)
  const perHomeCount = new Map()
  const sites = []

  for (const c of scored) {
    if (sites.length >= count) break
    const home = homeSettlementId[c.i]
    const already = perHomeCount.get(home) ?? 0
    if (already >= ind.maxPerNode) continue

    claimed.add(c.i)
    perHomeCount.set(home, already + 1)
    sites.push({ index: c.i, homeSettlementId: home })
  }

  return sites
}

/**
 * Builds colliery tramways (DESIGN 5.5/5.6): a tier 0 rail link from
 * every coal or iron mine to its nearest port-or-town-or-larger
 * settlement, routed with the same terrain rules as roads. Possible
 * only now that mines are real industry entities with their own id.
 *
 * @param {object} grid The world grid.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {import('../state.js').Industry[]} industries Placed industries.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @returns {import('../state.js').Link[]} Tramway links, with ids local to this call (the caller renumbers when merging with the main link list).
 */
function buildTramwayLinks(grid, mapgenRules, terrainRules, industries, settlements) {
  const mines = industries.filter((ind) => ind.typeId === 'coal_mine' || ind.typeId === 'iron_mine')
  if (mines.length === 0) return []

  const targets = settlements.filter((s) => s.portTier > 0 || KIND_RANK[s.kind] <= KIND_RANK.town)
  if (targets.length === 0) return []

  const links = []
  let nextId = 1

  for (const mine of mines) {
    let nearest = null
    let nearestDistance = Infinity
    for (const t of targets) {
      const dx = mine.x - t.x
      const dy = mine.y - t.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < nearestDistance) {
        nearestDistance = d
        nearest = t
      }
    }
    if (!nearest) continue

    const mineIndex = indexOf(grid, Math.round(mine.x / grid.cellMiles), Math.round(mine.y / grid.cellMiles))
    const targetIndex = indexOf(grid, Math.round(nearest.x / grid.cellMiles), Math.round(nearest.y / grid.cellMiles))
    const routed = routeTerrainLink(grid, mapgenRules, terrainRules, mineIndex, targetIndex)
    if (!routed) continue

    links.push({
      id: nextId++,
      aType: 'i',
      aId: mine.id,
      bType: 's',
      bId: nearest.id,
      mode: 'rail',
      tier: 0,
      lengthMi: routed.lengthMi,
      gradient: routed.gradient,
      condition: 1,
      owner: 'public',
      path: routed.path,
      recentFlow: {},
    })
  }

  return links
}

/**
 * Trims the longest tramways first until the combined rail mileage
 * (the main network's own rail links plus these tramways) is back
 * within `maxRailShareOfRoadMiles` of the road network's total.
 * `generateLinks`' own rail skeleton already respects this cap in
 * isolation, but tramways are built afterwards, once mines exist, and
 * add more rail mileage on top — without this, the combined total
 * could creep past DESIGN 5.3's "rail miles at most 15 percent of
 * road miles" even though neither piece broke it on its own.
 *
 * @param {object[]} tramwayLinks Tramway links from buildTramwayLinks().
 * @param {import('../state.js').Link[]} mainLinks The main network from generateLinks().
 * @param {number} maxRailShareOfRoadMiles mapgen.json's links.maxRailShareOfRoadMiles.
 * @returns {object[]} The tramway links, possibly with the longest ones dropped.
 */
function capCombinedRailMileage(tramwayLinks, mainLinks, maxRailShareOfRoadMiles) {
  const roadTotal = mainLinks.filter((l) => l.mode === 'road').reduce((sum, l) => sum + l.lengthMi, 0)
  const mainRailTotal = mainLinks.filter((l) => l.mode === 'rail').reduce((sum, l) => sum + l.lengthMi, 0)
  const maxRailMiles = roadTotal * maxRailShareOfRoadMiles

  let total = mainRailTotal + tramwayLinks.reduce((sum, l) => sum + l.lengthMi, 0)
  if (total <= maxRailMiles) return tramwayLinks

  const sorted = tramwayLinks.slice().sort((a, b) => b.lengthMi - a.lengthMi)
  const dropped = new Set()
  for (const l of sorted) {
    if (total <= maxRailMiles) break
    dropped.add(l)
    total -= l.lengthMi
  }

  return tramwayLinks.filter((l) => !dropped.has(l))
}

/**
 * Generates the initial set of industries end to end (DESIGN 5.6):
 * one per qualifying resource deposit for resource-sited primaries,
 * a scored and counted selection for every other industry, each
 * assigned a home settlement within 10 miles, gated to those already
 * open by `startYear`. Also builds colliery tramways for any placed
 * coal or iron mines, capped so the combined rail network (main
 * skeleton plus tramways) still respects `maxRailShareOfRoadMiles`.
 *
 * @param {object} grid A world grid with landuse/slope/river/coast/
 *   resource already populated.
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {object[]} industriesCatalogue The validated industries.json entries.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {{coal: object[], iron: object[], stone: object[], clay: object[]}} deposits From sim/mapgen/resources.js.
 * @param {number} startYear The save's start year; industries with `eraFrom` after this are skipped.
 * @param {import('../state.js').Link[]} mainLinks The road/rail/sea/world network from generateLinks(), used only to size the rail-share cap.
 * @returns {{industries: import('../state.js').Industry[], tramwayLinks: import('../state.js').Link[]}}
 */
export function generateIndustries(grid, seed, mapgenRules, industriesCatalogue, terrainRules, settlements, deposits, startYear, mainLinks) {
  const buildable = computeBuildableMask(grid, terrainRules, mapgenRules.industries.riverMinWidthClass)
  const homeSettlementId = computeHomeSettlementIds(grid, settlements, mapgenRules.industries.homeSettlementRadiusMiles)
  const ctx = buildSitingContext(grid, mapgenRules, terrainRules, industriesCatalogue, settlements)
  const industryById = new Map(industriesCatalogue.map((ind) => [ind.id, ind]))

  const isEraEligible = (ind) => ind.eraFrom <= startYear && (ind.eraTo == null || startYear <= ind.eraTo)

  const claimed = new Set()
  const placed = []
  let nextId = 1

  for (const ind of industriesCatalogue) {
    if (!isEraEligible(ind)) continue

    const resourceRule = flattenRules(ind.siteRules).find((r) => typeof r === 'string' && r.startsWith('resource:'))
    const sites = resourceRule
      ? placeOnDeposits(ind, deposits[resourceRule.slice('resource:'.length)] ?? [], buildable, homeSettlementId, claimed)
      : placeByScore(grid, seed, ind, ctx, buildable, homeSettlementId, claimed, placed, industryById)

    for (const site of sites) {
      placed.push({ id: nextId++, typeId: ind.id, index: site.index, homeSettlementId: site.homeSettlementId })
    }
  }

  const industries = placed.map((p) => {
    const def = industryById.get(p.typeId)
    return {
      id: p.id,
      typeId: p.typeId,
      name: def.name,
      x: (p.index % grid.width) * grid.cellMiles,
      y: Math.floor(p.index / grid.width) * grid.cellMiles,
      homeSettlementId: p.homeSettlementId,
      capacity: 1,
      utilisation: 1,
      richnessLeft: 1,
      openedDay: 0,
      closedDay: null,
      monthsLow: 0,
      stock: {},
    }
  })

  const rawTramwayLinks = buildTramwayLinks(grid, mapgenRules, terrainRules, industries, settlements)
  const tramwayLinks = capCombinedRailMileage(rawTramwayLinks, mainLinks, mapgenRules.links.maxRailShareOfRoadMiles)

  return { industries, tramwayLinks }
}
