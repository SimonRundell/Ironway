import { useState } from 'react'
import { useSortedRows } from './useSortedRows.js'
import { interactiveProps } from './a11y.js'

/**
 * The Inspector's links table (PHASES.md T1.26): the transport
 * network as generated — road, rail and sea edges between
 * settlements, industries and the world/port node. Read-only; the
 * player doesn't own or operate anything yet (that starts Phase 3).
 *
 * @module ui/inspector/LinksTable
 */

/** @type {Record<string, string>} Endpoint type codes (sim/state.js's Link.aType/bType) to a readable label. */
const TYPE_LABELS = { s: 'settlement', i: 'industry', w: 'world' }

/**
 * @param {object} props
 * @param {import('../../sim/state.js').Link[]} props.links
 * @returns {JSX.Element}
 */
export default function LinksTable({ links }) {
  const [filter, setFilter] = useState('')

  const rows = links.map((link) => ({
    id: link.id,
    mode: link.mode,
    tier: link.tier,
    from: `${TYPE_LABELS[link.aType]} #${link.aId}`,
    to: `${TYPE_LABELS[link.bType]} #${link.bId}`,
    lengthMi: link.lengthMi,
    condition: link.condition,
    owner: link.owner,
  }))

  const filtered = filter ? rows.filter((r) => r.mode.includes(filter.toLowerCase()) || r.owner.includes(filter.toLowerCase())) : rows
  const { sorted, sortKey, direction, toggleSort } = useSortedRows(filtered, 'mode', 'asc')

  /** @param {string} key @returns {string} */
  function headerClass(key) {
    return key === sortKey ? 'sorted' : ''
  }

  return (
    <div>
      <input
        className="table-filter"
        type="text"
        placeholder="Filter by mode or owner…"
        aria-label="Filter links by mode or owner"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="table-scroll table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className={headerClass('mode')} {...interactiveProps(() => toggleSort('mode'), 'Sort by mode')}>Mode</th>
              <th className={headerClass('tier')} {...interactiveProps(() => toggleSort('tier'), 'Sort by tier')}>Tier</th>
              <th>From</th>
              <th>To</th>
              <th className={headerClass('lengthMi')} {...interactiveProps(() => toggleSort('lengthMi'), 'Sort by length')}>Length (mi)</th>
              <th className={headerClass('condition')} {...interactiveProps(() => toggleSort('condition'), 'Sort by condition')}>Condition</th>
              <th className={headerClass('owner')} {...interactiveProps(() => toggleSort('owner'), 'Sort by owner')}>Owner</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id}>
                <td>{row.mode}</td>
                <td>{row.tier}</td>
                <td>{row.from}</td>
                <td>{row.to}</td>
                <td>{row.lengthMi.toFixed(1)}</td>
                <td>{(row.condition * 100).toFixed(0)}%</td>
                <td>{row.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{sortKey} sorted {direction}, {sorted.length} of {links.length} links shown.</p>
    </div>
  )
}
