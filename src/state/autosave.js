/**
 * The autosave scheduler (DESIGN 4.4): triggers a checkpoint on a
 * wall-clock interval, when the tab becomes hidden, and when the page
 * is being unloaded, plus a manual trigger for an explicit "save now".
 *
 * DESIGN 4.4's actual primary trigger is "every autosaveEveryGameMonths
 * game months", which needs T1.15's clock/tick loop to exist at all —
 * there is no gameDay ticking yet to measure months against. This
 * scheduler doesn't know or care who calls it, so T1.15's month-tick
 * handler can simply call `saveNow()` once it exists; nothing here
 * needs to change. The wall-clock interval is this module's own
 * stand-in in the meantime, giving an open session the same practical
 * "checkpoint periodically" behaviour before that hook exists.
 *
 * A save triggered on `pagehide` may not finish before the browser
 * discards the page — DESIGN 4.4 already accepts this ("a rough tab
 * close loses at most one autosave interval"), so this makes no
 * special effort (e.g. `navigator.sendBeacon`) to guarantee delivery;
 * a best-effort request is exactly what DESIGN asks for.
 *
 * @module state/autosave
 */

/**
 * Creates an autosave scheduler. Call `start()` once the game/world is
 * ready, `stop()` when leaving it (e.g. unmounting the inspector).
 *
 * @param {object} options
 * @param {(reason: string) => Promise<void>} options.onSave Called to perform one checkpoint; `reason` is one of 'interval', 'visibility-hidden', 'pagehide', 'manual'.
 * @param {number} [options.intervalMs] Wall-clock interval between autosaves (default 2 minutes).
 * @returns {{start: () => void, stop: () => void, saveNow: () => Promise<void>}}
 */
export function createAutosaveScheduler({ onSave, intervalMs = 120000 }) {
  let intervalId = null
  let saving = false

  /**
   * Runs onSave() for one reason, ignoring overlapping calls (a slow
   * checkpoint already in flight isn't restarted by the next trigger).
   *
   * @param {string} reason Why this save was triggered.
   * @returns {Promise<void>}
   */
  async function triggerSave(reason) {
    if (saving) return
    saving = true
    try {
      await onSave(reason)
    } finally {
      saving = false
    }
  }

  /**
   * @returns {void}
   */
  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      triggerSave('visibility-hidden')
    }
  }

  /**
   * @returns {void}
   */
  function handlePageHide() {
    triggerSave('pagehide')
  }

  /**
   * Starts the interval timer and attaches the pause/page-hide
   * listeners.
   *
   * @returns {void}
   */
  function start() {
    intervalId = setInterval(() => triggerSave('interval'), intervalMs)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)
  }

  /**
   * Stops the interval timer and removes the listeners.
   *
   * @returns {void}
   */
  function stop() {
    clearInterval(intervalId)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('pagehide', handlePageHide)
  }

  return { start, stop, saveNow: () => triggerSave('manual') }
}
