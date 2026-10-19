import { Link, useParams } from 'react-router-dom'
import { monthName, yearIndexOf, SPEEDS } from '../sim/clock.js'
import { useGameSession } from '../state/useGameSession.js'
import SettlementsTable from './inspector/SettlementsTable.jsx'
import IndustriesTable from './inspector/IndustriesTable.jsx'
import LinksTable from './inspector/LinksTable.jsx'
import SettlementPanel from './inspector/SettlementPanel.jsx'
import EventsLog from './inspector/EventsLog.jsx'
import HistoryChart from './inspector/HistoryChart.jsx'

/**
 * The Phase 1 inspector (PHASES.md T1.26): date and speed controls,
 * island summary and economy level, tables for settlements,
 * industries and links, a selected-settlement panel, an events log,
 * and debug actions. Runs the sim in the main thread (DESIGN 4.2: a
 * Web Worker is a Phase 2 change, not needed yet).
 *
 * @module ui/InspectorPage
 */

const SPEED_LABELS = { 0: 'Pause', 1: '1×', 2: '2×', 4: '4×' }

/**
 * @returns {JSX.Element}
 */
export default function InspectorPage() {
  const { saveId } = useParams()
  const session = useGameSession(Number(saveId))

  if (session.status === 'loading') {
    return (
      <main className="inspector">
        <p>Loading island…</p>
      </main>
    )
  }

  if (session.status === 'error') {
    return (
      <main className="inspector">
        <div className="card banner-warning">
          <p>Could not load this island: {session.errorMessage}</p>
          <Link to="/">Back to saves</Link>
        </div>
      </main>
    )
  }

  const { world, gameState, rules, caches, gameDay, speed, setSpeed, conflict, dismissConflict, saveNow, selectedSettlementId, selectSettlement, forceClosure, addStock } = session
  const level = rules.economy.levels[gameState.economyState.level]
  const latestHistory = gameState.historyMonthly[gameState.historyMonthly.length - 1]
  const selectedSettlement = gameState.settlements.find((s) => s.id === selectedSettlementId) ?? null

  return (
    <main className="inspector">
      <div className="inspector-header">
        <h1 className="brand"><Link to="/">Ironway</Link> — {world.meta.name}</h1>
        <div className="inspector-controls">
          <span className="inspector-date">{monthName(gameDay)} {world.meta.startYear + yearIndexOf(gameDay)}</span>
          <div className="speed-group">
            {SPEEDS.map((s) => (
              <button key={s} type="button" className={s === speed ? 'active' : ''} onClick={() => setSpeed(s)}>
                {SPEED_LABELS[s]}
              </button>
            ))}
          </div>
          <button type="button" onClick={saveNow}>Save now</button>
        </div>
      </div>

      {conflict && (
        <div className="card banner-warning">
          <p>This save has changed elsewhere (maybe another tab). Reload to continue.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
          <button type="button" onClick={dismissConflict}>Dismiss</button>
        </div>
      )}

      <div className="card">
        <h2>Island summary <span className="level-badge">{level.name}</span></h2>
        <div className="summary-grid">
          <div className="summary-stat">
            <span className="value">{Math.round(latestHistory?.popTotal ?? 0).toLocaleString()}</span>
            <span className="label">population</span>
          </div>
          <div className="summary-stat">
            <span className="value">{((latestHistory?.employment ?? 0) * 100).toFixed(1)}%</span>
            <span className="label">employment</span>
          </div>
          <div className="summary-stat">
            <span className="value">{(latestHistory?.confidence ?? 0).toFixed(0)}</span>
            <span className="label">confidence</span>
          </div>
          <div className="summary-stat">
            <span className="value">£{Math.round(latestHistory?.tradeValue ?? 0).toLocaleString()}</span>
            <span className="label">trade this month</span>
          </div>
          <div className="summary-stat">
            <span className="value">{gameState.settlements.length}</span>
            <span className="label">settlements</span>
          </div>
          <div className="summary-stat">
            <span className="value">{gameState.industries.filter((i) => i.closedDay === null).length}</span>
            <span className="label">industries open</span>
          </div>
        </div>
        <HistoryChart historyMonthly={gameState.historyMonthly} />
      </div>

      <div className="card">
        <h2>Settlements</h2>
        <SettlementsTable
          settlements={gameState.settlements}
          classIdByIndex={caches.classIdByIndex}
          selectedId={selectedSettlementId}
          onSelect={selectSettlement}
        />
      </div>

      {selectedSettlement && (
        <SettlementPanel
          settlement={selectedSettlement}
          gameState={gameState}
          rules={rules}
          classIdByIndex={caches.classIdByIndex}
          gameDay={gameDay}
          startYear={world.meta.startYear}
          onAddStock={addStock}
        />
      )}

      <div className="card">
        <h2>Industries</h2>
        <IndustriesTable
          industries={gameState.industries}
          settlementsById={caches.settlementsById}
          onForceClosure={forceClosure}
        />
      </div>

      <div className="card">
        <h2>Links</h2>
        <LinksTable links={gameState.links} />
      </div>

      <div className="card">
        <h2>Events</h2>
        <EventsLog eventsLog={gameState.eventsLog} startYear={world.meta.startYear} />
      </div>
    </main>
  )
}
