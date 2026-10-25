/**
 * Client-side display settings (PHASES.md T2.13's "toggleable in
 * settings"), persisted to `localStorage` so a toggle survives a reload.
 * There is no dedicated settings page yet — that is T2.14's own task
 * ("Accessibility and settings"), which depends on this one — so this
 * module is deliberately the smallest thing that can back a single HUD
 * checkbox today: two plain functions over one namespaced key prefix,
 * with no schema, no React context and no settings-page UI of its own.
 * T2.14 can grow this into whatever its quality/reduced-motion/
 * high-contrast settings need without this module's own shape changing.
 *
 * @module state/settings
 */

/** @type {string} Every key this module reads or writes is namespaced under this prefix, so it never collides with another part of the app's own `localStorage` usage (e.g. `src/api/client.js`'s auth token). */
const STORAGE_PREFIX = 'ironway.settings.'

/**
 * @param {string} key
 * @param {*} defaultValue Returned as-is when the key has never been set, or when `localStorage` itself is unavailable (private browsing's storage cap, a test environment with no DOM).
 * @returns {*}
 */
export function getSetting(key, defaultValue) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key)
    if (raw === null) return defaultValue
    return JSON.parse(raw)
  } catch {
    return defaultValue
  }
}

/**
 * @param {string} key
 * @param {*} value Must be JSON-serialisable.
 * @returns {void}
 */
export function setSetting(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
  } catch {
    // localStorage unavailable or full: the setting simply won't persist
    // past this session, not worth surfacing as an error to the player.
  }
}
