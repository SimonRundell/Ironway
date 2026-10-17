/**
 * Builds the initial link network: a road graph connecting every
 * settlement (nearest neighbours, rank-aware, with a connectivity
 * guarantee and a few cycle edges), a rail skeleton from the capital
 * to its largest cities, coastal sea lanes between ports, and a
 * virtual world link at every port. DESIGN.md 5.5.
 *
 * Colliery tramways (DESIGN 5.5's "short tramways from coal and iron
 * mines to the nearest river port or town") are deliberately left for
 * T1.11: no industry entities exist yet at this point in the pipeline
 * (T1.10 runs before T1.11), and a tramway without a real industry id
 * at one end would need an invented, throwaway entity type. T1.11
 * places the mine industries directly on the resource deposit cells
 * this module could already see, so it is the natural place to add
 * their tramways once they have a real `industryId` to attach to.
 *
 * @module sim/mapgen/links
 */

import { indexOf, neighbours8 } from './grid.js'
import { int, rngFor } from '../rng.js'

/** @type {Record<string, number>} Settlement kind to rank, smallest number is biggest. */
const KIND_RANK = Object.freeze({ capital: 0, city: 1, town: 2, village: 3, hamlet: 4 })

/**
 * A small binary min-heap keyed by a numeric priority, used by
 * findPath() as the A* open set.
 */
class MinHeap {
  constructor() {
    /** @type {{index: number, priority: number}[]} */
    this.items = []
  }

  get size() {
    return this.items.length
  }

  /**
   * @param {number} index A grid cell index.
   * @param {number} priority Its f-score.
   * @returns {void}
   */
  push(index, priority) {
    this.items.push({ index, priority })
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.items[parent].priority <= this.items[i].priority) break
      ;[this.items[parent], this.items[i]] = [this.items[i], this.items[parent]]
      i = parent
    }
  }

  /**
   * @returns {{index: number, priority: number}} The lowest-priority item.
   */
  pop() {
    const top = this.items[0]
    const last = this.items.pop()
    if (this.items.length > 0) {
      this.items[0] = last
      let i = 0
      const n = this.items.length
      while (true) {
        let smallest = i
        const left = 2 * i + 1
        const right = 2 * i + 2
        if (left < n && this.items[left].priority < this.items[smallest].priority) smallest = left
        if (right < n && this.items[right].priority < this.items[smallest].priority) smallest = right
        if (smallest === i) break
        ;[this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]]
        i = smallest
      }
    }
    return top
  }
}

/**
 * A* search over the grid's 8-connected cells. The heuristic (straight
 * -line distance in miles) is admissible as long as `stepCost` never
 * returns less than the step's own distance, which every cost function
 * in this module upholds (each only ever adds non-negative penalties on
 * top of the distance moved).
 *
 * @param {object} grid The world grid.
 * @param {number} startIndex Starting cell index.
 * @param {number} goalIndex Goal cell index.
 * @param {(index: number) => boolean} isPassable Whether a cell can be entered at all.
 * @param {(fromIndex: number, toIndex: number, stepDistanceMiles: number) => number} stepCost
 *   Cost of moving from one cell to an adjacent one; return `Infinity` to forbid the step.
 * @returns {{cells: number[], cost: number}|null} The path (start to goal inclusive) and its total cost, or null if unreachable.
 */
