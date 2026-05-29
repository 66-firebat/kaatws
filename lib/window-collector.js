'use strict';

const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Types / JSDoc
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WindowInfo
 * @property {string} address   - The Hyprland window address (e.g. "0x55...")
 * @property {string} class     - The window class (e.g. "firefox")
 * @property {string} title     - The window title
 */

/**
 * @typedef {Object} AppGroup
 * @property {string}       class    - The app class (e.g. "firefox")
 * @property {number}       count    - Number of windows for this app
 * @property {WindowInfo[]} windows  - List of windows
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a window is hidden by the user's config.
 *
 * @param {object} win       - Single client object from hyprctl.
 * @param {object[]} rules   - Array of { class?, title? } from config.hiddenWindows.
 * @returns {boolean}
 */
function isWindowHidden(win, rules) {
  return rules.some((rule) => {
    const hasClass = typeof rule.class === 'string' && rule.class.length > 0;
    const hasTitle = typeof rule.title === 'string' && rule.title.length > 0;

    const classMatch = hasClass
      ? (win.class || '').toLowerCase() === rule.class.toLowerCase()
      : true;
    const titleMatch = hasTitle
      ? (win.title || '').toLowerCase() === rule.title.toLowerCase()
      : true;

    // Both class and title must match if specified (AND logic).
    // If only class is specified, only class needs to match.
    // If only title is specified, only title needs to match.
    return classMatch && titleMatch;
  });
}

/**
 * Call hyprctl clients -j and parse the JSON output.
 *
 * @returns {object[]} Array of client objects.
 */
function fetchClients() {
  const stdout = execFileSync('hyprctl', ['clients', '-j'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  return JSON.parse(stdout);
}

/**
 * Determine whether a client should be considered for the switcher.
 * We skip unmapped windows (they are not visible on any workspace).
 *
 * @param {object} client
 * @returns {boolean}
 */
function isEligible(client) {
  return client.mapped === true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CollectResult
 * @property {AppGroup[]} appGroups     - Running apps, each with its windows.
 * @property {number}     totalWindows  - Total number of eligible windows found.
 */

/**
 * Fetch all windows from Hyprland, group by class, and filter out hidden windows.
 *
 * @param {object[]} hiddenRules  - Array of { class?, title? } rules.
 * @returns {CollectResult}
 */
function collectWindows(hiddenRules = []) {
  const clients = fetchClients();

  // --- Phase 1: group eligible windows by class ---------------------------
  /** @type {Map<string, WindowInfo[]>} */
  const groups = new Map();

  for (const client of clients) {
    // Skip ineligible windows.
    if (!isEligible(client)) continue;

    // Skip hidden windows.
    if (isWindowHidden(client, hiddenRules)) continue;

    const cls = client.class || 'unknown';
    if (!groups.has(cls)) {
      groups.set(cls, []);
    }
    groups.get(cls).push({
      address: client.address,
      class: cls,
      title: client.title || cls,
    });
  }

  // --- Phase 2: build sorted array ----------------------------------------
  const appGroups = [];

  for (const [cls, windows] of groups) {
    appGroups.push({
      class: cls,
      count: windows.length,
      windows,
    });
  }

  // Sort alphabetically by class (case-insensitive).
  appGroups.sort((a, b) => a.class.toLowerCase().localeCompare(b.class.toLowerCase()));

  const totalWindows = appGroups.reduce((sum, g) => sum + g.count, 0);

  return { appGroups, totalWindows };
}

module.exports = { collectWindows };
