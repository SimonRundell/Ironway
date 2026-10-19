/**
 * The Inspector's island history chart (PHASES.md T1.26: "history
 * chart as simple SVG"). Plots `historyMonthly.popTotal` over time —
 * island-wide, since DESIGN 8.2's `history_monthly` has no
 * per-settlement breakdown (see DECISIONS.md for why the
 * selected-settlement panel doesn't get its own separate chart).
 *
 * @module ui/inspector/HistoryChart
 */

const WIDTH = 600
const HEIGHT = 120
const PADDING = 4

/**
 * @param {object} props
 * @param {import('../../sim/state.js').HistoryMonthlyEntry[]} props.historyMonthly
 * @returns {JSX.Element|null}
 */
export default function HistoryChart({ historyMonthly }) {
  if (historyMonthly.length < 2) {
    return <p className="muted">Not enough history yet to chart.</p>
  }

  const values = historyMonthly.map((h) => h.popTotal)
  const maxValue = Math.max(...values, 1)
  const minValue = Math.min(...values, 0)
  const range = Math.max(1, maxValue - minValue)

  const points = values.map((value, i) => {
    const x = PADDING + (i / (values.length - 1)) * (WIDTH - PADDING * 2)
    const y = HEIGHT - PADDING - ((value - minValue) / range) * (HEIGHT - PADDING * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  return (
    <svg className="history-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="Population over time">
      <polyline points={points} fill="none" stroke="var(--colour-accent)" strokeWidth="2" />
    </svg>
  )
}
