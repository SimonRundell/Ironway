import axios from 'axios'

/**
 * Axios client wired up for the Ironway API: the base URL is resolved
 * once from public/data/client.json (dev vs production), every request
 * gets the stored bearer token attached, and a 401 response clears the
 * token and sends the player to the login page.
 *
 * @module api/client
 */

const TOKEN_KEY = 'ironway.token'

let configPromise = null

/**
 * Fetches public/data/client.json once and caches the promise, so every
 * request after the first reuses the same result.
 *
 * @returns {Promise<{apiBaseDev: string, apiBaseProd: string}>}
 */
function loadClientConfig() {
  if (configPromise === null) {
    configPromise = fetch('/data/client.json').then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load /data/client.json: HTTP ${response.status}`)
      }
      return response.json()
    })
  }

  return configPromise
}

/**
 * Reads the stored session token, if any.
 *
 * @returns {string|null} The bearer token, or null if signed out.
 */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

/**
 * Stores the session token returned by register or login.
 *
 * @param {string} token The bearer token.
 * @returns {void}
 */
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

/**
 * Removes the stored session token.
 *
 * @returns {void}
 */
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

const apiClient = axios.create()

apiClient.interceptors.request.use(async (config) => {
  const clientConfig = await loadClientConfig()
  config.baseURL = import.meta.env.DEV ? clientConfig.apiBaseDev : clientConfig.apiBaseProd

  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearToken()
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login')
      }
    }

    return Promise.reject(error)
  },
)

export default apiClient
