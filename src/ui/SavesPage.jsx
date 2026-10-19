import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/authContext.js'
import * as savesApi from '../api/saves.js'
import { generateWorldInWorker } from '../sim/generateWorldInWorker.js'

/**
 * Saves (PHASES.md T1.26): list, create a new island with a seed and
 * difficulty, delete. Loading a save, and everything about actually
 * running one, lives in the Inspector (`ui/InspectorPage.jsx`) from
 * here on — this page only ever navigates there.
 *
 * @module ui/SavesPage
 */

/**
 * @returns {JSX.Element}
 */
export default function SavesPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const [difficulties, setDifficulties] = useState([])
  const [seed, setSeed] = useState('')
  const [difficultyId, setDifficultyId] = useState('normal')
  const [generating, setGenerating] = useState(false)
  const [progressStep, setProgressStep] = useState('')
  const [status, setStatus] = useState('')

  const [saves, setSaves] = useState([])
  const [loadingSaves, setLoadingSaves] = useState(false)

  const refreshSaves = useCallback(async () => {
    setLoadingSaves(true)
    try {
      const { saves: list } = await savesApi.list()
      setSaves(list)
    } catch (err) {
      setStatus(`Could not load your saves: ${err.response?.data?.error?.message ?? err.message}`)
    } finally {
      setLoadingSaves(false)
    }
  }, [])

  useEffect(() => {
    fetch('/data/difficulty.json')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => setDifficulties(data.difficulties))
      .catch(() => setDifficulties([]))

    refreshSaves()
  }, [refreshSaves])

  /**
   * Generates a new world in the worker, creates a save from it, then
   * jumps straight into the Inspector — there's no separate "active
   * save" state to track here any more.
   *
   * @param {import('react').FormEvent<HTMLFormElement>} event Form submit event.
   * @returns {Promise<void>}
   */
  async function handleCreate(event) {
    event.preventDefault()
    setStatus('')
    setGenerating(true)
    setProgressStep('starting')

    try {
      const result = await generateWorldInWorker(seed, difficultyId, setProgressStep)
      setProgressStep('saving')
      const created = await savesApi.create(result.meta, result.world, result.blobBase64)
      navigate(`/island/${created.id}`)
    } catch (err) {
      setStatus(`Create failed: ${err.response?.data?.error?.message ?? err.message}`)
      setGenerating(false)
      setProgressStep('')
    }
  }

  /**
   * @param {number} saveId The save to delete.
   * @returns {Promise<void>}
   */
  async function handleDelete(saveId) {
    setStatus('')
    try {
      await savesApi.remove(saveId)
      await refreshSaves()
    } catch (err) {
      setStatus(`Delete failed: ${err.response?.data?.error?.message ?? err.message}`)
    }
  }

  return (
    <main className="page">
      <h1 className="brand">
        <img className="brand-logo" src="/favicon.png" alt="Ironway" />
      </h1>

      <div className="card">
        <p className="muted">Signed in as {user.username}.</p>
        <button type="button" onClick={logout}>Log out</button>
      </div>

      <div className="card">
        <h2>New island</h2>
        <form onSubmit={handleCreate}>
          <label className="field">
            Seed
            <input value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="e.g. ironway-001" required />
          </label>
          <label className="field">
            Difficulty
            <select value={difficultyId} onChange={(event) => setDifficultyId(event.target.value)}>
              {difficulties.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={generating}>
            {generating ? `Generating (${progressStep})…` : 'Create island'}
          </button>
        </form>
      </div>

      {status && (
        <div className="card">
          <p>{status}</p>
        </div>
      )}

      <div className="card">
        <h2>Your islands</h2>
        {loadingSaves && <p className="muted">Loading…</p>}
        {!loadingSaves && saves.length === 0 && <p className="muted">No saves yet.</p>}
        <ul className="saves-list">
          {saves.map((save) => (
            <li key={save.id}>
              <span>
                {save.name} — day {save.gameDay}, v{save.version}, {save.population.toLocaleString()} people
              </span>
              <span>
                <button type="button" onClick={() => navigate(`/island/${save.id}`)}>Load</button>
                <button type="button" onClick={() => handleDelete(save.id)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
