import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useGameSession } from '../state/useGameSession.js'
import MapView from './MapView.jsx'
import DateSpeedControls from './play/DateSpeedControls.jsx'
import EconomyLevelBadge from './play/EconomyLevelBadge.jsx'
import OverlayToggles from './play/OverlayToggles.jsx'
import SearchBox from './play/SearchBox.jsx'
import Minimap from './play/Minimap.jsx'
import SelectionPanel from './play/SelectionPanel.jsx'

/**
 * The real gameplay view (PHASES.md T2.12, DESIGN 9.8): `MapView`'s
 * canvas stack with a React/DOM HUD over it — date and speed controls,
 * the economy level badge, heat-overlay toggles, a search box, a
 * minimap, and a selection panel for a clicked settlement, industry or
 * link. The Phase 1 inspector (`ui/InspectorPage.jsx`) remains reachable
 * (DESIGN 9.8's own wording) via a small link in the HUD, rather than
 * being replaced — it stays the developer's table-based view onto the
 * exact same save.
 *
 * `MapView`'s `world` prop needs a stable object identity across
 * renders (its render loop reads it from a closure captured once at
 * mount — see that component's own doc comment), so it is built once,
 * in a ref, the moment the session becomes ready, and never replaced
 * afterward; everything that can change over a session's lifetime
 * (`sim.gameDay`, `overlay.mode`/`overlay.cargoId`) is a field mutated
 * in place on that same stable object, each followed by an explicit
 * `markDirty()` — the identical convention `ui/MapViewTestPage.jsx`
 * already established for `sim.gameDay` back in T2.08.
 *
 * @module ui/PlayPage
 */

/**
 * @returns {JSX.Element}
 */
export default function PlayPage() {
  const { saveId } = useParams()
  const session = useGameSession(Number(saveId))
  const mapViewRef = useRef(null)
  const simRef = useRef({ gameDay: 0 })

  const [overlayMode, setOverlayMode] = useState('none')
  const [overlayCargoId, setOverlayCargoId] = useState('')
  const [selection, setSelection] = useState(null)

  const ready = session.status === 'ready'

  // Built exactly once, the moment the session first becomes ready —
  // `useMemo` (not a ref written during render) so this never runs
  // afoul of React's "no side effects during render" rule, while still
  // giving `MapView` the one stable object identity its own render loop
  // needs (see this module's own doc comment). `ready` is deliberately
  // the only dependency: nothing else should ever cause this to recompute.
  const worldForMap = useMemo(() => {
    if (!ready) return null
    return {
      grid: session.world.grid,
      landuseEnum: session.rules.terrain.landuseEnum,
      palette: session.rules.palette,
      links: session.gameState.links,
      settlements: session.gameState.settlements,
      classesRules: session.rules.classes,
      industries: session.gameState.industries,
      sim: simRef.current,
      cargoRules: session.rules.cargo,
      rules: session.rules,
      economyState: session.gameState.economyState,
      classIdByIndex: session.caches.classIdByIndex,
      startYear: session.world.meta.startYear,
      overlay: { mode: 'none', cargoId: null },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // `sim.gameDay` and every new `dirty` patch (settlements/industries/
  // links mutated in place) need a redraw; neither touches `world`'s
  // own identity, so nothing else would tell the render loop to catch up.
  useEffect(() => {
    if (!ready) return
    simRef.current.gameDay = session.gameDay
    mapViewRef.current?.markDirty()
  }, [ready, session.gameDay, session.renderTick])

  // Picks the default cargo (first time only, once rules are available)
  // and mutates the overlay toggle in place in the same effect, rather
  // than two effects chained through `overlayCargoId` state — that
  // split previously meant toggling into "prices" mode took an extra
  // render/effect pass before the map actually picked up a cargo.
  useEffect(() => {
    if (!worldForMap) return
    const effectiveCargoId = overlayCargoId || session.rules.cargo[0]?.id || null
    if (!overlayCargoId && effectiveCargoId) setOverlayCargoId(effectiveCargoId)
    worldForMap.overlay = { mode: overlayMode, cargoId: effectiveCargoId }
    mapViewRef.current?.markDirty()
  }, [worldForMap, overlayMode, overlayCargoId, session.rules])

  if (session.status === 'loading') {
    return (
      <main className="play-page">
        <p className="map-view-test-page-status">Loading island…</p>
      </main>
    )
  }

  if (session.status === 'error') {
    return (
      <main className="play-page">
        <div className="card banner-warning">
          <p>Could not load this island: {session.errorMessage}</p>
          <Link to="/">Back to saves</Link>
        </div>
      </main>
    )
  }

  const bounds = { minX: 0, minY: 0, maxX: session.world.grid.width * session.world.grid.cellMiles, maxY: session.world.grid.height * session.world.grid.cellMiles }

  return (
    <main className="play-page">
      <MapView ref={mapViewRef} world={worldForMap} bounds={bounds} onSelect={setSelection}>
        <div className="hud-top-left">
          <DateSpeedControls gameDay={session.gameDay} startYear={session.world.meta.startYear} speed={session.speed} setSpeed={session.setSpeed} />
          <EconomyLevelBadge level={session.gameState.economyState.level} levels={session.rules.economy.levels} />
        </div>
        <div className="hud-top-right">
          <OverlayToggles mode={overlayMode} setMode={setOverlayMode} cargoId={overlayCargoId} setCargoId={setOverlayCargoId} cargoRules={session.rules.cargo} />
          <SearchBox
            settlements={session.gameState.settlements}
            industries={session.gameState.industries}
            onJump={(worldPoint, ppm) => mapViewRef.current?.jumpTo(worldPoint, ppm)}
          />
        </div>
        <Minimap grid={session.world.grid} bounds={bounds} settlements={session.gameState.settlements} mapViewRef={mapViewRef} />

        {selection && (
          <SelectionPanel
            selection={selection}
            gameState={session.gameState}
            rules={session.rules}
            caches={session.caches}
            gameDay={session.gameDay}
            startYear={session.world.meta.startYear}
            onClose={() => setSelection(null)}
            onAddStock={session.addStock}
            onForceClosure={session.forceClosure}
          />
        )}

        {session.conflict && (
          <div className="hud-panel hud-banner banner-warning">
            <p>This save changed elsewhere. <button type="button" onClick={() => window.location.reload()}>Reload</button></p>
          </div>
        )}
        {session.workerCrashed && (
          <div className="hud-panel hud-banner banner-warning">
            <p>Simulation stopped ({session.errorMessage}). <button type="button" onClick={session.recover}>Reload from last save</button></p>
          </div>
        )}

        <Link to={`/island/${saveId}`} className="hud-panel hud-inspector-link">Inspector</Link>
      </MapView>
    </main>
  )
}
