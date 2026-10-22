import { monthName, yearIndexOf, SPEEDS } from '../../sim/clock.js'

/**
 * The HUD's date and speed controls (PHASES.md T2.12, DESIGN 9.8).
 * Identical in spirit to the Inspector's own date/speed bar
 * (`ui/InspectorPage.jsx`, T1.26) but as its own component, since the
 * HUD composes several small floating panels rather than one page.
 *
 * @module ui/play/DateSpeedControls
 */

const SPEED_LABELS = { 0: 'Pause', 1: '1×', 2: '2×', 4: '4×' }

/**
 * @param {object} props
 * @param {number} props.gameDay
 * @param {number} props.startYear
 * @param {number} props.speed
 * @param {(speed: number) => void} props.setSpeed
 * @returns {JSX.Element}
 */
export default function DateSpeedControls({ gameDay, startYear, speed, setSpeed }) {
  return (
    <div className="hud-panel hud-date-speed">
      <span className="inspector-date">{monthName(gameDay)} {startYear + yearIndexOf(gameDay)}</span>
      <div className="speed-group">
        {SPEEDS.map((s) => (
          <button key={s} type="button" className={s === speed ? 'active' : ''} onClick={() => setSpeed(s)}>
            {SPEED_LABELS[s]}
          </button>
        ))}
      </div>
    </div>
  )
}
