/**
 * Shared keyboard-accessibility props for the Inspector's data tables:
 * a sortable `<th>` and a clickable `<tr>` are both interactive
 * elements with no native keyboard behaviour of their own, so each
 * needs `tabIndex`, a `role`, and an `onKeyDown` that fires the same
 * handler as a click on Enter or Space.
 *
 * @module ui/inspector/a11y
 */

/**
 * @param {() => void} onActivate Called on click or Enter/Space.
 * @param {string} label Accessible name (e.g. "Sort by name", "Select Hollowstow").
 * @returns {object} Props to spread onto the interactive element (a `<th>` or `<tr>`).
 */
export function interactiveProps(onActivate, label) {
  return {
    onClick: onActivate,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onActivate()
      }
    },
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
  }
}