export function findPath(grid, startIndex, goalIndex, isPassable, stepCost) {
  const size = grid.width * grid.height
  const gScore = new Float64Array(size).fill(Infinity)
  const cameFrom = new Int32Array(size).fill(-1)
  const visited = new Uint8Array(size)
  const heap = new MinHeap()

  const goalX = goalIndex % grid.width
  const goalY = Math.floor(goalIndex / grid.width)

  /**
   * @param {number} index A cell index.
   * @returns {number} Straight-line distance to the goal, in miles.
   */
  function heuristic(index) {
    const x = index % grid.width
    const y = Math.floor(index / grid.width)
    const dx = x - goalX
    const dy = y - goalY
    return Math.sqrt(dx * dx + dy * dy) * grid.cellMiles
  }

  gScore[startIndex] = 0
  heap.push(startIndex, heuristic(startIndex))

  while (heap.size > 0) {
    const current = heap.pop().index
    if (visited[current]) continue
    visited[current] = 1
    if (current === goalIndex) break

    const x = current % grid.width
    const y = Math.floor(current / grid.width)

    for (const [nx, ny] of neighbours8(grid, x, y)) {
      const next = indexOf(grid, nx, ny)
      if (visited[next] || !isPassable(next)) continue

      const dx = nx - x
      const dy = ny - y
      const stepDistanceMiles = Math.sqrt(dx * dx + dy * dy) * grid.cellMiles
      const cost = stepCost(current, next, stepDistanceMiles)
      if (cost === Infinity) continue

      const tentativeG = gScore[current] + cost
      if (tentativeG < gScore[next]) {
        gScore[next] = tentativeG
        cameFrom[next] = current
        heap.push(next, tentativeG + heuristic(next))
      }
    }
  }

  if (gScore[goalIndex] === Infinity) return null

  const cells = []
  let cur = goalIndex
  while (cur !== -1) {
    cells.push(cur)
    cur = cameFrom[cur]
  }
  cells.reverse()

  return { cells, cost: gScore[goalIndex] }
}

/**
 * Converts a cell-index path to [x, y] points in world miles.
 *
 * @param {object} grid The world grid.
 * @param {number[]} cells Cell indices, in path order.
 * @returns {number[][]} [x, y] points in miles, in the same order.
 */
function cellsToMilePoints(grid, cells) {
  return cells.map((i) => [(i % grid.width) * grid.cellMiles, Math.floor(i / grid.width) * grid.cellMiles])
}

/**
 * Sums consecutive point-to-point distances. Always run on the full
 * -resolution path, not the Douglas-Peucker-simplified one, since
 * simplification shortens a polyline's total length.
 *
 * @param {number[][]} points [x, y] points in miles.
 * @returns {number} Total length in miles.
 */
function pathLengthMiles(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0]
    const dy = points[i][1] - points[i - 1][1]
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

/**
 * The steepest single-cell slope ratio encountered anywhere along a
 * path, read directly from the already-computed `slope` layer.
 *
 * @param {object} grid The world grid.
 * @param {number} slopeScale mapgen.json's slope.quantizationScale.
 * @param {number[]} cells Cell indices, in path order.
 * @returns {number} The steepest ratio, 0 if the path is empty.
 */
function pathGradient(grid, slopeScale, cells) {
  let steepest = 0
  for (const i of cells) {
    const ratio = grid.slope[i] / slopeScale
    if (ratio > steepest) steepest = ratio
  }
  return steepest
}

/**
 * Perpendicular distance from a point to the line through two others
 * (falling back to point-to-point distance when they coincide).
 *
 * @param {number[]} point [x, y].
 * @param {number[]} lineStart [x, y].
 * @param {number[]} lineEnd [x, y].
 * @returns {number} Distance in the same units as the input points.
 */
function perpendicularDistance(point, lineStart, lineEnd) {
  const [x, y] = point
  const [x1, y1] = lineStart
  const [x2, y2] = lineEnd
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy

  if (lengthSq === 0) {
    const ddx = x - x1
    const ddy = y - y1
    return Math.sqrt(ddx * ddx + ddy * ddy)
  }

  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq))
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  const ddx = x - projX
  const ddy = y - projY
  return Math.sqrt(ddx * ddx + ddy * ddy)
}

/**
 * Douglas-Peucker polyline simplification, so a long A* path (one
 * point per grid cell) becomes a short list of waypoints for storage,
 * well under DESIGN 5.3's "path JSON under 4 KB per link" budget.
 *
 * @param {number[][]} points [x, y] points, in order.
 * @param {number} toleranceMiles Maximum perpendicular deviation allowed when dropping a point.
 * @returns {number[][]} A simplified point list, always keeping the first and last point.
 */
