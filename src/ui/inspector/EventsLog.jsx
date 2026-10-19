import { monthName, yearIndexOf } from '../../sim/clock.js'

/**
 * The Inspector's events log (PHASES.md T1.26): the most recent
 * entries from `gameState.eventsLog`, newest first. Capped to a few
 * hundred rows for display — the full log can grow very large over a
 * long game and nothing needs to scroll back through all of it here.
 *
 * @module ui/inspector/EventsLog
 */

const MAX_SHOWN = 200

/**
 * @param {object} props
 * @param {import('../../sim/state.js').EventLogEntry[]} props.eventsLog
 * @param {number} props.startYear
 * @returns {JSX.Element}
 */
export default function EventsLog({ eventsLog, startYear }) {
  const recent = eventsLog.slice(-MAX_SHOWN).reverse()

  return (
    <div>
      {recent.length === 0 && <p className="muted">No events yet.</p>}
      <ul className="events-list">
        {recent.map((event) => (
          <li key={`${event.gameDay}-${event.kind}-${event.subjectType}-${event.subjectId}-${event.text}`}>
            <strong>{monthName(event.gameDay)} {startYear + yearIndexOf(event.gameDay)}</strong> — {event.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
