#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const Fuse = require('fuse.js');
const { loadConfig } = require('./lib/config');
const { collectWindows } = require('./lib/window-collector');
const { KandoIPCClient } = require('./lib/kando-ipc');
const { KeyboardCapture } = require('./lib/key-capture');

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

/** Build a recursive overflow page with up to 6 items + add.svg if more. */
function buildOverflowPage(windows, config, truncationLimit, icon, appClass) {
  // Show 5 items + add.svg at position 5 (300°) to avoid overlapping.
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

function collectAllEntries(config, appGroups) {
  const { truncationLimit, defaultApps, submenuThreshold } = config;
  const entries = [];
  for (const group of appGroups) {
    const icon = resolveIcon(group.class, config);
    const truncatedName = truncate(group.class, truncationLimit);
    if (group.count >= submenuThreshold) {
      // Build submenu preview children (max 5 + optional +N indicator)
      // Fixed angles at 0°, 60°, 120°, 180°, 240° align with 60° spacing
      // and account for Kando's parent gap logic (all items have fixed angles).
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
        const overflowChildren = buildOverflowPage(group.windows.slice(5), config, truncationLimit, icon, group.class);
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

function getFiltered(allEntries, filterString, fuzzyMode, fuzzyItems) {
  if (!filterString) return allEntries;
  if (fuzzyMode && fuzzyItems) {
    // Include both app entries and individual window matches
    const seen = new Set();
    const result = [];
    for (const fi of fuzzyItems) {
      // If match is on a window title, show the individual window
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

function centerName(filterString) {
  return filterString || '';
}

const QUICK_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];

function assignAngles(items, maxItems) {
  const step = 360 / maxItems;
  return items.map((item, i) => ({
    ...item,
    angle: i * step,
    quickSelectKey: i < QUICK_KEYS.length ? QUICK_KEYS[i] : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Desktop file lookup
// ---------------------------------------------------------------------------

const DESKTOP_DIRS = [
  '/run/current-system/sw/share/applications',
  process.env.HOME + '/.local/share/applications',
  '/usr/share/applications',
  '/usr/local/share/applications',
];

function getLaunchCommand(appClass) {
  const lowerClass = appClass.toLowerCase();
  for (const dir of DESKTOP_DIRS) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.desktop')) continue;
        try {
          const content = fs.readFileSync(dir + '/' + file, 'utf-8');
          const wmMatch = content.match(/^StartupWMClass=(.+)$/m);
          const nameMatch = content.match(/^Name=(.+)$/m);
          const fileBase = file.replace('.desktop', '').toLowerCase();
          const wmClass = wmMatch ? wmMatch[1].toLowerCase() : '';
          const appName = nameMatch ? nameMatch[1].toLowerCase() : '';
          if (wmClass === lowerClass || fileBase === lowerClass || appName === lowerClass) {
            const execMatch = content.match(/^Exec=(.+)$/m);
            if (execMatch) {
              return execMatch[1].replace(/%[uUfFc]/g, '').trim();
            }
          }
        } catch {}
      }
    } catch {}
  }
  return appClass;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.substring(0, maxLen - 1) + '…';
}

function lookupItemByPath(root, path) {
  let item = root;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (!item.children || idx >= item.children.length) return null;
    item = item.children[idx];
  }
  return item;
}

function executeItem(item, client, config) {
  const data = item.data || {};
  switch (data.action) {
    case 'focus': {
      const address = data.address;
      if (!address) { console.error('✖ No address'); break; }
      try {
        const cmd = 'hyprctl dispatch \'hl.dsp.focus({ window = "address:' + address + '" })\'';
        console.log('→ Focusing %s (%s)', truncate(address, 16), item.name);
        execSync(cmd, { timeout: 3000 });
      } catch (err) { console.error('✖ Focus failed:', err.message); }
      break;
    }
    case 'launch': {
      const command = data.command;
      if (!command) { console.error('✖ No command'); break; }
      console.log('→ Launching %s', item.name);
      exec('nohup ' + command + ' > /dev/null 2>&1 &', { detached: true });
      break;
    }
    case 'show-overflow':
      return 'ignore';
    default:
      if (data.action) console.error('✖ Unknown action:', data.action);
      break;
  }
  try { execSync('kando --close-menu', { timeout: 2000 }); } catch {}
  client.close();
  process.exit(0);
}

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
      type: 'simple-button', name: rootName, icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
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
    type: 'simple-button', name: rootName, icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
    children: assignAngles(pageItems, maxItems),
  };
}

function buildPaginatedRoot(allEntries, currentPage, config, filterString, mainSelection, preFiltered, overrideRootName) {
  const { maxItems } = config;
  let displayEntries = preFiltered || getFiltered(allEntries, filterString);

  if (overrideRootName !== undefined) {
    return buildPaginatedRootWithName(displayEntries, config, mainSelection, overrideRootName, maxItems);
  }

  if (displayEntries.length === 0) {
    return { type: 'simple-button', name: '>', icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme, children: undefined };
  }

  // Compute center text: show selected item's name
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

  // Show up to 6 items + add.svg overflow submenu if there are more.
  const pageSize = maxItems - 1; // reserve last slot for add.svg if needed
  if (marked.length > maxItems) {
    const pageItems = marked.slice(0, pageSize);
    const overflowItems = marked.slice(pageSize);
    // Build recursive overflow submenu
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
      type: 'simple-button', name: rootName, icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
      children: assignAngles(pageItems, maxItems),
    };
  }

  return {
    type: 'simple-button', name: rootName, icon: 'arrow_' + (mainSelection + 1) + '.svg', iconTheme: config.iconTheme,
    children: assignAngles([...marked], maxItems),
  };
}

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
    type: 'simple-button', name: center, icon: 'arrow_' + (selection + 1) + '.svg', iconTheme: config.iconTheme,
    children: assignAngles(children, maxItems),
  };
}

async function main() {
  const { config, errors, warnings } = loadConfig();
  for (const w of warnings) console.warn('⚠', w);
  for (const e of errors) { console.error('✖', e); }
  if (errors.length > 0) { console.error('Aborting.'); process.exit(1); }

  console.log('✓ Configuration loaded');
  console.log('  defaultApps:', config.defaultApps.length, ' maxItems:', config.maxItems);

  let appGroups = [];
  try {
    const result = collectWindows(config.hiddenWindows);
    appGroups = result.appGroups;
    console.log('✓ Collected %d windows across %d apps', result.totalWindows, appGroups.length);
  } catch (err) { console.error('✖ Failed:', err.message); process.exit(1); }

  let allEntries = collectAllEntries(config, appGroups);
  console.log('✓ All entries: %d', allEntries.length);

  // Capture the currently focused window so we can pin it at 0°.
  let focusedClass = null, focusedFirstEntries = allEntries;
  try {
    const stdout = execSync('hyprctl activewindow -j', { timeout: 3000, encoding: 'utf-8' });
    const data = JSON.parse(stdout);
    if (data && data.class) {
      focusedClass = data.class;
      // Reorder: put the focused app first, keep others in original order
      const lowerClass = focusedClass.toLowerCase();
      const idx = allEntries.findIndex(e => e.name.toLowerCase() === lowerClass);
      if (idx > 0) {
        focusedFirstEntries = [allEntries[idx], ...allEntries.slice(0, idx), ...allEntries.slice(idx + 1)];
      }
    }
  } catch {}
  console.log('✓ Focused:', focusedClass || '(unknown)');

  let currentRoot = null, filterString = '';
  let mainSelection = 0, submenuExpanded = null, submenuSelection = 0;
  let fuzzyMode = false; // true when user is typing a fuzzy search
  let prevFilterString = '';
  let prevMainSelection = 0;
  let prevSubmenuState = null;

  // Build a flat searchable list from all entries + window titles
  // Recursively collect all windows (including those inside add.svg overflows)
  function collectAllWindows(children, entryName) {
    const items = [];
    for (const child of (children || [])) {
      if (child.type === 'submenu' && child.icon === 'add.svg') {
        // Recursively collect from overflow submenu
        items.push(...collectAllWindows(child.children, entryName));
      } else {
        items.push({ text: (entryName || '') + ' ' + (child.name || ''), entry: child, parent: null });
      }
    }
    return items;
  }

  function buildFuzzyList() {
    if (!config.fuzzySearch) return null;
    const items = [];
    if (submenuExpanded) {
      for (const child of (submenuExpanded.entry.children || [])) {
        items.push({ text: child.name, entry: child, parent: submenuExpanded.entry });
      }
    } else {
      for (const entry of focusedFirstEntries) {
        items.push({ text: entry.name, entry, parent: null });
        // Recursively collect ALL windows including overflow
        const allWins = collectAllWindows(entry.children, entry.name);
        items.push(...allWins);
      }
    }
    return items;
  }

  function runFuzzySearch(query) {
    if (!config.fuzzySearch || !query) return null;
    let searchText = query;
    let searchMode = 'all';
    if (query.startsWith(':class ')) { searchMode = 'class'; searchText = query.slice(7); }
    else if (query.startsWith(':title ')) { searchMode = 'title'; searchText = query.slice(7); }
    else if (query === ':' || query === ':class' || query === ':title') return [];

    const items = buildFuzzyList();
    if (!items || items.length === 0) return [];

    let filtered = items;
    if (searchMode === 'class') {
      filtered = items.filter(i => !i.parent && i.entry.data?.class);
    } else if (searchMode === 'title') {
      filtered = items.filter(i => i.parent);
    }

    console.log('  Fuse search: %d candidates for "%s"', filtered.length, searchText);
    // Show all candidate texts (first 15)
    filtered.slice(0, 15).forEach((it, idx) => {
      console.log('    [%d] text="%s"', idx, it.text.substring(0, 60));
    });

    const fuse = new Fuse(filtered, { keys: ['text'], threshold: 0.4 });
    const results = fuse.search(searchText);
    console.log('  Fuse results: %d', results.length);
    results.slice(0, 5).forEach(r => console.log('    matched: "%s"', r.item.text.substring(0, 60)));
    return results.map(r => r.item);
  }

  let lastFuzzyItems = null;

  function sendCurrentPage(client) {
    let entries = focusedFirstEntries;
    let useFuzzy = null;
    if (config.fuzzySearch && fuzzyMode && filterString) {
      useFuzzy = runFuzzySearch(filterString);
      lastFuzzyItems = useFuzzy;
      // Debug: show what fuzzy found
      if (useFuzzy) {
        console.log('  Fuzzy debug: %d raw results for "%s":', useFuzzy.length, filterString);
        useFuzzy.slice(0, 10).forEach(f => {
          const type = f.parent ? 'window' : 'app';
          console.log('    [%s] text="%s" name="%s"', type, f.text.substring(0, 60), (f.entry?.name || '').substring(0, 40));
        });
      }
    } else {
      lastFuzzyItems = null;
    }
    const filtered = getFiltered(entries, filterString, fuzzyMode, useFuzzy);
    if (fuzzyMode && filterString) {
      const rootName = filterString;
      const root = buildPaginatedRoot(entries, 0, config, filterString, mainSelection, filtered, rootName);
      const count = root.children ? root.children.length : 0;
      console.log('  Fuzzy: %d item(s) in menu for "%s"', count, filterString);
      if (filtered.length > 0) {
        filtered.slice(0, 10).forEach(e => console.log('    entry: "%s" type=%s class=%s', e.name, e.type || '?', e.data?.class || '?'));
      }
      client.showMenu(root);
      return root;
    }
    const root = buildPaginatedRoot(entries, 0, config, filterString, mainSelection, filtered);
    const count = root.children ? root.children.length : 0;
    const info = filterString ? ' filter="' + filterString + '"' : '';
    console.log('  Menu: %d item(s)%s', count, info);
    client.showMenu(root);
    return root;
  }

  const client = new KandoIPCClient();
  let menuOpened = false;
  client.on('open', () => { if (menuOpened) return; menuOpened = true; console.log('✓ Kando menu opened'); });

  let lastSelectKey = '';
  client.on('select', (ev) => {
    const key = ev.target + ':' + ev.path.join(',');
    if (key === lastSelectKey) return;
    lastSelectKey = key;

    // Track submenu expansion so Enter works after clicking into a submenu.
    if (ev.target === 'submenu' && currentRoot?.children) {
      const subIdx = ev.path[0];
      const subEntry = currentRoot.children[subIdx];
      if (subEntry?.children) {
        submenuExpanded = { entry: subEntry, parentRoot: currentRoot };
        submenuSelection = 0;
      }
      return;
    }
    if (ev.target === 'parent') {
      submenuExpanded = null;
      submenuSelection = 0;
      return;
    }

    if (ev.target !== 'item') return;
    const item = lookupItemByPath(currentRoot, ev.path);
    if (!item) { console.error('✖ No item at path %j', ev.path); return; }
    executeItem(item, client, config);
  });

  let cancelled = false;
  client.on('cancel', () => {
    if (cancelled) return; cancelled = true;
    console.log('✓ Menu cancelled'); keyboard.stop();
    try { execSync('kando --close-menu', { timeout: 2000 }); } catch {}
    client.close(); process.exit(0);
  });
  client.on('error', (ev) => console.error('✖ IPC error:', ev.message));

  try { await client.connect({ autoLaunch: true }); console.log('✓ Connected to Kando IPC'); }
  catch (err) { console.error('✖ Failed to connect:', err.message); process.exit(1); }

  currentRoot = sendCurrentPage(client);
  console.log('✓ KAATWS ready');

  const keyboard = new KeyboardCapture();
  keyboard.on('key', (ev) => {
    if (ev.name === 'ESCAPE' && fuzzyMode && filterString) {
      // ESC during fuzzy search: clear filter, exit fuzzy mode, restore menu
      console.log('→ ESC — exiting fuzzy search');
      filterString = ''; fuzzyMode = false; mainSelection = prevMainSelection; lastFuzzyItems = null;
      if (prevSubmenuState) { submenuExpanded = prevSubmenuState; submenuSelection = 0; }
      currentRoot = sendCurrentPage(client); return;
    }
    if (ev.name === 'ESCAPE') { console.log('→ ESC — closing menu'); keyboard.stop(); client.close(); process.exit(0); }

    let menuChanged = false;

    // Tab — move selection to next slot clockwise
    if (ev.name === 'TAB' && !ev.shift) {
      if (submenuExpanded) {
        const children = submenuExpanded.entry.children || [];
        if (children.length > 1) {
          submenuSelection = (submenuSelection + 1) % children.length;
          currentRoot = buildSubmenuPage(submenuExpanded.entry, config, filterString, submenuSelection);
          client.showMenu(currentRoot);
          console.log('→ Slot %d', submenuSelection);
        }
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
        if (filtered.length > 1) {
          mainSelection = (mainSelection + 1) % filtered.length;
          menuChanged = true;
        }
      }

    // Shift+Tab — move selection to previous slot
    } else if (ev.name === 'TAB' && ev.shift) {
      if (submenuExpanded) {
        const children = submenuExpanded.entry.children || [];
        if (children.length > 1) {
          submenuSelection = ((submenuSelection - 1) + children.length) % children.length;
          currentRoot = buildSubmenuPage(submenuExpanded.entry, config, filterString, submenuSelection);
          client.showMenu(currentRoot);
          console.log('→ Slot %d', submenuSelection);
        }
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
        if (filtered.length > 1) {
          mainSelection = ((mainSelection - 1) + filtered.length) % filtered.length;
          menuChanged = true;
        }
      }

    } else if (ev.name === 'h' && ev.ctrl) {
      if (submenuExpanded) { submenuExpanded = null; submenuSelection = 0; filterString = ''; mainSelection = 0; menuChanged = true; }
    } else if (ev.name === 'BACKSPACE') {
      if (filterString.length > 0) { filterString = filterString.slice(0, -1); mainSelection = 0; menuChanged = true; }
    } else if (ev.name === 'c') {
      if (!ev.ctrl) { filterString += 'c'; mainSelection = 0; menuChanged = true; }
      else {
      // Ctrl+C — close the selected window and regenerate menu
      let target = null;
      if (submenuExpanded) {
        target = (submenuExpanded.entry.children || [])[submenuSelection];
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
        target = filtered[mainSelection];
      }
      if (target && target.data?.action === 'focus' && target.data?.address) {
        try {
          execSync("hyprctl dispatch 'hl.dsp.window.close({ window = \"address:" + target.data.address + "\" })'", { timeout: 3000 });
          console.log('→ Closed %s', target.name);
        } catch (err) { console.error('✖ Close failed:', err.message); }
        // Regenerate the menu (same selection index)
        if (submenuExpanded) {
          submenuExpanded.entry.children = (submenuExpanded.entry.children || []).filter(
            c => c.data?.address !== target.data?.address
          );
          currentRoot = buildSubmenuPage(submenuExpanded.entry, config, filterString, Math.min(submenuSelection, (submenuExpanded.entry.children?.length || 1) - 1));
          client.showMenu(currentRoot);
        } else {
          // Remove the closed item from the data and regenerate
          const closedAddr = target.data.address;
          focusedFirstEntries = focusedFirstEntries.filter(e => e.data?.address !== closedAddr);
          mainSelection = Math.min(mainSelection, focusedFirstEntries.length - 1);
          if (focusedFirstEntries.length > 0) {
            currentRoot = sendCurrentPage(client);
          } else {
            currentRoot = sendCurrentPage(client);
          }
        }
      }
      }
    } else if (ev.character && /^[1-6]$/.test(ev.character)) {
      // 1..6 — select item at position (ALT isn't detected because ALT events
      // don't reach the keyd virtual keyboard). Must come BEFORE letter key filter.
      const pos = parseInt(ev.character) - 1;
      if (submenuExpanded) {
        const children = submenuExpanded.entry.children || [];
        const target = children[pos];
        if (target) {
          if (target.type === 'submenu') {
            console.log('→ Alt+%d — expanding nested %s', pos + 1, target.name);
            const oc = target.data?.class || submenuExpanded?.overflowClass || '';
            const od = (submenuExpanded?.overflowDepth || 0) + 1;
            submenuExpanded = { entry: target, parentRoot: currentRoot, overflowClass: oc, overflowDepth: od };
            submenuSelection = 0;
            currentRoot = buildSubmenuPage(target, config, filterString, 0);
            client.showMenu(currentRoot);
          } else {
            console.log('→ Alt+%d — focusing %s', pos + 1, target.name);
            executeItem(target, client, config); return;
          }
        }
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
        const target = filtered[pos];
        if (target) {
          if (target.type === 'submenu') {
            console.log('→ Alt+%d — expanding %s', pos + 1, target.name);
            submenuExpanded = { entry: target, parentRoot: currentRoot, overflowClass: target.data?.class || target.name, overflowDepth: 0 };
            submenuSelection = 0;
            currentRoot = buildSubmenuPage(target, config, filterString, 0);
            client.showMenu(currentRoot);
          } else {
            console.log('→ Alt+%d — executing %s', pos + 1, target.name);
            executeItem(target, client, config); return;
          }
        }
      }
      return;
    } else if (ev.character && /^[a-zA-Z0-9 ]$/.test(ev.character)) {
      if (config.fuzzySearch && !fuzzyMode && filterString.length === 0) {
        fuzzyMode = true;
        prevFilterString = filterString;
        prevMainSelection = mainSelection;
        prevSubmenuState = submenuExpanded ? { entry: submenuExpanded.entry, overflowClass: submenuExpanded.overflowClass, overflowDepth: submenuExpanded.overflowDepth } : null;
      }
      filterString += ev.character.toLowerCase(); mainSelection = 0; menuChanged = true;

    } else if (ev.name === 'ENTER' && ev.ctrl) {
      // Ctrl+Enter — spawn new instance and regenerate menu
      let ctrlTarget = null;
      if (submenuExpanded) {
        ctrlTarget = submenuExpanded.entry;
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
        ctrlTarget = filtered[mainSelection];
      }
      if (ctrlTarget) {
        const cls = ctrlTarget.data?.class || ctrlTarget.name;
        const cmd = getLaunchCommand(cls);
        console.log('→ Ctrl+Enter — spawning %s (%s)', ctrlTarget.name, cmd);
        exec('nohup ' + cmd + ' > /dev/null 2>&1 &', { detached: true });
        // Wait for the new window to appear, then refresh data and regenerate
        setTimeout(() => {
          try {
            const newResult = collectWindows(config.hiddenWindows);
            const newEntries = collectAllEntries(config, newResult.appGroups);
            // Rebuild focusedFirstEntries with new data
            let newFocused = newEntries;
            if (focusedClass) {
              const lc = focusedClass.toLowerCase();
              const idx = newEntries.findIndex(e => e.name.toLowerCase() === lc);
              if (idx > 0) {
                newFocused = [newEntries[idx], ...newEntries.slice(0, idx), ...newEntries.slice(idx + 1)];
              }
            }
            focusedFirstEntries = newFocused;
            allEntries = newEntries;
          } catch {}
          // Regenerate the menu (with refreshed data)
          if (submenuExpanded) {
            let entry = allEntries.find(e =>
              e.data?.class && e.data.class.toLowerCase() ===
                (submenuExpanded.overflowClass || '').toLowerCase()
            );
            // Walk down through overflow add.svg items to reach current depth
            if (entry && submenuExpanded.overflowDepth > 0) {
              for (let d = 0; d < submenuExpanded.overflowDepth; d++) {
                const addSvg = (entry.children || []).find(c => c.type === 'submenu' && c.icon === 'add.svg');
                if (addSvg) entry = addSvg;
                else break;
              }
            }
            if (entry) {
              submenuExpanded.entry = entry;
              currentRoot = buildSubmenuPage(entry, config, filterString, submenuSelection);
              client.showMenu(currentRoot);
            }
          } else {
            currentRoot = sendCurrentPage(client);
          }
        }, 1000);
      }
    } else if (ev.name === 'ENTER' && !ev.ctrl) {
      if (submenuExpanded) {
        const children = submenuExpanded.entry.children || [];
        const target = children[submenuSelection];
        if (target) {
          if (target.type === 'submenu') {
            // Expand nested submenu (e.g. add.svg overflow)
            console.log('→ Enter — expanding nested %s', target.name);
            const overflowClass = target.data?.class || submenuExpanded?.overflowClass || '';
            const overflowDepth = (submenuExpanded?.overflowDepth || 0) + 1;
            submenuExpanded = { entry: target, parentRoot: currentRoot, overflowClass, overflowDepth };
            submenuSelection = 0;
            currentRoot = buildSubmenuPage(target, config, filterString, 0);
            client.showMenu(currentRoot);
          } else {
            console.log('→ Enter — focusing %s', target.name); executeItem(target, client, config); return;
          }
        }
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
        if (filtered.length > 0) {
          const entry = filtered[mainSelection] || filtered[0];
          if (entry.type === 'submenu') {
            console.log('→ Enter — expanding %s', entry.name);
            const oc = entry.data?.class || entry.name;
            submenuExpanded = { entry, parentRoot: currentRoot, overflowClass: oc, overflowDepth: 0 };
            submenuSelection = 0;
            currentRoot = buildSubmenuPage(entry, config, filterString, 0);
            client.showMenu(currentRoot);
          } else { console.log('→ Enter — executing %s', entry.name); executeItem(entry, client, config); return; }
        }
      }
      return;
    }

    if (menuChanged) {
      if (submenuExpanded) {
        if (fuzzyMode && filterString) {
          const useFuzzy = runFuzzySearch(filterString);
          lastFuzzyItems = useFuzzy;
          if (useFuzzy) {
            console.log('  Submenu fuzzy debug: %d raw for "%s":', useFuzzy.length, filterString);
            useFuzzy.slice(0, 10).forEach(f => console.log('    text="%s" name="%s"', f.text.substring(0, 50), (f.entry?.name || '').substring(0, 40)));
          }
          const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, useFuzzy);
          const rootName = filterString;
          const count = filtered.length;
          console.log('  Fuzzy in submenu: %d item(s) for "%s"', count, filterString);
          if (count === 0) {
            client.showMenu({ type: 'simple-button', name: rootName, icon: 'gps_fixed', iconTheme: 'material-symbols-rounded', children: undefined });
            return;
          }
          const root = buildPaginatedRootWithName(filtered, config, mainSelection, rootName, config.maxItems);
          client.showMenu(root); return;
        }
        currentRoot = buildSubmenuPage(submenuExpanded.entry, config, filterString, submenuSelection);
        client.showMenu(currentRoot); return;
      }
      // Compute fuzzy results here (before sendCurrentPage) for auto-select
      let fuzzyForAuto = null;
      if (fuzzyMode && filterString && config.fuzzySearch) {
        fuzzyForAuto = runFuzzySearch(filterString);
        lastFuzzyItems = fuzzyForAuto;
      }
      const matches = getFiltered(focusedFirstEntries, filterString, fuzzyMode, fuzzyForAuto);
      if (matches.length === 1 && filterString.length > 0) {
        const entry = matches[0];
        if (entry.type === 'submenu') {
          console.log('→ Auto-select: expanding %s (%d windows)', entry.name, entry.children?.length || 0);
          submenuExpanded = { entry, parentRoot: currentRoot, overflowClass: entry.data?.class || entry.name, overflowDepth: 0 }; submenuSelection = 0;
          currentRoot = buildSubmenuPage(entry, config, filterString, 0);
          client.showMenu(currentRoot); return;
        }
        console.log('→ Auto-select: executing %s', entry.name); keyboard.stop();
        executeItem(entry, client, config); return;
      }
      currentRoot = sendCurrentPage(client);
      submenuExpanded = null;
    }
  });

  keyboard.on('error', (ev) => console.error('✖ Keyboard error:', ev.message));
  if (!keyboard.start()) { console.error('✖ Failed to start keyboard capture'); }
  else { console.log('✓ Keyboard capture active'); }

  process.on('SIGINT', () => { keyboard.stop(); client.close(); process.exit(0); });
}
main().catch((err) => { console.error('Unhandled error:', err); process.exit(1); });
