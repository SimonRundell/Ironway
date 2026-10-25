import { useEffect, useMemo, useState } from 'react'

/**
 * Search box to jump to a place (PHASES.md T2.12, DESIGN 9.8; T2.14 adds
 * arrow-key navigation through the results). Filters settlements and
 * industries by name as the player types; picking a result (click,
 * arrow keys + Enter, or plain Enter for the top match) calls `onJump`
 * with its world position, which `ui/PlayPage.jsx` wires to `MapView`'s
 * own `jumpTo()` imperative method for the eased pan/zoom.
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
  // -1 means "no result highlighted yet" (plain Enter still jumps to the
  // top match, the pre-T2.14 behaviour) — set only once the player
  // starts pressing arrow keys (PHASES.md T2.14's "keyboard navigation
  // to places").
  const [activeIndex, setActiveIndex] = useState(-1)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const settlementMatches = settlements.filter((s) => s.name.toLowerCase().includes(q)).map((s) => ({ type: 'settlement', id: s.id, name: s.name, x: s.x, y: s.y }))
    const industryMatches = industries.filter((i) => i.name.toLowerCase().includes(q)).map((i) => ({ type: 'industry', id: i.id, name: i.name, x: i.x, y: i.y }))
    return [...settlementMatches, ...industryMatches].slice(0, MAX_RESULTS)
  }, [query, settlements, industries])

  // A new query invalidates whatever was highlighted under the old one.
  useEffect(() => setActiveIndex(-1), [query])

  /** @param {{x: number, y: number}} place @returns {void} */
  function jumpTo(place) {
    onJump({ x: place.x, y: place.y }, JUMP_PPM)
    setQuery('')
  }

  /** @param {import('react').FormEvent<HTMLFormElement>} event @returns {void} */
  function handleSubmit(event) {
    event.preventDefault()
    const place = results[activeIndex] ?? results[0]
    if (place) jumpTo(place)
  }

  /** @param {import('react').KeyboardEvent<HTMLInputElement>} event @returns {void} */
  function handleInputKeyDown(event) {
    if (results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (event.key === 'Escape') {
      setQuery('')
    }
  }

  return (
    <div className="hud-panel hud-search">
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Search settlements, industries…"
          aria-label="Search for a place"
        />
      </form>
      {results.length > 0 && (
        <ul className="hud-search-results">
          {results.map((place, index) => (
            <li key={`${place.type}:${place.id}`}>
              <button type="button" className={index === activeIndex ? 'active' : undefined} onClick={() => jumpTo(place)}>
                {place.name} <span className="muted">({place.type})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
