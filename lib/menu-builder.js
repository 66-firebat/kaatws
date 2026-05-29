'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUICK_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to maxLen, appending '…' if it exceeds.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.substring(0, maxLen - 1) + '…';
}

/**
 * Resolve an icon filename for a given CSS class from the configured theme directory.
 * @param {string} cls  - The window/class name.
 * @param {object} config
 * @returns {string} Icon filename (e.g. "Firefox.svg" or "firefox.png").
 */
function resolveIcon(cls, config) {
  const themeDir = path.join(config.iconThemeDirectory, config.iconTheme);
  const candidates = [cls, cls.toLowerCase()];
  for (const name of candidates) {
    for (const ext of ['.svg', '.png']) {
      const filePath = path.join(themeDir, name + ext);
      try { if (fs.statSync(filePath).isFile()) return name + ext; } catch {}
    }
  }
  return cls;
}

// ---------------------------------------------------------------------------
// Overflow page builder (recursive)
// ---------------------------------------------------------------------------

/**
 * Build a recursive overflow page with up to 6 items + add.svg if more.
 * Used when a group has more windows than fit on one page.
 *
 * @param {object[]} windows          - Window entries to display.
 * @param {object}   config
 * @param {number}   truncationLimit
 * @param {string}   icon             - Resolved icon name.
 * @param {string}   appClass         - The app class for overflow navigation.
 * @returns {object[]} Menu children array.
 */
function buildOverflowPage(windows, config, truncationLimit, icon, appClass) {
  const page = windows.slice(0, 5);
  const remaining = windows.length - page.length;
  const children = page.map((win, i) => ({
    type: 'simple-button',
    name: truncate(win.title, truncationLimit),
    icon, iconTheme: config.iconTheme,
    angle: i * 60,
    data: { address: win.address, class: win.class, action: 'focus' },
  }));
  if (remaining > 0) {
    const nextOverflow = buildOverflowPage(windows.slice(5), config, truncationLimit, icon, appClass);
    children.push({
      type: 'submenu',
      name: '+' + remaining,
      icon: 'add.svg', iconTheme: config.iconTheme,
      angle: 5 * 60,
      data: { action: 'show-overflow', class: appClass },
      children: nextOverflow,
    });
  }
  return children;
}

// ---------------------------------------------------------------------------
// Entry list builder
// ---------------------------------------------------------------------------

/**
 * Build the complete flat list of menu entries from app groups and default apps.
 *
 * @param {object}   config
 * @param {object[]} appGroups
 * @returns {object[]} Array of menu entries (simple-button or submenu).
 */
