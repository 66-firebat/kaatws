'use strict';

const Fuse = require('fuse.js');

// ---------------------------------------------------------------------------
// Flat window collector (for fuzzy search indexing)
// ---------------------------------------------------------------------------

/**
 * Recursively collect all "focus"-type window items from a menu tree,
 * including those nested inside add.svg overflow submenus.
 *
 * @param {object[]} children   - Menu children array.
 * @param {string}   entryName  - Parent app name for context.
 * @returns {object[]} Flat array of { text, entry, parent } objects.
 */
function collectAllWindows(children, entryName) {
  const items = [];
  for (const child of (children || [])) {
    if (child.type === 'submenu' && child.icon === 'add.svg') {
      items.push(...collectAllWindows(child.children, entryName));
    } else if (child.data?.action === 'focus') {
      items.push({ text: (entryName || '') + ' ' + (child.name || ''), entry: child, parent: null });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Fuzzy list builder
// ---------------------------------------------------------------------------

/**
 * Build a flat, searchable list from the current menu state.
 *
 * @param {object[]} focusedFirstEntries  - Reordered entries (focused app first).
 * @param {object|null} submenuExpanded   - Currently expanded submenu state.
 * @param {object}     config             - App config (for fuzzySearch flag).
 * @returns {object[]|null} Array of { text, entry, parent } or null if disabled.
 */
function buildFuzzyList(focusedFirstEntries, submenuExpanded, config) {
  if (!config.fuzzySearch) return null;
  const items = [];
  if (submenuExpanded) {
    for (const child of (submenuExpanded.entry.children || [])) {
      items.push({ text: child.name, entry: child, parent: submenuExpanded.entry });
    }
  } else {
    for (const entry of focusedFirstEntries) {
      items.push({ text: entry.name, entry, parent: null });
      const allWins = collectAllWindows(entry.children, entry.name);
      items.push(...allWins);
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Fuzzy search runner
// ---------------------------------------------------------------------------

/**
 * Run a Fuse.js fuzzy search against the current menu items.
 * Supports special prefixes: ":class <query>", ":title <query>".
 *
 * @param {string}   query                - Search query.
 * @param {object}   config               - App config (for fuzzySearch flag).
 * @param {object[]} focusedFirstEntries  - Reordered entries.
 * @param {object|null} submenuExpanded   - Currently expanded submenu state.
 * @returns {object[]|null} Array of { text, entry, parent } match results.
 */
function runFuzzySearch(query, config, focusedFirstEntries, submenuExpanded) {
  if (!config.fuzzySearch || !query) return null;
  let searchText = query;
  let searchMode = 'all';
  if (query.startsWith(':class ')) { searchMode = 'class'; searchText = query.slice(7); }
  else if (query.startsWith(':title ')) { searchMode = 'title'; searchText = query.slice(7); }
  else if (query === ':' || query === ':class' || query === ':title') return [];

  const items = buildFuzzyList(focusedFirstEntries, submenuExpanded, config);
  if (!items || items.length === 0) return [];

  let filtered = items;
  if (searchMode === 'class') {
    filtered = items.filter(i => !i.parent && i.entry.data?.class);
  } else if (searchMode === 'title') {
    filtered = items.filter(i => i.parent);
  }

  console.log('  Fuse search: %d candidates for "%s"', filtered.length, searchText);
  filtered.slice(0, 15).forEach((it, idx) => {
    console.log('    [%d] text="%s"', idx, it.text.substring(0, 60));
  });

  const fuse = new Fuse(filtered, { keys: ['text'], threshold: 0.4 });
  const results = fuse.search(searchText);
  console.log('  Fuse results: %d', results.length);
  results.slice(0, 5).forEach(r => console.log('    matched: "%s"', r.item.text.substring(0, 60)));
  return results.map(r => r.item);
}

module.exports = {
  collectAllWindows,
  buildFuzzyList,
  runFuzzySearch,
};