function simplifyPath(points, toleranceMiles) {
  if (points.length <= 2) return points.slice()

  let maxDist = 0
  let maxIndex = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1])
    if (d > maxDist) {
      maxDist = d
      maxIndex = i
    }
  }

  if (maxDist > toleranceMiles) {
    const left = simplifyPath(points.slice(0, maxIndex + 1), toleranceMiles)
    const right = simplifyPath(points.slice(maxIndex), toleranceMiles)
    return left.slice(0, -1).concat(right)
  }

  return [points[0], points[points.length - 1]]
}

/**
 * Finds a land cell's grid index from its settlement record (stored in
 * world miles).
 *
 * @param {object} grid The world grid.
 * @param {{x: number, y: number}} settlement A settlement.
 * @returns {number} The cell index.
 */
function settlementCellIndex(grid, settlement) {
  return indexOf(grid, Math.round(settlement.x / grid.cellMiles), Math.round(settlement.y / grid.cellMiles))
}

/**
 * Finds a sea cell adjacent to a land cell, as the entry point for sea
 * -lane routing from a port settlement.
 *
 * @param {object} grid The world grid.
 * @param {number} landIndex A land cell index.
 * @returns {number|null} An adjacent sea cell index, or null if none (shouldn't happen for an actual port).
 */
function findAdjacentSeaCell(grid, landIndex) {
  const x = landIndex % grid.width
  const y = Math.floor(landIndex / grid.width)
  for (const [nx, ny] of neighbours8(grid, x, y)) {
    const ni = indexOf(grid, nx, ny)
    if (grid.water[ni] === 1) return ni
  }
  return null
}

/**
 * Union-find over node indices 0..n-1.
 */
class UnionFind {
  /**
   * @param {number} n Node count.
   */
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }

  /**
   * @param {number} x A node index.
   * @returns {number} The root of x's set.
   */
  find(x) {
    while (this.parent[x] !== x) x = this.parent[x]
    return x
  }

  /**
   * @param {number} a A node index.
   * @param {number} b A node index.
   * @returns {void}
   */
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}

/**
 * Ensures a graph over `nodes` (each with `x`/`y` in miles) is
 * connected, by repeatedly bridging the two components whose nearest
 * pair (by straight-line distance) has the cheapest real route
 * between them, until only one component remains. Checking only the
 * single nearest candidate pair per component pair (rather than every
 * pair of nodes across both) keeps this bounded even for a graph with
 * hundreds of nodes, since disconnected components are expected to be
 * rare and small once the nearest-neighbour edges are already in
 * place.
 *
 * @param {{x: number, y: number}[]} nodes Settlements or ports.
 * @param {[number, number][]} edges Existing edges (node index pairs); extended in place.
 * @param {(a: {x: number, y: number}, b: {x: number, y: number}) => number} routeCost
 *   Real cost between two nodes (e.g. via findPath()); `Infinity` if there is truly no route.
 * @returns {[number, number][]} The edge list (same array, for convenience).
 */
function ensureConnectivity(nodes, edges, routeCost) {
  const uf = new UnionFind(nodes.length)
  for (const [a, b] of edges) uf.union(a, b)

  while (true) {
    const components = new Map()
    for (let i = 0; i < nodes.length; i++) {
      const root = uf.find(i)
      if (!components.has(root)) components.set(root, [])
      components.get(root).push(i)
    }
    if (components.size <= 1) break

    const groups = [...components.values()]
    let best = null

    for (let ci = 0; ci < groups.length; ci++) {
      for (let cj = ci + 1; cj < groups.length; cj++) {
        let nearest = null
        for (const i of groups[ci]) {
          for (const j of groups[cj]) {
            const dx = nodes[i].x - nodes[j].x
            const dy = nodes[i].y - nodes[j].y
            const d = Math.sqrt(dx * dx + dy * dy)
            if (!nearest || d < nearest.d) nearest = { i, j, d }
          }
        }
        const cost = routeCost(nodes[nearest.i], nodes[nearest.j])
        if (!best || cost < best.cost) best = { i: nearest.i, j: nearest.j, cost }
      }
    }

    edges.push([Math.min(best.i, best.j), Math.max(best.i, best.j)])
    uf.union(best.i, best.j)
  }

  return edges
}

