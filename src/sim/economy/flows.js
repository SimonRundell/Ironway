/**
 * Baseline carrier flows (DESIGN 7.5): the slow, lossy "trickle" that
 * moves goods between nodes with no player services at all. Computed
 * synchronously from a snapshot (DESIGN's own words) so the result
 * never depends on the order links or cargoes happen to be listed in —
 * every function here reads its inputs, builds candidate flows, then
 * resolves the two oversubscription passes as pure aggregate
 * operations over those candidates, never mutating anything mid-pass.
 *
 * World/port links (DESIGN 7.9, T1.21) are out of scope here and are
 * skipped entirely: PHASES.md explicitly defers seaport world links to
 * T1.21.
 *
 * @module sim/economy/flows
 */

/**
 * @param {string} type A link endpoint's entity type ('s' settlement, 'i' industry, 'w' world/port).
 * @param {number} id The entity id.
 * @returns {string} A node key, used throughout this module to index `nodeStock`/`nodeDemand`/`nodePrices`.
 */
export function nodeKey(type, id) {
  return `${type}:${id}`
}

/**
 * Looks up a link's monthly freight capacity from `links.json` by mode
 * and tier (Appendix C). Sea links key by port tier the same way
 * road/rail key by their own tier, via `links.json`'s parallel
 * `byPortTier` array.
 *
 * @param {{mode: string, tier: number}} link
 * @param {object} linksRules The validated `links.json` rules.
 * @returns {number} Freight tonnes per month.
 */
export function getLinkCapacity(link, linksRules) {
  if (link.mode === 'sea') {
    return linksRules.sea.byPortTier[link.tier].freightTonnesPerMonth
  }
  return linksRules[link.mode][link.tier].freightTonnesPerMonth
}

/**
 * The DESIGN 7.5 step 4 `gradientFactor(gradient)` term is left
 * unspecified by DESIGN beyond its name. Taken here as the identity
 * function: `desired = min(available*flowRate, available*gradient)`,
 * so a gradient right at `minGradient` moves far less than the
 * `flowRate` ceiling, and `desired` only saturates at the flat
 * `flowRate` cap once the gradient is comfortably larger than it —
 * see DECISIONS.md for why this needs no extra invented constant.
 *
 * @param {number} gradient
 * @returns {number}
 */
function gradientFactor(gradient) {
  return gradient
}

/**
 * @typedef {object} FlowCandidate
 * @property {number} linkId
 * @property {object} link The link entity itself (mode needed for loss lookup).
 * @property {string} cargo
 * @property {string} fromKey The lower-priced node for this cargo on this link.
 * @property {string} toKey The higher-priced node.
 * @property {number} gradient `(price_to - price_from) / price_from`.
 * @property {number} priceFrom The source node's price for this cargo (used for link priority ordering).
 * @property {number} desired Tonnes this candidate wants to move, before oversubscription scaling.
 */

/**
 * Builds every candidate flow across every (non-world) link and every
 * cargo either endpoint holds stock or demand for (DESIGN 7.5 steps
 * 2-4), before either oversubscription pass runs.
 *
 * @param {object[]} links Every link in the world (world/port links are skipped).
 * @param {Map<string, Record<string, number>>} nodeStock Current stock, keyed by `nodeKey()`.
 * @param {Map<string, Record<string, number>>} nodeDemand This month's demand, keyed by `nodeKey()`.
 * @param {Map<string, Set<string>>} nodeProducedCargoes Which cargoes each node produces (reserve 0 on those — DESIGN 7.5 step 3).
 * @param {Map<string, Record<string, number>>} nodePrices Current prices, keyed by `nodeKey()`.
 * @param {object} flowRules `economy.json`'s `flow` block (`minGradient`, `reserveMonths`, `flowRate`).
 * @returns {FlowCandidate[]}
 */
