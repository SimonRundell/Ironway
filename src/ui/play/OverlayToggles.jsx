import { OVERLAY_MODES } from '../../render/overlays.js'

/**
 * Heat overlay toggles (PHASES.md T2.12, DESIGN 9.6/9.8: "overlay
 * toggles: prices by cargo, class distribution, confidence,
 * employment, flows, resources, land suitability"). A cargo picker
 * appears only for the `'prices'` mode, since that's the one overlay
 * needing a further choice before it means anything.
 *
 * @module ui/play/OverlayToggles
 */

const MODE_LABELS = {
  none: 'Off',
  prices: 'Prices',
  classMix: 'Class mix',
  confidence: 'Confidence',
  employment: 'Employment',
  flows: 'Flows',
  resources: 'Resources',
  suitability: 'Suitability',
}

/**
 * @param {object} props
 * @param {string} props.mode One of `OVERLAY_MODES`.
 * @param {(mode: string) => void} props.setMode
 * @param {string} props.cargoId
 * @param {(cargoId: string) => void} props.setCargoId
 * @param {{id: string}[]} props.cargoRules `cargo.json`'s `cargo` array.
 * @returns {JSX.Element}
 */
export default function OverlayToggles({ mode, setMode, cargoId, setCargoId, cargoRules }) {
  return (
    <div className="hud-panel hud-overlay-toggles">
      <label className="field">
        Overlay
        <select value={mode} onChange={(event) => setMode(event.target.value)}>
          {OVERLAY_MODES.map((m) => (
            <option key={m} value={m}>{MODE_LABELS[m]}</option>
          ))}
        </select>
      </label>
      {mode === 'prices' && (
        <label className="field">
          Cargo
          <select value={cargoId} onChange={(event) => setCargoId(event.target.value)}>
            {cargoRules.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}
