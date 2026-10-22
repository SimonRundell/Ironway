import SettlementPanel from '../inspector/SettlementPanel.jsx'
import EventsLog from '../inspector/EventsLog.jsx'
import HistoryChart from '../inspector/HistoryChart.jsx'

/**
 * The HUD's selection panel (PHASES.md T2.12, DESIGN 9.8: "selection
 * panel for a clicked settlement, industry or link"). A settlement
 * selection reuses the Inspector's own `SettlementPanel` wholesale (its
 * class populations, stock/price table and add-stock debug action are
 * exactly what DESIGN asks for here too); `IndustrySelection` and
 * `LinkSelection` below are their own small, focused components, since
 * nothing in the Inspector already covers those two individually — kept
 * as separate components (not inline branches in one function) so
 * `SelectionPanel` itself stays a simple "pick one, wrap it the same
 * way" dispatch rather than one large function with every entity type's
 * markup folded into it. Every selection type gets the island's own
 * history chart (there is no per-settlement breakdown to chart — see
 * `HistoryChart`'s own doc comment) and its own filtered events feed.
 *
 * @module ui/play/SelectionPanel
 */

/**
 * One `.summary-stat` tile (a value over its label). Factored out of
 * `IndustrySelection`/`LinkSelection` purely to de-duplicate their
 * near-identical markup — the same repeated shape also exists,
 * independently, in `SettlementPanel.jsx`/`InspectorPage.jsx`, but those
 * are untouched Phase 1 code and out of scope here.
 *
 * @param {object} props
 * @param {string} props.value
 * @param {string} props.label
 * @returns {JSX.Element}
 */
function SummaryStat({ value, label }) {
  return (
    <div className="summary-stat">
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  )
}

/**
 * A scrollable `cargoId → tonnes` table (stock or recent flow) — the one
 * table shape `IndustrySelection` and `LinkSelection` both need, pulled
 * out to one place rather than two copies of the same `table-scroll
 * table-wrap`/`data-table` markup.
 *
 * @param {object} props
 * @param {string} props.valueHeader
 * @param {[string, number][]} props.rows `[cargoId, tonnes]` pairs, already sorted.
 * @returns {JSX.Element}
 */
function CargoQuantityTable({ valueHeader, rows }) {
  return (
    <div className="table-scroll table-wrap">
      <table className="data-table">
        <thead><tr><th>Cargo</th><th>{valueHeader}</th></tr></thead>
        <tbody>
          {rows.map(([cargoId, qty]) => (
            <tr key={cargoId}><td>{cargoId}</td><td>{qty.toFixed(1)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * @param {object} props
 * @param {import('../../sim/state.js').Industry} props.industry
 * @param {import('../../sim/state.js').Settlement|undefined} props.home
 * @param {(industryId: number) => void} props.onForceClosure
 * @returns {JSX.Element}
 */
function IndustrySelection({ industry, home, onForceClosure }) {
  const stockRows = Object.entries(industry.stock).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="card">
      <h2>{industry.name} <span className="muted">({industry.typeId})</span></h2>
      <div className="summary-grid">
        <SummaryStat value={home?.name ?? 'unknown'} label="home settlement" />
        <SummaryStat value={`${(industry.utilisation * 100).toFixed(0)}%`} label="utilisation" />
        <SummaryStat value={`${industry.capacity.toFixed(2)}×`} label="capacity" />
        <SummaryStat value={industry.closedDay === null ? 'open' : 'closed'} label="status" />
      </div>
      <h3>Stock</h3>
      <CargoQuantityTable valueHeader="Stock (t)" rows={stockRows} />
      {industry.closedDay === null && (
        <button type="button" onClick={() => onForceClosure(industry.id)}>Force closure (debug)</button>
      )}
    </div>
  )
}

/**
 * @param {object} props
 * @param {import('../../sim/state.js').Link} props.link
 * @returns {JSX.Element}
 */
function LinkSelection({ link }) {
  const flowEntries = Object.entries(link.recentFlow ?? {}).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="card">
      <h2>{link.mode} link <span className="muted">(tier {link.tier})</span></h2>
      <div className="summary-grid">
        <SummaryStat value={`${link.lengthMi.toFixed(1)}mi`} label="length" />
        <SummaryStat value={`${(link.condition * 100).toFixed(0)}%`} label="condition" />
      </div>
      <h3>Recent flow</h3>
      {flowEntries.length === 0 && <p className="muted">Nothing moved along this link last month.</p>}
      {flowEntries.length > 0 && <CargoQuantityTable valueHeader="Tonnes" rows={flowEntries} />}
    </div>
  )
}

/**
 * @param {{type: 'settlement'|'industry'|'link', id: number}} selection
 * @param {import('../../sim/state.js').GameState} gameState
 * @param {object} rules
 * @param {object} caches
 * @param {number} gameDay
 * @param {number} startYear
 * @param {(settlementId: number, cargoId: string, qty: number) => void} onAddStock
 * @param {(industryId: number) => void} onForceClosure
 * @returns {JSX.Element|null}
 */
function selectionContent({ selection, gameState, rules, caches, gameDay, startYear, onAddStock, onForceClosure }) {
  if (selection.type === 'settlement') {
    const settlement = gameState.settlements.find((s) => s.id === selection.id)
    if (!settlement) return null
    return (
      <SettlementPanel
        settlement={settlement}
        gameState={gameState}
        rules={rules}
        classIdByIndex={caches.classIdByIndex}
        gameDay={gameDay}
        startYear={startYear}
        onAddStock={onAddStock}
      />
    )
  }
  if (selection.type === 'industry') {
    const industry = gameState.industries.find((i) => i.id === selection.id)
    if (!industry) return null
    return <IndustrySelection industry={industry} home={caches.settlementsById.get(industry.homeSettlementId)} onForceClosure={onForceClosure} />
  }
  if (selection.type === 'link') {
    const link = gameState.links.find((l) => l.id === selection.id)
    if (!link) return null
    return <LinkSelection link={link} />
  }
  return null
}

/**
 * @param {object} props
 * @param {{type: 'settlement'|'industry'|'link', id: number}} props.selection
 * @param {import('../../sim/state.js').GameState} props.gameState
 * @param {object} props.rules
 * @param {object} props.caches `sim/tick.js`'s `createTickCaches()` result.
 * @param {number} props.gameDay
 * @param {number} props.startYear
 * @param {() => void} props.onClose
 * @param {(settlementId: number, cargoId: string, qty: number) => void} props.onAddStock
 * @param {(industryId: number) => void} props.onForceClosure
 * @returns {JSX.Element|null}
 */
export default function SelectionPanel(props) {
  const { gameState, selection, startYear, onClose } = props
  const content = selectionContent(props)
  if (!content) return null

  const events = gameState.eventsLog.filter((e) => e.subjectType === selection.type && e.subjectId === selection.id)

  return (
    <div className="hud-panel hud-selection-panel">
      <button type="button" className="hud-selection-close" onClick={onClose} aria-label="Close selection panel">×</button>
      {content}
      <div className="card">
        <h3>History</h3>
        <HistoryChart historyMonthly={gameState.historyMonthly} />
      </div>
      <div className="card">
        <h3>Recent events</h3>
        <EventsLog eventsLog={events} startYear={startYear} />
      </div>
    </div>
  )
}
