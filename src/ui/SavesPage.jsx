import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../state/authContext.js'
import { createAutosaveScheduler } from '../state/autosave.js'
import * as savesApi from '../api/saves.js'
import { generateWorldInWorker } from '../sim/generateWorldInWorker.js'
import { base64ToUint8Array } from '../sim/base64.js'
import { unpackWorld } from '../sim/mapgen/pack.js'
import { buildWorldFromLoadResponse } from '../sim/loadWorld.js'
import { checksum } from '../sim/checksum.js'

/**
 * T1.14's own test harness for the client persistence layer: create a
 * new island with a seed, list/load/delete saves, and exercise the
 * autosave/checkpoint/conflict machinery. Deliberately plain —
 * replaced by the real inspector UI in T1.26.
 *
 * @module ui/SavesPage
 */

/**
 * @param {number} saveId A save id.
 * @returns {string} The localStorage key its creation-time grid checksum is stored under.
 */
function checksumStorageKey(saveId) {
  return `ironway.gridChecksum.${saveId}`
}

/**
 * @returns {JSX.Element}
 */
export default function SavesPage() {
  const { user, logout } = useAuth()

  const [difficulties, setDifficulties] = useState([])
  const [seed, setSeed] = useState('')
  const [difficultyId, setDifficultyId] = useState('normal')
  const [generating, setGenerating] = useState(false)
  const [progressStep, setProgressStep] = useState('')
  const [status, setStatus] = useState('')

  const [saves, setSaves] = useState([])
  const [loadingSaves, setLoadingSaves] = useState(false)

  const [activeSave, setActiveSave] = useState(null) // { id, name, gameDay, version, gridChecksum, checksumMatch }
  const [conflict, setConflict] = useState(false)

  const schedulerRef = useRef(null)
  const activeSaveRef = useRef(null)
  useEffect(() => {
    activeSaveRef.current = activeSave
  }, [activeSave])

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

  // The autosave scheduler: whatever save is currently active gets a
  // trivial periodic checkpoint (just gameDay, no entity changes —
  // nothing mutates state yet; that starts at T1.15). A 409 shows the
  // conflict banner, matching DESIGN 4.4's "typical cause: two tabs".
  useEffect(() => {
    const scheduler = createAutosaveScheduler({
      onSave: async () => {
        const current = activeSaveRef.current
        if (!current) return
        try {
          const result = await savesApi.checkpoint({
            id: current.id,
            baseVersion: current.version,
            gameDay: current.gameDay,
          })
          setActiveSave((prev) => (prev && prev.id === current.id ? { ...prev, version: result.version } : prev))
        } catch (err) {
          if (err.response?.status === 409) {
            setConflict(true)
          }
        }
      },
    })
    scheduler.start()
    schedulerRef.current = scheduler
    return () => scheduler.stop()
  }, [])

  /**
   * Generates a new world in the worker, then creates a save from it.
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

      const gridBytes = base64ToUint8Array(result.blobBase64)
      const { grid } = unpackWorld(gridBytes)
      const gridChecksum = checksum(grid)
      localStorage.setItem(checksumStorageKey(created.id), gridChecksum)

      setStatus(
        `Created "${result.meta.name}" (save #${created.id}) in ${result.generationTimeMs}ms `
        + `(attempt ${result.attempt}). Grid checksum: ${gridChecksum}`,
      )
      await refreshSaves()
    } catch (err) {
      setStatus(`Create failed: ${err.response?.data?.error?.message ?? err.message}`)
    } finally {
      setGenerating(false)
      setProgressStep('')
    }
  }

  /**
   * Loads a save: fetches its rows and map blob, reconstructs the
   * World, and compares its grid checksum against the one stored at
   * creation (this is what DESIGN 4.4/T1.14 means by "the world
   * checksum matches the one at creation" — see DECISIONS.md).
   *
   * @param {number} saveId The save to load.
   * @returns {Promise<void>}
   */
  async function handleLoad(saveId) {
    setStatus('')
    setConflict(false)

    try {
      const [loadResponse, mapBytes] = await Promise.all([savesApi.load(saveId), savesApi.getMapBlob(saveId)])
      const { world, gameDay, version } = buildWorldFromLoadResponse(loadResponse, mapBytes)
      const gridChecksum = checksum(world.grid)

      const storedChecksum = localStorage.getItem(checksumStorageKey(saveId))
      const checksumMatch = storedChecksum === null ? null : storedChecksum === gridChecksum

      setActiveSave({ id: saveId, name: world.meta.name, gameDay, version, gridChecksum, checksumMatch })
      setStatus(
        storedChecksum === null
          ? `Loaded "${world.meta.name}". No creation checksum was stored in this browser to compare against.`
          : `Loaded "${world.meta.name}". Grid checksum ${checksumMatch ? 'MATCHES' : 'DOES NOT MATCH'} the one recorded at creation.`,
      )
    } catch (err) {
      setStatus(`Load failed: ${err.response?.data?.error?.message ?? err.message}`)
    }
  }

  /**
   * Deletes a save.
   *
   * @param {number} saveId The save to delete.
   * @returns {Promise<void>}
   */
  async function handleDelete(saveId) {
    setStatus('')
    try {
      await savesApi.remove(saveId)
      if (activeSave?.id === saveId) {
        setActiveSave(null)
      }
      await refreshSaves()
    } catch (err) {
      setStatus(`Delete failed: ${err.response?.data?.error?.message ?? err.message}`)
    }
  }

  /**
   * Sends two checkpoints back to back with the same baseVersion, the
   * way two browser tabs that both last loaded at version N would —
   * the second one must get 409. Exercises the exact conflict path
   * DESIGN 4.4 describes without needing two literal browser windows.
   *
   * @returns {Promise<void>}
   */
  async function handleSimulateConflict() {
    if (!activeSave) return
    setStatus('Simulating two tabs checkpointing from the same version…')

    const body = { id: activeSave.id, baseVersion: activeSave.version, gameDay: activeSave.gameDay }

    const first = await savesApi.checkpoint(body)
    setActiveSave((prev) => (prev ? { ...prev, version: first.version } : prev))

    try {
      await savesApi.checkpoint(body) // same stale baseVersion as the first call
      setStatus('Expected the second checkpoint to conflict, but it succeeded.')
    } catch (err) {
      if (err.response?.status === 409) {
        setConflict(true)
        setStatus('The second tab\'s checkpoint correctly got 409 (stale version).')
      } else {
        setStatus(`Unexpected error: ${err.response?.data?.error?.message ?? err.message}`)
      }
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

      {conflict && (
        <div className="card banner-warning">
          <p>This save has changed elsewhere (maybe another tab). Reload to continue.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

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

      {activeSave && (
        <div className="card">
          <h2>Active: {activeSave.name}</h2>
          <p className="muted">
            gameDay {activeSave.gameDay}, version {activeSave.version}, grid checksum {activeSave.gridChecksum}
          </p>
          <button type="button" onClick={() => schedulerRef.current?.saveNow()}>Save now</button>
          <button type="button" onClick={handleSimulateConflict}>Simulate two-tab conflict</button>
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
                <button type="button" onClick={() => handleLoad(save.id)}>Load</button>
                <button type="button" onClick={() => handleDelete(save.id)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
