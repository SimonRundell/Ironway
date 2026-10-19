import { useEffect, useRef, useState } from 'react'
import { useSortedRows } from './useSortedRows.js'
import { interactiveProps } from './a11y.js'

/**
 * The Inspector's settlements table (PHASES.md T1.26): sortable by
 * name, kind, class populations, employment and confidence, with a
 * simple up/down trend arrow against last month's own total
 * population — there is no per-settlement history persisted (DESIGN
 * 8.2's `history_monthly` is island-wide only), so the trend is kept
 * as this component's own in-memory "last render's totals" map rather
 * than inventing new persistence for a developer panel.
 *
 * @module ui/inspector/SettlementsTable
 */

/**
 * @param {object} props
 * @param {import('../../sim/state.js').Settlement[]} props.settlements
 * @param {Map<number, string>} props.classIdByIndex `classes.json` id, keyed by array index.
 * @param {number} props.selectedId The currently selected settlement id, or null.
 * @param {(id: number) => void} props.onSelect
 * @returns {JSX.Element}
 */
export default function SettlementsTable({ settlements, classIdByIndex, selectedId, onSelect }) {
  const [filter, setFilter] = useState('')
  const previousTotalsRef = useRef(new Map())

  const rows = settlements.map((s) => {
    let total = 0
    let working = 0
    let middle = 0
    let upper = 0
    let employedSum = 0
    let confidenceSum = 0
    let classCount = 0

    for (const [index, classId] of classIdByIndex) {
      const row = s.pop[index]
      if (!row) continue
      total += row.pop
      if (classId === 'working') working = row.pop
      else if (classId === 'middle') middle = row.pop
      else if (classId === 'upper') upper = row.pop
      employedSum += row.employed
      confidenceSum += row.confidence
      classCount += 1
    }

    const employmentRate = total > 0 ? employedSum / total : 0
    const confidence = classCount > 0 ? confidenceSum / classCount : 0
    const previousTotal = previousTotalsRef.current.get(s.id)
    const trend = previousTotal === undefined ? 0 : Math.sign(total - previousTotal)

    return { id: s.id, name: s.name, kind: s.kind, total, working, middle, upper, employmentRate, confidence, trend, portTier: s.portTier }
  })

  // Updated after render (not during it, which would make this component's render impure) so next
  // render's trend arrows compare against this render's totals, not a stale or half-built map.
  const nextTotals = new Map(rows.map((r) => [r.id, r.total]))
  useEffect(() => {
    previousTotalsRef.current = nextTotals
  })

  const filtered = filter
    ? rows.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()) || r.kind.includes(filter.toLowerCase()))
    : rows

  const { sorted, sortKey, direction, toggleSort } = useSortedRows(filtered, 'total')

  /** @param {string} key @returns {string} */
  function headerClass(key) {
    return key === sortKey ? 'sorted' : ''
  }

  return (
    <div>
      <input
        className="table-filter"
        type="text"
        placeholder="Filter by name or kind…"
        aria-label="Filter settlements by name or kind"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="table-scroll table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className={headerClass('name')} {...interactiveProps(() => toggleSort('name'), 'Sort by name')}>Name</th>
              <th className={headerClass('kind')} {...interactiveProps(() => toggleSort('kind'), 'Sort by kind')}>Kind</th>
              <th className={headerClass('working')} {...interactiveProps(() => toggleSort('working'), 'Sort by working class population')}>Working</th>
              <th className={headerClass('middle')} {...interactiveProps(() => toggleSort('middle'), 'Sort by middle class population')}>Middle</th>
              <th className={headerClass('upper')} {...interactiveProps(() => toggleSort('upper'), 'Sort by upper class population')}>Upper</th>
              <th className={headerClass('total')} {...interactiveProps(() => toggleSort('total'), 'Sort by total population')}>Total</th>
              <th className={headerClass('employmentRate')} {...interactiveProps(() => toggleSort('employmentRate'), 'Sort by employment')}>Employment</th>
              <th className={headerClass('confidence')} {...interactiveProps(() => toggleSort('confidence'), 'Sort by confidence')}>Confidence</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.id}
                className={row.id === selectedId ? 'selected' : ''}
                {...interactiveProps(() => onSelect(row.id), `Select ${row.name}`)}
              >
                <td>{row.name}{row.portTier > 0 ? ' ⚓' : ''}</td>
                <td>{row.kind}</td>
                <td>{Math.round(row.working).toLocaleString()}</td>
                <td>{Math.round(row.middle).toLocaleString()}</td>
                <td>{Math.round(row.upper).toLocaleString()}</td>
                <td>{Math.round(row.total).toLocaleString()}</td>
                <td>{(row.employmentRate * 100).toFixed(1)}%</td>
                <td>{row.confidence.toFixed(0)}</td>
                <td className={row.trend > 0 ? 'trend-up' : row.trend < 0 ? 'trend-down' : ''}>
                  {row.trend > 0 ? '↑' : row.trend < 0 ? '↓' : '→'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{sortKey} sorted {direction}, {sorted.length} of {settlements.length} settlements shown.</p>
    </div>
  )
}
