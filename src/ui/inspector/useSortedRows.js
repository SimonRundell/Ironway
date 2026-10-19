import { useState } from 'react'

/**
 * Shared click-to-sort state for the Inspector's data tables
 * (settlements, industries): one column is the current sort key, with
 * a direction that flips on a second click of the same header.
 *
 * @module ui/inspector/useSortedRows
 */

/**
 * @param {object[]} rows Flat row-view objects (already shaped for display, not raw entities).
 * @param {string} initialKey The row key sorted on by default.
 * @param {'asc'|'desc'} [initialDirection] The default sort direction.
 * @returns {{sorted: object[], sortKey: string, direction: 'asc'|'desc', toggleSort: (key: string) => void}}
 */
export function useSortedRows(rows, initialKey, initialDirection = 'desc') {
  const [sortKey, setSortKey] = useState(initialKey)
  const [direction, setDirection] = useState(initialDirection)

  /**
   * @param {string} key The column to sort by; flips direction if it's already the active column.
   * @returns {void}
   */
  function toggleSort(key) {
    if (key === sortKey) {
      setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setDirection('asc')
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
    return direction === 'asc' ? cmp : -cmp
  })

  return { sorted, sortKey, direction, toggleSort }
}
