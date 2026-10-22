/**
 * The island economy level badge (PHASES.md T2.12, DESIGN 9.8: "island
 * economy level badge with the 5-step indicator"). `economy.json`'s
 * `levels` array is always exactly 5 entries (Depression through Boom,
 * DESIGN 7.10) — the indicator is a row of 5 segments, filled up to and
 * including the current level.
 *
 * @module ui/play/EconomyLevelBadge
 */

/**
 * @param {object} props
 * @param {number} props.level The current `economyState.level` index.
 * @param {{level: number, name: string}[]} props.levels `economy.json`'s `levels` array.
 * @returns {JSX.Element}
 */
export default function EconomyLevelBadge({ level, levels }) {
  const current = levels.find((l) => l.level === level) ?? levels[0]

  return (
    <div className="hud-panel hud-economy-badge" title={current.name}>
      <span className="level-badge">{current.name}</span>
      <div className="economy-steps">
        {levels.map((l) => (
          <span key={l.level} className={`economy-step${l.level <= level ? ' filled' : ''}`} />
        ))}
      </div>
    </div>
  )
}
