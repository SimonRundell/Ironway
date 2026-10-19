import { useState } from 'react'
import { useSortedRows } from './useSortedRows.js'
import { interactiveProps } from './a11y.js'

/**
 * The Inspector's industries table (PHASES.md T1.26): sortable by
 * utilisation, capacity and total stock, with a "force closure" debug
 * action per open row. Defaults to open industries only — a generated
 * island can carry well over a thousand industries (T1.25 raised the
 * generation density substantially), so closed ones are hidden unless
 * asked for, same reasoning as the settlement name/kind filter.
 *
 * @module ui/inspector/IndustriesTable
 */

/**
 * @param {object} props
 * @param {import('../../sim/state.js').Industry[]} props.industries
 * @param {Map<number, import('../../sim/state.js').Settlement>} props.settlementsById
 * @param {(id: number) => void} props.onForceClosure
 * @returns {JSX.Element}
 */
export default function IndustriesTable({ industries, settlementsById, onForceClosure }) {
  const [filter, setFilter] = useState('')
  const [showClosed, setShowClosed] = useState(false)

  const rows = industries
    .filter((ind) => showClosed || ind.closedDay === null)
    .map((ind) => {
      const homeSettlement = settlementsById.get(ind.homeSettlementId)
      const totalStock = Object.values(ind.stock).reduce((sum, qty) => sum + qty, 0)
      return {
        id: ind.id,
        name: ind.name,
        typeId: ind.typeId,
        homeName: homeSettlement?.name ?? `#${ind.homeSettlementId}`,
        utilisation: ind.utilisation,
        capacity: ind.capacity,
        totalStock,
        open: ind.closedDay === null,
      }
    })

  const filtered = filter
    ? rows.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()) || r.typeId.includes(filter.toLowerCase()) || r.homeName.toLowerCase().includes(filter.toLowerCase()))
    : rows

  const { sorted, sortKey, direction, toggleSort } = useSortedRows(filtered, 'utilisation')

  /** @param {string} key @returns {string} */
  function headerClass(key) {
    return key === sortKey ? 'sorted' : ''
  }

  return (
    <div>
      <div className="inline-form">
        <input
          className="table-filter"
          type="text"
          placeholder="Filter by name, type or home settlement…"
          aria-label="Filter industries by name, type or home settlement"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <label className="field">
          <span>
            <input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />
            {' '}Show closed
          </span>
        </label>
      </div>
      <div className="table-scroll table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className={headerClass('name')} {...interactiveProps(() => toggleSort('name'), 'Sort by name')}>Name</th>
              <th className={headerClass('typeId')} {...interactiveProps(() => toggleSort('typeId'), 'Sort by type')}>Type</th>
              <th className={headerClass('homeName')} {...interactiveProps(() => toggleSort('homeName'), 'Sort by home settlement')}>Home settlement</th>
              <th className={headerClass('utilisation')} {...interactiveProps(() => toggleSort('utilisation'), 'Sort by utilisation')}>Utilisation</th>
              <th className={headerClass('capacity')} {...interactiveProps(() => toggleSort('capacity'), 'Sort by capacity')}>Capacity</th>
              <th className={headerClass('totalStock')} {...interactiveProps(() => toggleSort('totalStock'), 'Sort by stock')}>Stock (t)</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.typeId}</td>
                <td>{row.homeName}</td>
                <td>{(row.utilisation * 100).toFixed(0)}%</td>
                <td>{row.capacity.toFixed(2)}×</td>
                <td>{row.totalStock.toFixed(0)}</td>
                <td>{row.open ? 'open' : 'closed'}</td>
                <td>
                  {row.open && (
                    <button type="button" onClick={(event) => { event.stopPropagation(); onForceClosure(row.id) }}>
                      Force closure
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{sortKey} sorted {direction}, {sorted.length} of {industries.length} industries shown.</p>
    </div>
  )
}
