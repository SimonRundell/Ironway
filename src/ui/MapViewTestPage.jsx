import MapView from './MapView.jsx'

/**
 * T2.02's own verification harness: a full-screen `MapView` with the
 * debug render/frame counter on, so panning and zooming can be checked
 * by hand and the "no React re-render per frame" claim can be read
 * directly off the HUD instead of trusting devtools. Not part of the
 * real game flow yet — `MapView` itself is what T2.03 onward build on;
 * this page is retired once a real save can drive it (around T2.07).
 *
 * @returns {JSX.Element}
 */
export default function MapViewTestPage() {
  return (
    <div className="map-view-test-page">
      <MapView showDebugStats />
    </div>
  )
}
