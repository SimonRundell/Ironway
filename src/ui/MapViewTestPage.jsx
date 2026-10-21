import { useEffect, useRef, useState } from 'react'
import { createGameState } from '../sim/state.js'
import { generateWorld } from '../sim/mapgen/world.js'
import { loadRulesBrowser } from '../sim/rules.js'
import { runYears } from '../sim/tick.js'
import MapView from './MapView.jsx'

/** @type {string} difficulty.json id used for every test-page generation; the terrain itself doesn't depend on difficulty. */
const DIFFICULTY = 'normal'
/** @type {number} Years advanced per click of the "Run N years" debug button (PHASES.md T2.07's own Done-when: "running the sim for 30 years visibly changes building counts"). */
const RUN_YEARS_STEP = 30

/**
 * T2.02's own verification harness: a full-screen `MapView` with the
 * debug render/frame counter on, so panning and zooming can be checked
 * by hand and the "no React re-render per frame" claim can be read
 * directly off the HUD instead of trusting devtools. Not part of the
 * real game flow yet — `MapView` itself is what T2.03 onward build on;
 * this page is retired once a real save can drive it.
 *
 * T2.04 adds an optional `?seed=` query parameter (e.g. `?seed=ironway-001`,
 * one of the five golden seeds): when present, a real world is generated
 * and handed to `MapView` as its `world` prop, so the terrain renderer can
 * be checked against real islands rather than the blank placeholder. With
 * no `seed`, this page behaves exactly as it did in T2.02/T2.03. T2.06
 * additionally passes the world's `links`, which draws the road/rail/sea
 * network on the overlay layer and enables `MapView`'s click-to-hit-test
 * debug readout. T2.07 additionally passes `settlements`/`classesRules`
 * (settlement blobs/footprints/buildings on the dynamic layer) and adds
 * a "Run 30 years" button: it builds a runnable `GameState` the same way
 * `sim/tick.test.js` does, calls `sim/tick.js`'s `runYears()`, and then
 * calls `MapView`'s imperative `markDirty()` — `runYears()` mutates
 * `gameState.settlements` in place, and that is the exact same array of
 * objects as `generated.settlements` (never copied), so the next redraw
 * picks up every settlement's new `housing`/`pop` without this page
 * needing to touch React state at all. T2.08 additionally passes
 * `industries` (one sprite per industry on the dynamic layer) and `sim`
 * (the whole `simRef.current` object, so `MapView`'s stale-by-design
 * mount-time closure can still read `sim.gameDay` fresh every frame
 * after `runMoreYears()` mutates that same object's own field —
 * `gameDay` itself is a plain number, which couldn't be "mutated in
 * place" the way the settlement/industry arrays are, so it has to live
 * inside an object that is).
 *
 * @returns {JSX.Element}
 */
export default function MapViewTestPage() {
  const seed = new URLSearchParams(window.location.search).get('seed')
  const [world, setWorld] = useState(null)
  const [error, setError] = useState(null)
  const [yearsRun, setYearsRun] = useState(0)
  const mapViewRef = useRef(null)
  const simRef = useRef(null)

  useEffect(() => {
    if (!seed) return
    let cancelled = false
    async function load() {
      try {
        const rules = await loadRulesBrowser()
        const { world: generated } = generateWorld(seed, DIFFICULTY, rules)
        const difficultyDef = rules.difficulty.find((d) => d.id === DIFFICULTY)
        if (!difficultyDef) throw new Error(`difficulty.json has no "${DIFFICULTY}" entry`)
        const gameState = createGameState(
          generated.settlements,
          generated.industries,
          generated.links,
          { level: rules.economy.startingEconomyLevel, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
          { name: 'Test Co', cash: difficultyDef.startingCash, loans: 0, rankKey: 'novice', stats: {} },
          [],
          [],
        )
        simRef.current = { world: generated, gameState, rules, seed, gameDay: 0 }
        if (!cancelled) {
          setWorld({
            grid: generated.grid,
            landuseEnum: rules.terrain.landuseEnum,
            palette: rules.palette,
            links: generated.links,
            settlements: generated.settlements,
            classesRules: rules.classes,
            industries: generated.industries,
            sim: simRef.current,
          })
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    load()
    return () => { cancelled = true }
  }, [seed])

  /** Advances the running sim by `RUN_YEARS_STEP` years and redraws. @returns {void} */
  function runMoreYears() {
    if (!simRef.current) return
    simRef.current.gameDay = runYears(simRef.current, RUN_YEARS_STEP)
    setYearsRun((n) => n + RUN_YEARS_STEP)
    mapViewRef.current?.markDirty()
  }

  const bounds = world
    ? { minX: 0, minY: 0, maxX: world.grid.width * world.grid.cellMiles, maxY: world.grid.height * world.grid.cellMiles }
    : undefined

  return (
    <div className="map-view-test-page">
      {seed && !world && !error && <p className="map-view-test-page-status">Generating {seed}...</p>}
      {error && <p className="map-view-test-page-status">Failed to generate {seed}: {error}</p>}
      {(!seed || world) && <MapView ref={mapViewRef} showDebugStats world={world} bounds={bounds} />}
      {world?.settlements && (
        <div className="map-view-test-page-sim-controls">
          <button type="button" onClick={runMoreYears}>Run {RUN_YEARS_STEP} years</button>
          <span>{yearsRun} years run</span>
        </div>
      )}
    </div>
  )
}
