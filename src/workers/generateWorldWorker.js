import { loadRulesBrowser } from '../sim/rules.js'
import { generateWorld } from '../sim/mapgen/world.js'
import { packWorld } from '../sim/mapgen/pack.js'
import { createGameState, toRows } from '../sim/state.js'
import { uint8ArrayToBase64 } from '../sim/base64.js'

/**
 * Web Worker entry point for new-game generation (DESIGN 4.2: "the sim
 * module has no DOM or React imports, so this is a wrapper change
 * only"). Runs generateWorld() off the main thread so a slow seed
 * (near the 5-second validation budget) never freezes the UI, and
 * reports progress between pipeline stages.
 *
 * Posts `{type: 'progress', step}` messages while working, then
 * exactly one of `{type: 'done', ...}` or `{type: 'error', message}`.
 *
 * @module workers/generateWorldWorker
 */

self.onmessage = async (event) => {
  const { seed, difficultyId } = event.data

  try {
    self.postMessage({ type: 'progress', step: 'loading-rules' })
    const rules = await loadRulesBrowser()

    const difficultyDef = rules.difficulty.find((d) => d.id === difficultyId)
    if (!difficultyDef) {
      throw new Error(`Unknown difficulty "${difficultyId}".`)
    }

    self.postMessage({ type: 'progress', step: 'generating' })
    const { world, attempt, generationTimeMs } = generateWorld(seed, difficultyId, rules)

    self.postMessage({ type: 'progress', step: 'packing' })
    const gameState = createGameState(
      world.settlements,
      world.industries,
      world.links,
      { level: 2, lastChangeDir: 0, lastCheckDay: 0, indicators: {} },
      { name: 'New Transport Co', cash: difficultyDef.startingCash, loans: 0, rankKey: 'novice', stats: {} },
      [],
      [],
    )
    const rows = toRows(gameState)
    const blob = packWorld(world.grid)
    const blobBase64 = uint8ArrayToBase64(blob)

    self.postMessage({
      type: 'done',
      meta: world.meta,
      world: rows,
      blobBase64,
      attempt,
      generationTimeMs,
    })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