function buildCandidates(links, nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, flowRules) {
  const candidates = []

  for (const link of links) {
    if (link.aType === 'w' || link.bType === 'w') continue // World/port links: T1.21.

    const aKey = nodeKey(link.aType, link.aId)
    const bKey = nodeKey(link.bType, link.bId)
    const pricesA = nodePrices.get(aKey) || {}
    const pricesB = nodePrices.get(bKey) || {}

    const cargoes = new Set([
      ...Object.keys(nodeStock.get(aKey) || {}), ...Object.keys(nodeDemand.get(aKey) || {}),
      ...Object.keys(nodeStock.get(bKey) || {}), ...Object.keys(nodeDemand.get(bKey) || {}),
    ])

    for (const cargo of cargoes) {
      const priceA = pricesA[cargo]
      const priceB = pricesB[cargo]
      if (priceA === undefined || priceB === undefined || priceA === priceB) continue

      const [fromKey, toKey, priceFrom, priceTo] = priceA < priceB ? [aKey, bKey, priceA, priceB] : [bKey, aKey, priceB, priceA]

      const gradient = (priceTo - priceFrom) / priceFrom
      if (gradient < flowRules.minGradient) continue

      const stockFrom = (nodeStock.get(fromKey) || {})[cargo] || 0
      const producesIt = (nodeProducedCargoes.get(fromKey) || new Set()).has(cargo)
      const reserve = producesIt ? 0 : ((nodeDemand.get(fromKey) || {})[cargo] || 0) * flowRules.reserveMonths
      const available = Math.max(0, stockFrom - reserve)
      if (available <= 0) continue

      const desired = Math.min(available * flowRules.flowRate, available * gradientFactor(gradient))
      if (desired <= 0) continue

      candidates.push({ linkId: link.id, link, cargo, fromKey, toKey, gradient, priceFrom, desired })
    }
  }

  return candidates
}

/**
 * DESIGN 7.5 step 5a: if a node's combined desired outflow of one
 * cargo (summed across every link it could leave by) exceeds that
 * node's own available stock, scale every one of that node's
 * candidates for that cargo down proportionally. Order-independent:
 * grouping and summing are both commutative, and every member of a
 * group is scaled by the same ratio regardless of the candidates'
 * original order.
 *
 * @param {FlowCandidate[]} candidates Mutated in place (each candidate's `desired` may shrink).
 * @param {Map<string, Record<string, number>>} nodeStock
 * @param {Map<string, Record<string, number>>} nodeDemand
 * @param {Map<string, Set<string>>} nodeProducedCargoes
 * @param {object} flowRules
 * @returns {void}
 */
function scaleForNodeOversubscription(candidates, nodeStock, nodeDemand, nodeProducedCargoes, flowRules) {
  const groups = new Map() // "fromKey|cargo" -> candidates[]
  for (const candidate of candidates) {
    const groupKey = `${candidate.fromKey}|${candidate.cargo}`
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push(candidate)
  }

  for (const [groupKey, group] of groups) {
    const [fromKey, cargo] = groupKey.split('|')
    const stockFrom = (nodeStock.get(fromKey) || {})[cargo] || 0
    const producesIt = (nodeProducedCargoes.get(fromKey) || new Set()).has(cargo)
    const reserve = producesIt ? 0 : ((nodeDemand.get(fromKey) || {})[cargo] || 0) * flowRules.reserveMonths
    const available = Math.max(0, stockFrom - reserve)

    const totalDesired = group.reduce((sum, c) => sum + c.desired, 0)
    if (totalDesired > available && totalDesired > 0) {
      const ratio = available / totalDesired
      for (const candidate of group) candidate.desired *= ratio
    }
  }
}

/**
 * DESIGN 7.5 step 5b: if a link's total desired flow (summed across
 * every cargo and both directions, since capacity is one shared pool
 * per link) exceeds its baseline capacity, allocate that capacity in
 * order of descending `gradient * priceFrom` (most valuable gradient
 * per tonne first) — full amounts to the highest-priority candidates,
 * then whatever capacity remains to the next, until it runs out.
 * Ties are broken by cargo id and node keys (never by input array
 * position), so the result is identical no matter what order
 * `candidates` arrives in — the explicit "order independence"
 * requirement in PHASES.md's Done-when.
 *
 * @param {FlowCandidate[]} candidates Mutated in place (each candidate gets a final `moved` amount).
 * @param {object} linksRules
 * @param {object} flowRules
 * @returns {void}
 */