/**
 * Builds each settlement's nearest-neighbour road edges (DESIGN 5.4:
 * "Connect each settlement to its 2 to 3 nearest neighbours
 * (rank-aware: villages attach upward)"). A neighbour at least as big
 * as the settlement itself counts as closer than its raw distance
 * would suggest, biasing the network towards a hub-and-spoke shape. If
 * a candidate edge already exists (added while processing the other
 * end), it still counts towards this settlement's quota.
 *
 * @param {string} seed The save's seed.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {object} linksParams mapgen.json's links settings.
 * @returns {[number, number][]} Edges as settlement-array index pairs.
 */
function buildNearestNeighbourEdges(seed, settlements, linksParams) {
  const edgeSet = new Set()
  const edges = []

  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i]
    const count = int(
      rngFor(seed, 'links', 'road-nn-count', s.id),
      linksParams.roadNearestNeighboursMin,
      linksParams.roadNearestNeighboursMax,
    )

    const candidates = []
    for (let j = 0; j < settlements.length; j++) {
      if (j === i) continue
      const other = settlements[j]
      const dx = s.x - other.x
      const dy = s.y - other.y
      const rawDistance = Math.sqrt(dx * dx + dy * dy)
      const upward = KIND_RANK[other.kind] <= KIND_RANK[s.kind] ? linksParams.upwardBonusFactor : 1
      candidates.push({ j, effectiveDistance: rawDistance / upward })
    }
    candidates.sort((a, b) => a.effectiveDistance - b.effectiveDistance)

    let added = 0
    for (const c of candidates) {
      if (added >= count) break
      const a = Math.min(i, c.j)
      const b = Math.max(i, c.j)
      const key = `${a}-${b}`
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        edges.push([a, b])
      }
      added++
    }
  }

  return edges
}

/**
 * Adds a few extra cycle edges per settlement using a relative
 * -neighbourhood-graph filter (DESIGN 5.4): among a settlement's
 * nearest not-yet-connected candidates, one qualifies if no third
 * settlement is closer to both ends than they are to each other.
 * Candidates are pre-limited to the 10 nearest before the filter runs,
 * so cost stays bounded on a large settlement count.
 *
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {[number, number][]} edges Existing edges; extended in place.
 * @param {object} linksParams mapgen.json's links settings.
 * @returns {[number, number][]} The edge list (same array, for convenience).
 */
function addCycleEdges(settlements, edges, linksParams) {
  const edgeSet = new Set(edges.map(([a, b]) => `${a}-${b}`))

  /**
   * @param {number} i Settlement-array index.
   * @param {number} j Settlement-array index.
   * @returns {number} Straight-line distance in miles.
   */
  function distance(i, j) {
    const dx = settlements[i].x - settlements[j].x
    const dy = settlements[i].y - settlements[j].y
    return Math.sqrt(dx * dx + dy * dy)
  }

  for (let i = 0; i < settlements.length; i++) {
    const candidates = []
    for (let j = 0; j < settlements.length; j++) {
      if (j === i) continue
      const a = Math.min(i, j)
      const b = Math.max(i, j)
      if (edgeSet.has(`${a}-${b}`)) continue
      candidates.push({ j, d: distance(i, j) })
    }
    candidates.sort((a, b) => a.d - b.d)

    let added = 0
    for (const c of candidates.slice(0, 10)) {
      if (added >= linksParams.cycleEdgeMaxPerSettlement) break

      let isRelativeNeighbour = true
      for (let k = 0; k < settlements.length; k++) {
        if (k === i || k === c.j) continue
        if (distance(i, k) < c.d && distance(c.j, k) < c.d) {
          isRelativeNeighbour = false
          break
        }
      }

      if (isRelativeNeighbour) {
        const a = Math.min(i, c.j)
        const b = Math.max(i, c.j)
        edgeSet.add(`${a}-${b}`)
        edges.push([a, b])
        added++
      }
    }
  }

  return edges
}

