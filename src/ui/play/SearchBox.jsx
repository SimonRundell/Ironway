import { useMemo, useState } from 'react'

/**
 * Search box to jump to a place (PHASES.md T2.12, DESIGN 9.8). Filters
 * settlements and industries by name as the player types; picking a
 * result (click or Enter on the top match) calls `onJump` with its
 * world position, which `ui/PlayPage.jsx` wires to `MapView`'s own
 * `jumpTo()` imperative method for the eased pan/zoom.
 *
 * @module ui/play/SearchBox
 */

/** @type {number} How many matches to list at once. */
const MAX_RESULTS = 8
/** @type {number} The `ppm` a jump settles at — comfortably inside the Area band (DESIGN 9.2), close enough to read the place clearly without landing so tight the surrounding context is lost. */
const JUMP_PPM = 10

/**
 * @param {object} props
 * @param {import('../../sim/state.js').Settlement[]} props.settlements
 * @param {import('../../sim/state.js').Industry[]} props.industries
 * @param {(worldPoint: {x: number, y: number}, ppm: number) => void} props.onJump
 * @returns {JSX.Element}
 */
export default function SearchBox({ settlements, industries, onJump }) {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const settlementMatches = settlements.filter((s) => s.name.toLowerCase().includes(q)).map((s) => ({ type: 'settlement', id: s.id, name: s.name, x: s.x, y: s.y }))
    const industryMatches = industries.filter((i) => i.name.toLowerCase().includes(q)).map((i) => ({ type: 'industry', id: i.id, name: i.name, x: i.x, y: i.y }))
    return [...settlementMatches, ...industryMatches].slice(0, MAX_RESULTS)
  }, [query, settlements, industries])

  /** @param {{x: number, y: number}} place @returns {void} */
  function jumpTo(place) {
    onJump({ x: place.x, y: place.y }, JUMP_PPM)
    setQuery('')
  }

  /** @param {import('react').FormEvent<HTMLFormElement>} event @returns {void} */
  function handleSubmit(event) {
    event.preventDefault()
    if (results[0]) jumpTo(results[0])
  }

  return (
    <div className="hud-panel hud-search">
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search settlements, industries…"
          aria-label="Search for a place"
        />
      </form>
      {results.length > 0 && (
        <ul className="hud-search-results">
          {results.map((place) => (
            <li key={`${place.type}:${place.id}`}>
              <button type="button" onClick={() => jumpTo(place)}>
                {place.name} <span className="muted">({place.type})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