function allocateLinkCapacity(candidates, linksRules, flowRules) {
  const byLink = new Map()
  for (const candidate of candidates) {
    if (!byLink.has(candidate.linkId)) byLink.set(candidate.linkId, [])
    byLink.get(candidate.linkId).push(candidate)
  }

  for (const group of byLink.values()) {
    const capacity = getLinkCapacity(group[0].link, linksRules) * flowRules.baselineShare
    const totalDesired = group.reduce((sum, c) => sum + c.desired, 0)

    if (totalDesired <= capacity) {
      for (const candidate of group) candidate.moved = candidate.desired
      continue
    }

    const ordered = [...group].sort((a, b) => {
      const priorityDiff = b.gradient * b.priceFrom - a.gradient * a.priceFrom
      if (priorityDiff !== 0) return priorityDiff
      if (a.cargo !== b.cargo) return a.cargo < b.cargo ? -1 : 1
      if (a.fromKey !== b.fromKey) return a.fromKey < b.fromKey ? -1 : 1
      return a.toKey < b.toKey ? -1 : a.toKey > b.toKey ? 1 : 0
    })

    let remaining = capacity
    for (const candidate of ordered) {
      candidate.moved = Math.min(candidate.desired, remaining)
      remaining -= candidate.moved
    }
  }
}

/**
 * @typedef {object} FlowResult
 * @property {number} linkId
 * @property {string} cargo
 * @property {string} fromKey
 * @property {string} toKey
 * @property {number} moved Tonnes that left `fromKey` (never exceeds the link's baseline capacity share).
 * @property {number} received Tonnes that arrived at `toKey` (`moved * (1 - loss)`).
 */

/**
 * Runs DESIGN 7.5's full baseline flow algorithm for one month, from a
 * snapshot of prices/stock/demand. Pure: returns the flow results
 * without mutating `nodeStock` — call `applyBaselineFlows()` with the
 * result to actually move the stock.
 *
 * @param {object} params
 * @param {object[]} params.links Every link in the world.
 * @param {Map<string, Record<string, number>>} params.nodeStock Current stock, keyed by `nodeKey()`.
 * @param {Map<string, Record<string, number>>} params.nodeDemand This month's demand, keyed by `nodeKey()`.
 * @param {Map<string, Set<string>>} params.nodeProducedCargoes Which cargoes each node produces.
 * @param {Map<string, Record<string, number>>} params.nodePrices Current prices, keyed by `nodeKey()`.
 * @param {object} params.linksRules The validated `links.json` rules.
 * @param {object} params.flowRules `economy.json`'s `flow` block.
 * @returns {FlowResult[]}
 */
export function computeBaselineFlows({ links, nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, linksRules, flowRules }) {
  const candidates = buildCandidates(links, nodeStock, nodeDemand, nodeProducedCargoes, nodePrices, flowRules)
  scaleForNodeOversubscription(candidates, nodeStock, nodeDemand, nodeProducedCargoes, flowRules)
  allocateLinkCapacity(candidates, linksRules, flowRules)

  const lossByMode = flowRules.baselineLossByMode

  return candidates
    .filter((c) => c.moved > 0)
    .map((c) => ({
      linkId: c.linkId,
      cargo: c.cargo,
      fromKey: c.fromKey,
      toKey: c.toKey,
      moved: c.moved,
      received: c.moved * (1 - lossByMode[c.link.mode]),
    }))
}

/**
 * Applies a set of flow results to a stock snapshot (DESIGN 7.5 step
 * 6): source loses `moved`, destination gains `received`. Returns a
 * new map; `nodeStock` is not mutated.
 *
 * @param {Map<string, Record<string, number>>} nodeStock
 * @param {FlowResult[]} flowResults From `computeBaselineFlows()`.
 * @returns {Map<string, Record<string, number>>}
 */
export function applyBaselineFlows(nodeStock, flowResults) {
  const next = new Map()
  for (const [key, stock] of nodeStock) next.set(key, { ...stock })

  for (const { cargo, fromKey, toKey, moved, received } of flowResults) {
    if (!next.has(fromKey)) next.set(fromKey, {})
    if (!next.has(toKey)) next.set(toKey, {})
    const fromStock = next.get(fromKey)
    const toStock = next.get(toKey)
    fromStock[cargo] = (fromStock[cargo] || 0) - moved
    toStock[cargo] = (toStock[cargo] || 0) + received
  }

  return next
}