/**
 * The road terrain cost: distance, plus a slope penalty scaled by
 * distance, plus a flat river-crossing penalty, plus a flat marsh
 * penalty. `rock` and sea cells are impassable. DESIGN 5.4.
 *
 * @param {object} grid The world grid.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {object} linksParams mapgen.json's links settings.
 * @param {number} rockIndex terrain.json's landuseEnum index for `rock`.
 * @param {number} marshIndex terrain.json's landuseEnum index for `marsh`.
 * @returns {{isPassable: (index: number) => boolean, stepCost: (from: number, to: number, stepDistanceMiles: number) => number}}
 */
function roadTerrainCost(grid, mapgenRules, linksParams, rockIndex, marshIndex) {
  const slopeScale = mapgenRules.slope.quantizationScale

  return {
    isPassable: (index) => grid.water[index] === 0 && grid.landuse[index] !== rockIndex,
    stepCost: (from, to, stepDistanceMiles) => {
      let cost = stepDistanceMiles
      cost += (grid.slope[to] / slopeScale) * linksParams.roadSlopeWeight * stepDistanceMiles
      if (grid.river[to] > 0 || grid.river[from] > 0) cost += linksParams.roadRiverCrossingPenaltyMiles
      if (grid.landuse[to] === marshIndex) cost += linksParams.roadMarshPenaltyMiles
      return cost
    },
  }
}

/**
 * Paths and records a set of settlement-to-settlement edges as links
 * of one `mode`, computing length, gradient and a simplified path for
 * each. Edges whose path turns out to be unreachable are skipped
 * (shouldn't happen on the main landmass, but a single generation run
 * should never throw over it).
 *
 * @param {object} grid The world grid.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {[number, number][]} edges Settlement-array index pairs.
 * @param {{isPassable: Function, stepCost: Function}} terrainCost From roadTerrainCost() (or an equivalent).
 * @param {object} linksParams mapgen.json's links settings.
 * @param {number} slopeScale mapgen.json's slope.quantizationScale.
 * @param {(a: import('../state.js').Settlement, b: import('../state.js').Settlement) => number} tierFor Picks the link tier for an edge.
 * @param {string} mode `road` or `rail`.
 * @returns {object[]} Partial link records (aSettlementId, bSettlementId, mode, tier, lengthMi, gradient, path).
 */
function buildTerrainLinks(grid, settlements, edges, terrainCost, linksParams, slopeScale, tierFor, mode) {
  const links = []

  for (const [ai, bi] of edges) {
    const a = settlements[ai]
    const b = settlements[bi]
    const result = findPath(grid, settlementCellIndex(grid, a), settlementCellIndex(grid, b), terrainCost.isPassable, terrainCost.stepCost)
    if (!result) continue

    const points = cellsToMilePoints(grid, result.cells)
    links.push({
      aSettlementId: a.id,
      bSettlementId: b.id,
      mode,
      tier: tierFor(a, b),
      lengthMi: pathLengthMiles(points),
      gradient: pathGradient(grid, slopeScale, result.cells),
      path: simplifyPath(points, linksParams.pathSimplifyToleranceMiles),
    })
  }

  return links
}

/**
 * Builds the road network (DESIGN 5.4): rank-aware nearest-neighbour
 * edges, a connectivity guarantee, a few cycle edges, then paths and
 * tiers every edge (tier 1 "turnpike" between the capital and a city
 * or between two cities, tier 0 "cart track" everywhere else).
 *
 * @param {object} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @returns {object[]} Partial road link records.
 */
