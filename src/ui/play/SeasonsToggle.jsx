/**
 * The HUD's seasons toggle (PHASES.md T2.13: "toggleable in settings").
 * There is no dedicated settings page yet (that is T2.14's own task),
 * so this is the smallest thing that satisfies the Done-when today — a
 * single checkbox next to the overlay toggles, persisted via
 * `state/settings.js` rather than a full settings surface this task
 * doesn't call for.
 *
 * @module ui/play/SeasonsToggle
 */

/**
 * @param {object} props
 * @param {boolean} props.enabled
 * @param {(enabled: boolean) => void} props.setEnabled
 * @returns {JSX.Element}
 */
export default function SeasonsToggle({ enabled, setEnabled }) {
  return (
    <label className="hud-panel seasons-toggle">
      <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      Seasons
    </label>
  )
}