function collectAllEntries(config, appGroups) {
  const { truncationLimit, defaultApps, submenuThreshold } = config;
  const entries = [];
  for (const group of appGroups) {
    const icon = resolveIcon(group.class, config);
    const truncatedName = truncate(group.class, truncationLimit);
    if (group.count >= submenuThreshold) {
      const previewWindows = group.windows.slice(0, 5);
      const remaining = group.windows.length - previewWindows.length;
      const children = previewWindows.map((win, i) => ({
        type: 'simple-button',
        name: truncate(win.title, truncationLimit),
        icon, iconTheme: config.iconTheme,
        angle: i * 60,
        data: { address: win.address, class: win.class, action: 'focus' },
      }));
      if (remaining > 0) {
        const overflowChildren = buildOverflowPage(
          group.windows.slice(5), config, truncationLimit, icon, group.class
        );
        children.push({
          type: 'submenu',
          name: '+' + remaining,
          icon: 'add.svg', iconTheme: config.iconTheme,
          angle: 5 * 60,
          data: { class: group.class, action: 'show-overflow' },
          children: overflowChildren,
        });
      }
      entries.push({
        type: 'submenu', name: truncatedName, icon,
        iconTheme: config.iconTheme,
        data: { class: group.class, count: group.count },
        children,
      });
    } else {
      entries.push({
        type: 'simple-button', name: truncatedName, icon,
        iconTheme: config.iconTheme,
        data: { address: group.windows[0].address, class: group.class, action: 'focus' },
      });
    }
  }
  const runningClasses = new Set(appGroups.map((g) => g.class.toLowerCase()));
  for (const app of defaultApps) {
    if (runningClasses.has(app.name.toLowerCase())) continue;
    const icon = resolveIcon(app.name, config);
    entries.push({
      type: 'simple-button', name: truncate(app.name, truncationLimit), icon,
      iconTheme: config.iconTheme,
      data: { command: app.command, action: 'launch' },
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter entries by an optional string (simple lowercase substring match
 * or fuzzy-search results).
 *
 * @param {object[]} allEntries
 * @param {string}   filterString
 * @param {boolean}  fuzzyMode
 * @param {object[]} [fuzzyItems]  Pre-computed fuzzy search results.
 * @returns {object[]}
 */
function getFiltered(allEntries, filterString, fuzzyMode, fuzzyItems) {
  if (!filterString) return allEntries;
  if (fuzzyMode && fuzzyItems) {
    const seen = new Set();
    const result = [];
    for (const fi of fuzzyItems) {
      if (fi.parent) {
        const key = 'win:' + (fi.entry.name || '') + (fi.entry.data?.address || '');
        if (!seen.has(key)) { seen.add(key); result.push(fi.entry); }
      } else {
        const key = 'app:' + (fi.entry.name || '') + (fi.entry.data?.class || '');
        if (!seen.has(key)) { seen.add(key); result.push(fi.entry); }
      }
    }
    return result;
  }
  const lower = filterString.toLowerCase();
  return allEntries.filter((e) => e.name.toLowerCase().includes(lower));
}

/**
 * Simple center text helper.
 * @param {string} filterString
 * @returns {string}
 */
function centerName(filterString) {
  return filterString || '';
}

// ---------------------------------------------------------------------------
// Angle assignment
// ---------------------------------------------------------------------------

/**
 * Assign evenly-spaced angles and optional quick-select keys to menu items.
 *
 * @param {object[]} items
 * @param {number}   maxItems
 * @returns {object[]}
 */
function assignAngles(items, maxItems) {
  const step = 360 / maxItems;
  return items.map((item, i) => ({
    ...item,
    angle: i * step,
    quickSelectKey: i < QUICK_KEYS.length ? QUICK_KEYS[i] : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Paginated root builders
// ---------------------------------------------------------------------------

/**
 * Build a paginated root menu with a custom center name (used for fuzzy search results).
 *
 * @param {object[]} displayEntries
 * @param {object}   config
 * @param {number}   mainSelection
 * @param {string}   rootName
 * @param {number}   maxItems
 * @returns {object} A simple-button node with paginated children.
 */
function buildPaginatedRootWithName(displayEntries, config, mainSelection, rootName, maxItems) {
  const marked = displayEntries.map((entry, i) => {
    if (i === mainSelection) {
      const sel = entry.icon.replace(/(\.[^.]+)$/, '_selected$1');
      return { ...entry, icon: sel, iconTheme: config.iconTheme };
    }
    return entry;
  });
  if (marked.length <= maxItems) {
    return {
      type: 'simple-button', name: rootName,
      icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
      children: assignAngles([...marked], maxItems),
    };
  }
  const pageSize = maxItems - 1;
  const pageItems = marked.slice(0, pageSize);
  const overflowItems = marked.slice(pageSize);
  function makeOverflow(items) {
    if (items.length <= maxItems) return items.map((e, i) => ({ ...e, angle: i * 60 }));
    const ov = items.slice(0, pageSize);
    const rest = items.slice(pageSize);
    ov.push({
      type: 'submenu', name: '+' + rest.length, icon: 'add.svg',
      iconTheme: config.iconTheme, angle: pageSize * 60,
      data: { action: 'show-overflow' },
      children: makeOverflow(rest),
    });
    return ov;
  }
  const overflowChildren = makeOverflow(overflowItems);
  pageItems.push({
    type: 'submenu', name: '+' + overflowItems.length, icon: 'add.svg',
    iconTheme: config.iconTheme, angle: pageSize * 60,
    data: { action: 'show-overflow' },
    children: overflowChildren,
  });
  return {
    type: 'simple-button', name: rootName,
    icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
    children: assignAngles(pageItems, maxItems),
  };
}

/**
 * Build the main paginated root menu for the switcher.
 *
 * @param {object[]}  allEntries
 * @param {number}    currentPage        - (unused, reserved)
 * @param {object}    config
 * @param {string}    filterString
 * @param {number}    mainSelection
 * @param {object[]}  [preFiltered]      - Pre-filtered entries (skips getFiltered).
 * @param {string}    [overrideRootName] - Custom root name (fuzzy mode).
 * @returns {object} A simple-button node with paginated children.
 */
function buildPaginatedRoot(allEntries, currentPage, config, filterString,
                            mainSelection, preFiltered, overrideRootName) {
  const { maxItems } = config;
  let displayEntries = preFiltered || getFiltered(allEntries, filterString);

  if (overrideRootName !== undefined) {
    return buildPaginatedRootWithName(displayEntries, config, mainSelection,
                                      overrideRootName, maxItems);
  }

  if (displayEntries.length === 0) {
    return {
      type: 'simple-button', name: '>',
      icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
      children: undefined,
    };
  }

  const selIdx = Math.min(mainSelection, displayEntries.length - 1);
  const selName = displayEntries[selIdx]?.name || '';
  const rootName = truncate(selName, 35) + '  (' + (selIdx + 1) + '/' + displayEntries.length + ')';

  const marked = displayEntries.map((entry, i) => {
    if (i === mainSelection) {
      const sel = entry.icon.replace(/(\.[^.]+)$/, '_selected$1');
      return { ...entry, icon: sel, iconTheme: config.iconTheme };
    }
    return entry;
  });

  const pageSize = maxItems - 1;
  if (marked.length > maxItems) {
    const pageItems = marked.slice(0, pageSize);
    const overflowItems = marked.slice(pageSize);
    function makeOverflow(items) {
      if (items.length <= maxItems) return items.map((e, i) => ({ ...e, angle: i * 60 }));
      const ov = items.slice(0, pageSize);
      const rest = items.slice(pageSize);
      ov.push({
        type: 'submenu', name: '+' + rest.length, icon: 'add.svg',
        iconTheme: config.iconTheme, angle: pageSize * 60,
        data: { action: 'show-overflow' },
        children: makeOverflow(rest),
      });
      return ov;
    }
    const overflowChildren = makeOverflow(overflowItems);
    pageItems.push({
      type: 'submenu', name: '+' + overflowItems.length, icon: 'add.svg',
      iconTheme: config.iconTheme, angle: pageSize * 60,
      data: { action: 'show-overflow' },
      children: overflowChildren,
    });
    return {
      type: 'simple-button', name: rootName,
      icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
      children: assignAngles(pageItems, maxItems),
    };
  }

  return {
    type: 'simple-button', name: rootName,
    icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
    children: assignAngles([...marked], maxItems),
  };
}

// ---------------------------------------------------------------------------
// Submenu page builder
// ---------------------------------------------------------------------------

/**
 * Build a submenu page (e.g. after expanding an app group).
 *
 * @param {object} submenuEntry  - The submenu node with .children.
 * @param {object} config
 * @param {string} filterString  - (unused, reserved)
 * @param {number} selection     - Current selection index.
 * @returns {object} A simple-button node with submenu children.
 */
function buildSubmenuPage(submenuEntry, config, filterString, selection) {
  const children = (submenuEntry.children || []).map((child, i) => {
    const c = { ...child };
    if (i === selection) {
      const sel = c.icon.replace(/(\.[^.]+)$/, '_selected$1');
      c.icon = sel; c.iconTheme = config.iconTheme;
    }
    return c;
  });
  const maxItems = config.maxItems;
  const selName = children[selection]?.name || '';
  const center = truncate(selName, 35) + '  (' + (selection + 1) + '/' + children.length + ')';
  return {
    type: 'simple-button', name: center,
    icon: 'arrow_' + (selection + 1) + '.svg', iconTheme: config.iconTheme,
    children: assignAngles(children, maxItems),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveIcon,
  buildOverflowPage,
  collectAllEntries,
  getFiltered,
  centerName,
  assignAngles,
  buildPaginatedRootWithName,
  buildPaginatedRoot,
  buildSubmenuPage,
  truncate,
  QUICK_KEYS,
};