function buildRoadNetwork(grid, seed, settlements, mapgenRules, terrainRules) {
  const linksParams = mapgenRules.links
  const rockIndex = terrainRules.landuseEnum.indexOf('rock')
  const marshIndex = terrainRules.landuseEnum.indexOf('marsh')
  const terrainCost = roadTerrainCost(grid, mapgenRules, linksParams, rockIndex, marshIndex)

  const edges = buildNearestNeighbourEdges(seed, settlements, linksParams)
  ensureConnectivity(settlements, edges, (a, b) => {
    const result = findPath(grid, settlementCellIndex(grid, a), settlementCellIndex(grid, b), terrainCost.isPassable, terrainCost.stepCost)
    return result ? result.cost : Infinity
  })
  addCycleEdges(settlements, edges, linksParams)

  const isTurnpike = (a, b) => {
    const isBigA = a.kind === 'capital' || a.kind === 'city'
    const isBigB = b.kind === 'capital' || b.kind === 'city'
    return isBigA && isBigB ? 1 : 0
  }

  return buildTerrainLinks(grid, settlements, edges, terrainCost, linksParams, mapgenRules.slope.quantizationScale, isTurnpike, 'road')
}

/**
 * Builds the rail skeleton (DESIGN 5.4): tier 0 lines from the capital
 * to its 3 to 5 largest cities, where the same terrain rules as roads
 * allow a route at all, capped so total rail mileage never exceeds
 * `maxRailShareOfRoadMiles` of the road network's own total (the
 * longest lines are dropped first if it would).
 *
 * @param {object} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {number} roadTotalMiles The road network's total length, for the cap.
 * @returns {object[]} Partial rail link records.
 */
function buildRailSkeleton(grid, seed, settlements, mapgenRules, terrainRules, roadTotalMiles) {
  const linksParams = mapgenRules.links
  const rockIndex = terrainRules.landuseEnum.indexOf('rock')
  const marshIndex = terrainRules.landuseEnum.indexOf('marsh')
  const terrainCost = roadTerrainCost(grid, mapgenRules, linksParams, rockIndex, marshIndex)

  const capital = settlements.find((s) => s.kind === 'capital')
  if (!capital) return []

  const populationOf = (s) => Object.values(s.pop).reduce((sum, c) => sum + c.pop, 0)
  const topN = int(rngFor(seed, 'links', 'rail-skeleton-count'), linksParams.railSkeletonTopCitiesMin, linksParams.railSkeletonTopCitiesMax)
  const cities = settlements.filter((s) => s.kind === 'city').sort((a, b) => populationOf(b) - populationOf(a)).slice(0, topN)

  const edges = cities.map((city) => [settlements.indexOf(capital), settlements.indexOf(city)])
  let railLinks = buildTerrainLinks(grid, settlements, edges, terrainCost, linksParams, mapgenRules.slope.quantizationScale, () => 0, 'rail')

  const maxRailMiles = roadTotalMiles * linksParams.maxRailShareOfRoadMiles
  let total = railLinks.reduce((sum, l) => sum + l.lengthMi, 0)
  if (total > maxRailMiles) {
    const sorted = railLinks.slice().sort((a, b) => b.lengthMi - a.lengthMi)
    const dropped = new Set()
    for (const l of sorted) {
      if (total <= maxRailMiles) break
      dropped.add(l)
      total -= l.lengthMi
    }
    railLinks = railLinks.filter((l) => !dropped.has(l))
  }

  return railLinks
}

/**
 * Builds coastal sea lanes (DESIGN 5.4): nearest-neighbour edges
 * between ports, with the same connectivity guarantee used for roads,
 * routed over sea cells only.
 *
 * @param {object} grid The world grid.
 * @param {string} seed The save's seed.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @returns {object[]} Partial sea link records.
 */
