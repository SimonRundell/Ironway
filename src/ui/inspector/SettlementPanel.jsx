import { useState } from 'react'
import { monthIndexOf, yearIndexOf } from '../../sim/clock.js'
import { computeSettlementDisplayPrices } from './displaySettlementPrices.js'

/**
 * The Inspector's selected-settlement panel (PHASES.md T1.26): class
 * populations, a recomputed stock/price table, and the "add stock"
 * debug action.
 *
 * @module ui/inspector/SettlementPanel
 */

/**
 * @param {object} props
 * @param {import('../../sim/state.js').Settlement} props.settlement
 * @param {import('../../sim/state.js').GameState} props.gameState
 * @param {object} props.rules
 * @param {Map<number, string>} props.classIdByIndex
 * @param {number} props.gameDay
 * @param {number} props.startYear
 * @param {(settlementId: number, cargoId: string, qty: number) => void} props.onAddStock
 * @returns {JSX.Element}
 */
export default function SettlementPanel({ settlement, gameState, rules, classIdByIndex, gameDay, startYear, onAddStock }) {
  const [cargoId, setCargoId] = useState(rules.cargo[0]?.id ?? '')
  const [qty, setQty] = useState(100)

  const monthIndex = monthIndexOf(gameDay)
  const year = startYear + yearIndexOf(gameDay)
  const priceRows = computeSettlementDisplayPrices(settlement, gameState, rules, classIdByIndex, monthIndex, year)

  /** @param {import('react').FormEvent<HTMLFormElement>} event @returns {void} */
  function handleAddStock(event) {
    event.preventDefault()
    onAddStock(settlement.id, cargoId, Number(qty))
  }

  return (
    <div className="card">
      <h2>{settlement.name} <span className="muted">({settlement.kind})</span></h2>

      <div className="summary-grid">
        {[...classIdByIndex].map(([index, classId]) => {
          const row = settlement.pop[index]
          if (!row) return null
          return (
            <div className="summary-stat" key={classId}>
              <span className="value">{Math.round(row.pop).toLocaleString()}</span>
              <span className="label">{classId} · {(row.employed / Math.max(1, row.pop) * 100).toFixed(0)}% employed · confidence {row.confidence.toFixed(0)}</span>
            </div>
          )
        })}
        <div className="summary-stat">
          <span className="value">{settlement.housing.toLocaleString()}</span>
          <span className="label">housing capacity</span>
        </div>
        <div className="summary-stat">
          <span className="value">{settlement.portTier > 0 ? `tier ${settlement.portTier}` : 'none'}</span>
          <span className="label">port</span>
        </div>
      </div>

      <h3>Stock and prices</h3>
      <div className="table-scroll table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Cargo</th>
              <th>Stock (t)</th>
              <th>Demand (t/mo)</th>
              <th>Price multiplier</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {priceRows.map((row) => (
              <tr key={row.cargoId}>
                <td>{row.cargoId}</td>
                <td>{row.stock.toFixed(1)}</td>
                <td>{row.demand.toFixed(2)}</td>
                <td>{row.multiplier.toFixed(2)}×</td>
                <td>£{row.price.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Debug: add stock</h3>
      <form className="inline-form" onSubmit={handleAddStock}>
        <label className="field">
          Cargo
          <select value={cargoId} onChange={(event) => setCargoId(event.target.value)}>
            {rules.cargo.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
          </select>
        </label>
        <label className="field">
          Tonnes
          <input type="number" min="1" step="1" value={qty} onChange={(event) => setQty(event.target.value)} />
        </label>
        <button type="submit">Add stock</button>
      </form>
    </div>
  )
}
