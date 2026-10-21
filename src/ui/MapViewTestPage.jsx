import { useEffect, useState } from 'react'
import { generateWorld } from '../sim/mapgen/world.js'
import { loadRulesBrowser } from '../sim/rules.js'
import MapView from './MapView.jsx'

/** @type {string} difficulty.json id used for every test-page generation; the terrain itself doesn't depend on difficulty. */
const DIFFICULTY = 'normal'

/**
 * T2.02's own verification harness: a full-screen `MapView` with the
 * debug render/frame counter on, so panning and zooming can be checked
 * by hand and the "no React re-render per frame" claim can be read
 * directly off the HUD instead of trusting devtools. Not part of the
 * real game flow yet — `MapView` itself is what T2.03 onward build on;
 * this page is retired once a real save can drive it (around T2.07).
 *
 * T2.04 adds an optional `?seed=` query parameter (e.g. `?seed=ironway-001`,
 * one of the five golden seeds): when present, a real world is generated
 * and handed to `MapView` as its `world` prop, so the terrain renderer can
 * be checked against real islands rather than the blank placeholder. With
 * no `seed`, this page behaves exactly as it did in T2.02/T2.03. T2.06
 * additionally passes the world's `links`, which draws the road/rail/sea
 * network on the overlay layer and enables `MapView`'s click-to-hit-test
 * debug readout.
 *
 * @returns {JSX.Element}
 */
export default function MapViewTestPage() {
  const seed = new URLSearchParams(window.location.search).get('seed')
  const [world, setWorld] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!seed) return
    let cancelled = false
    async function load() {
      try {
        const rules = await loadRulesBrowser()
        const { world: generated } = generateWorld(seed, DIFFICULTY, rules)
        if (!cancelled) setWorld({ grid: generated.grid, landuseEnum: rules.terrain.landuseEnum, palette: rules.palette, links: generated.links })
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    load()
    return () => { cancelled = true }
  }, [seed])

  const bounds = world
    ? { minX: 0, minY: 0, maxX: world.grid.width * world.grid.cellMiles, maxY: world.grid.height * world.grid.cellMiles }
    : undefined

  return (
    <div className="map-view-test-page">
      {seed && !world && !error && <p className="map-view-test-page-status">Generating {seed}...</p>}
      {error && <p className="map-view-test-page-status">Failed to generate {seed}: {error}</p>}
      {(!seed || world) && <MapView showDebugStats world={world} bounds={bounds} />}
    </div>
  )
}
