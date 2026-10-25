/**
 * The HUD's settings panel (PHASES.md T2.14: "accessibility and
 * settings"). Hosts every display toggle the game currently has —
 * seasons (T2.13), high-contrast labels, reduced motion and the
 * tile/particle quality preset — in one small panel rather than one
 * standalone checkbox per toggle, now that there is more than one of
 * them to show. Every control here is a native checkbox or `<select>`,
 * so "every control reachable by keyboard" (this task's own Done-when)
 * holds without any extra wiring: both are natively Tab-focusable and
 * operable with the keyboard alone.
 *
 * @module ui/play/SettingsPanel
 */

/**
 * @param {object} props
 * @param {boolean} props.seasonsEnabled
 * @param {(enabled: boolean) => void} props.setSeasonsEnabled
 * @param {boolean} props.highContrastLabels
 * @param {(enabled: boolean) => void} props.setHighContrastLabels
 * @param {boolean} props.reducedMotion
 * @param {(enabled: boolean) => void} props.setReducedMotion
 * @param {string} props.quality `'low'` or `'normal'`.
 * @param {(quality: string) => void} props.setQuality
 * @returns {JSX.Element}
 */
export default function SettingsPanel({
  seasonsEnabled, setSeasonsEnabled,
  highContrastLabels, setHighContrastLabels,
  reducedMotion, setReducedMotion,
  quality, setQuality,
}) {
  return (
    <div className="hud-panel hud-settings">
      <label>
        <input type="checkbox" checked={seasonsEnabled} onChange={(event) => setSeasonsEnabled(event.target.checked)} />
        Seasons
      </label>
      <label>
        <input type="checkbox" checked={highContrastLabels} onChange={(event) => setHighContrastLabels(event.target.checked)} />
        High-contrast labels
      </label>
      <label>
        <input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} />
        Reduced motion
      </label>
      <label>
        Quality
        <select value={quality} onChange={(event) => setQuality(event.target.value)}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
        </select>
      </label>
    </div>
  )
}