function buildSeaNetwork(grid, seed, settlements, mapgenRules) {
  const linksParams = mapgenRules.links
  const ports = settlements.filter((s) => s.portTier > 0)

  const entryCell = new Map()
  for (const p of ports) entryCell.set(p.id, findAdjacentSeaCell(grid, settlementCellIndex(grid, p)))
  const validPorts = ports.filter((p) => entryCell.get(p.id) != null)
  if (validPorts.length < 2) return []

  const isPassable = (index) => grid.water[index] === 1
  const stepCost = (_from, _to, stepDistanceMiles) => stepDistanceMiles

  const edgeSet = new Set()
  const edges = []
  for (let i = 0; i < validPorts.length; i++) {
    const count = int(rngFor(seed, 'links', 'sea-nn-count', validPorts[i].id), linksParams.seaNearestNeighboursMin, linksParams.seaNearestNeighboursMax)
    const candidates = []
    for (let j = 0; j < validPorts.length; j++) {
      if (j === i) continue
      const dx = validPorts[i].x - validPorts[j].x
      const dy = validPorts[i].y - validPorts[j].y
      candidates.push({ j, d: Math.sqrt(dx * dx + dy * dy) })
    }
    candidates.sort((a, b) => a.d - b.d)

    let added = 0
    for (const c of candidates) {
      if (added >= count) break
      const a = Math.min(i, c.j)
      const b = Math.max(i, c.j)
      const key = `${a}-${b}`
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        edges.push([a, b])
      }
      added++
    }
  }

  ensureConnectivity(validPorts, edges, (a, b) => {
    const result = findPath(grid, entryCell.get(a.id), entryCell.get(b.id), isPassable, stepCost)
    return result ? result.cost : Infinity
  })

  const links = []
  for (const [ai, bi] of edges) {
    const a = validPorts[ai]
    const b = validPorts[bi]
    const result = findPath(grid, entryCell.get(a.id), entryCell.get(b.id), isPassable, stepCost)
    if (!result) continue

    const points = [[a.x, a.y], ...cellsToMilePoints(grid, result.cells), [b.x, b.y]]
    links.push({
      aSettlementId: a.id,
      bSettlementId: b.id,
      mode: 'sea',
      tier: 0,
      lengthMi: pathLengthMiles(points),
      gradient: 0,
      path: simplifyPath(points, linksParams.pathSimplifyToleranceMiles),
    })
  }

  return links
}

/**
 * Builds the virtual world link every port has, for imports and
 * exports (DESIGN 5.4, 5.5, used by 7.9).
 *
 * @param {import('../state.js').Settlement[]} settlements Placed settlements.
 * @returns {object[]} Partial world link records (bSettlementId is 0, meaning the world node).
 */
function buildWorldLinks(settlements) {
  return settlements.filter((s) => s.portTier > 0).map((s) => ({
    aSettlementId: s.id,
    bSettlementId: 0,
    mode: 'sea',
    tier: s.portTier,
    lengthMi: 0,
    gradient: 0,
    path: [],
  }))
}

/**
 * Generates the initial link network end to end (DESIGN 5.5): roads,
 * rail skeleton, sea lanes and world links, assembled into full
 * `Link` records (state.js's shape) with sequential ids.
 *
 * @param {object} grid A world grid with landuse/slope/river/water
 *   already populated.
 * @param {string} seed The save's seed.
 * @param {object} mapgenRules The validated mapgen.json rules.
 * @param {{landuseEnum: string[]}} terrainRules The validated terrain.json rules.
 * @param {import('../state.js').Settlement[]} settlements Placed settlements (see sim/mapgen/settlements.js).
 * @returns {import('../state.js').Link[]}
 */
export function generateLinks(grid, seed, mapgenRules, terrainRules, settlements) {
  const roadLinks = buildRoadNetwork(grid, seed, settlements, mapgenRules, terrainRules)
  const roadTotalMiles = roadLinks.reduce((sum, l) => sum + l.lengthMi, 0)
  const railLinks = buildRailSkeleton(grid, seed, settlements, mapgenRules, terrainRules, roadTotalMiles)
  const seaLinks = buildSeaNetwork(grid, seed, settlements, mapgenRules)
  const worldLinks = buildWorldLinks(settlements)

  let nextId = 1
  return [...roadLinks, ...railLinks, ...seaLinks, ...worldLinks].map((l) => ({
    id: nextId++,
    aType: 's',
    aId: l.aSettlementId,
    bType: l.bSettlementId === 0 ? 'w' : 's',
    bId: l.bSettlementId,
    mode: l.mode,
    tier: l.tier,
    lengthMi: l.lengthMi,
    gradient: l.gradient,
    condition: 1,
    owner: 'public',
    path: l.path,
  }))
}
