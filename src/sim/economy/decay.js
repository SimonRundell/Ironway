/**
 * Monthly perishable stock decay (DESIGN 7.1 step 5): each cargo's own
 * `decayPerMonth` (`cargo.json`) shrinks whatever of it is sitting in
 * stock, before that month's production is added on top. Durable
 * cargoes (`decayPerMonth: 0`, e.g. coal, iron, bricks) are
 * unaffected.
 *
 * @module sim/economy/decay
 */

/**
 * Applies one month's decay to a stock map.
 *
 * @param {Record<string, number>} stock A settlement's or industry's current stock, keyed by cargo id.
 * @param {Array<{id: string, decayPerMonth: number}>} cargoCatalogue The validated `cargo.json` list.
 * @returns {Record<string, number>} The decayed stock (a new object; `stock` is not mutated).
 */
export function decayStock(stock, cargoCatalogue) {
  const decayById = new Map(cargoCatalogue.map((c) => [c.id, c.decayPerMonth]))
  const next = {}

  for (const [cargo, qty] of Object.entries(stock)) {
    const decayPerMonth = decayById.get(cargo) || 0
    next[cargo] = qty * (1 - decayPerMonth)
  }

  return next
}
