/**
 * Looks up values from `eras.json`'s year-indexed progression tables
 * (DESIGN 7.2's `era.agriProductivity(year)` and similar). Every table
 * is validated elsewhere (`rules.js`) to have strictly ascending
 * `year` entries, so a single linear scan plus linear interpolation
 * between the bracketing points is enough — pure arithmetic, no
 * transcendental functions, matching DESIGN 4.5.
 *
 * @module sim/era
 */

/**
 * Looks up a value from a year-indexed table, linearly interpolating
 * between the two bracketing entries. Years before the first entry or
 * after the last are clamped to that entry's value, not extrapolated.
 *
 * @param {Array<{year: number, value: number}>} table An ascending-by-year table (e.g. `eras.json`'s `agriProductivityMultiplier`).
 * @param {number} year The calendar year to look up.
 * @returns {number} The interpolated value.
 */
export function interpolateYearTable(table, year) {
  if (year <= table[0].year) {
    return table[0].value
  }

  const last = table[table.length - 1]
  if (year >= last.year) {
    return last.value
  }

  for (let i = 1; i < table.length; i++) {
    const next = table[i]
    if (year <= next.year) {
      const prev = table[i - 1]
      const span = next.year - prev.year
      const t = span === 0 ? 0 : (year - prev.year) / span
      return prev.value + (next.value - prev.value) * t
    }
  }

  // Unreachable given the clamp above, but keeps the function total.
  return last.value
}

/**
 * DESIGN 7.2's `era.agriProductivity(year)`: the agricultural
 * productivity multiplier applied to hinterland farm output.
 *
 * @param {object} erasRules The validated `eras.json` rules.
 * @param {number} year The calendar year.
 * @returns {number} The productivity multiplier (1.0 at game start, rising over time).
 */
export function agriProductivityMultiplier(erasRules, year) {
  return interpolateYearTable(erasRules.agriProductivityMultiplier, year)
}
