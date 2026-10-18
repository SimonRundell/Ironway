import apiClient from './client.js'

/**
 * Thin wrappers around the saves/* endpoints in api/saves/ (DESIGN
 * 8.3). Every call returns the decoded response body (or, for
 * getMapBlob(), the raw bytes); callers handle 409/422/etc via the
 * rejected promise's `error.response.status`.
 *
 * @module api/saves
 */

/**
 * Lists the signed-in player's saves with summary stats.
 *
 * @returns {Promise<{saves: object[]}>}
 */
export async function list() {
  const { data } = await apiClient.get('/saves/list.php')
  return data
}

/**
 * Creates a new save: a freshly generated world's meta, entity rows
 * and map blob, in one request.
 *
 * @param {{name: string, seed: string, attempt: number, generatorVersion: number, startYear: number, difficulty: string, settings?: object}} meta
 * @param {object} world Entity rows, as produced by sim/state.js's toRows() (settlements, settlementPop, industries, links, economyState, company, historyMonthly, eventsLog).
 * @param {string} blobBase64 The packed map blob (sim/mapgen/pack.js's packWorld()), base64-encoded.
 * @returns {Promise<{id: number, version: number}>}
 */
export async function create(meta, world, blobBase64) {
  const { data } = await apiClient.post('/saves/create.php', { meta, world, blob: blobBase64 })
  return data
}

/**
 * Loads a save: the save row and every entity table, shaped so the
 * response's own keys can be passed straight into sim/state.js's
 * fromRows(). The map blob itself is fetched separately via
 * getMapBlob().
 *
 * @param {number} id The save id.
 * @returns {Promise<object>} `{ save, settlements, settlementPop, industries, links, economyState, company, historyMonthly, eventsLog }`.
 */
export async function load(id) {
  const { data } = await apiClient.get('/saves/load.php', { params: { id } })
  return data
}

/**
 * Fetches a save's packed map blob as raw bytes, ready for
 * sim/mapgen/pack.js's unpackWorld().
 *
 * @param {number} id The save id.
 * @returns {Promise<Uint8Array>}
 */
export async function getMapBlob(id) {
  const { data } = await apiClient.get('/saves/map.php', { params: { id }, responseType: 'arraybuffer' })
  return new Uint8Array(data)
}

/**
 * Sends a checkpoint: the base version this checkpoint is relative to,
 * the current gameDay, and whichever entity arrays actually changed
 * (DESIGN 4.4). Every entity key is optional; omit ones with nothing
 * to send.
 *
 * @param {object} checkpointBody
 * @param {number} checkpointBody.id
 * @param {number} checkpointBody.baseVersion
 * @param {number} checkpointBody.gameDay
 * @param {object[]} [checkpointBody.settlements]
 * @param {object[]} [checkpointBody.settlementPop]
 * @param {object[]} [checkpointBody.industries]
 * @param {object[]} [checkpointBody.links]
 * @param {object} [checkpointBody.economyState]
 * @param {object} [checkpointBody.company]
 * @param {object[]} [checkpointBody.historyMonthly]
 * @param {object[]} [checkpointBody.eventsLog]
 * @returns {Promise<{version: number}>}
 */
export async function checkpoint(checkpointBody) {
  const { data } = await apiClient.post('/saves/checkpoint.php', checkpointBody)
  return data
}

/**
 * Deletes a save and everything under it.
 *
 * @param {number} id The save id.
 * @returns {Promise<{deleted: boolean}>}
 */
export async function remove(id) {
  const { data } = await apiClient.delete('/saves/delete.php', { params: { id } })
  return data
}
