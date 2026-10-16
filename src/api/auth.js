import apiClient from './client.js'

/**
 * Thin wrappers around the auth endpoints in api/auth/.
 *
 * @module api/auth
 */

/**
 * Registers a new account.
 *
 * @param {string} username Desired username.
 * @param {string} password Desired password.
 * @param {string} [email] Optional email address.
 * @returns {Promise<{token: string, user: {id: number, username: string}}>}
 */
export async function register(username, password, email) {
  const body = { username, password }
  if (email) {
    body.email = email
  }

  const { data } = await apiClient.post('/auth/register.php', body)
  return data
}

/**
 * Signs in with a username and password.
 *
 * @param {string} username Account username.
 * @param {string} password Account password.
 * @returns {Promise<{token: string, user: {id: number, username: string}}>}
 */
export async function login(username, password) {
  const { data } = await apiClient.post('/auth/login.php', { username, password })
  return data
}

/**
 * Deletes the current session on the server.
 *
 * @returns {Promise<void>}
 */
export async function logout() {
  await apiClient.post('/auth/logout.php')
}

/**
 * Fetches the currently authenticated user.
 *
 * @returns {Promise<{id: number, username: string, email: ?string, createdAt: string}>}
 */
export async function me() {
  const { data } = await apiClient.get('/auth/me.php')
  return data
}
