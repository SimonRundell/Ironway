/**
 * Main-thread side of the new-game generation worker: spins up
 * src/workers/generateWorldWorker.js, forwards its progress messages,
 * and resolves with the generated world's rows and packed blob.
 *
 * @module sim/generateWorldInWorker
 */

/**
 * Generates a new world off the main thread.
 *
 * @param {string} seed The save's seed.
 * @param {string} difficultyId A difficulty.json id (e.g. "normal").
 * @param {(step: string) => void} [onProgress] Called with a short step name as generation proceeds.
 * @returns {Promise<{meta: object, world: object, blobBase64: string, attempt: number, generationTimeMs: number}>}
 */
export function generateWorldInWorker(seed, difficultyId, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/generateWorldWorker.js', import.meta.url), { type: 'module' })

    worker.onmessage = (event) => {
      const message = event.data

      if (message.type === 'progress') {
        onProgress?.(message.step)
      } else if (message.type === 'done') {
        worker.terminate()
        resolve(message)
      } else if (message.type === 'error') {
        worker.terminate()
        reject(new Error(message.message))
      }
    }

    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message))
    }

    worker.postMessage({ seed, difficultyId })
  })
}
