#!/usr/bin/env node
'use strict';
const { exec, execSync } = require('child_process');
const { loadConfig } = require('./lib/config');
const { collectWindows } = require('./lib/window-collector');
const { KandoIPCClient } = require('./lib/kando-ipc');
const { KeyboardCapture } = require('./lib/key-capture');
const {
  collectAllEntries,
  buildPaginatedRoot,
  buildPaginatedRootWithName,
  buildSubmenuPage,
  getFiltered,
  truncate,
} = require('./lib/menu-builder');
const { getLaunchCommand, executeItem, lookupItemByPath } = require('./lib/actions');
const { buildFuzzyList, runFuzzySearch } = require('./lib/fuzzy-search');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reorder entries so the focused app appears first.
 * @param {object[]} entries
 * @param {string}   focusedClass
 * @returns {object[]}
 */
function reorderFocusedFirst(entries, focusedClass) {
  if (!focusedClass) return entries;
  const lowerClass = focusedClass.toLowerCase();
  const idx = entries.findIndex(e => e.name.toLowerCase() === lowerClass);
  if (idx > 0) {
    return [entries[idx], ...entries.slice(0, idx), ...entries.slice(idx + 1)];
  }
  return entries;
}

/**
 * Refresh window data by re-collecting windows and rebuilding entries.
 * Returns { appGroups, newEntries, newFocused }.
 */
function refreshWindowData(config, focusedClass) {
  const newResult = collectWindows(config.hiddenWindows);
  const newEntries = collectAllEntries(config, newResult.appGroups);
  const newFocused = reorderFocusedFirst(newEntries, focusedClass);
  return { appGroups: newResult.appGroups, newEntries, newFocused };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { config, errors, warnings } = loadConfig();
  for (const w of warnings) console.warn('⚠', w);
  for (const e of errors) { console.error('✖', e); }
  if (errors.length > 0) { console.error('Aborting.'); process.exit(1); }

  console.log('✓ Configuration loaded');
  console.log('  defaultApps:', config.defaultApps.length, ' maxItems:', config.maxItems);

  // --- Collect running windows ---
  let appGroups = [];
  try {
    const result = collectWindows(config.hiddenWindows);
    appGroups = result.appGroups;
    console.log('✓ Collected %d windows across %d apps', result.totalWindows, appGroups.length);
  } catch (err) { console.error('✖ Failed:', err.message); process.exit(1); }

  let allEntries = collectAllEntries(config, appGroups);
  console.log('✓ All entries: %d', allEntries.length);

  // --- Detect focused window ---
  let focusedClass = null;
  let focusedFirstEntries = allEntries;
  try {
    const stdout = execSync('hyprctl activewindow -j', { timeout: 3000, encoding: 'utf-8' });
    const data = JSON.parse(stdout);
    if (data && data.class) {
      focusedClass = data.class;
      focusedFirstEntries = reorderFocusedFirst(allEntries, focusedClass);
    }
  } catch {}
  console.log('✓ Focused:', focusedClass || '(unknown)');

  // --- State ---
  let currentRoot = null;
  let filterString = '';
  let mainSelection = 0;
  /** @type {{ entry: object, parentRoot: object, overflowClass?: string, overflowDepth?: number }|null} */
  let submenuExpanded = null;
  let submenuSelection = 0;
  let fuzzyMode = false;
  let prevFilterString = '';
  let prevMainSelection = 0;
  let prevSubmenuState = null;
  let lastFuzzyItems = null;

  // --- IPC helper: send current page ---

  function sendCurrentPage(client) {
    let entries = focusedFirstEntries;
    let useFuzzy = null;
    if (config.fuzzySearch && fuzzyMode && filterString) {
      useFuzzy = runFuzzySearch(filterString, config, focusedFirstEntries, submenuExpanded);
      lastFuzzyItems = useFuzzy;
      if (useFuzzy) {
        console.log('  Fuzzy debug: %d raw results for "%s":', useFuzzy.length, filterString);
        useFuzzy.slice(0, 10).forEach(f => {
          const type = f.parent ? 'window' : 'app';
          console.log('    [%s] text="%s" name="%s"', type, f.text.substring(0, 60),
            (f.entry?.name || '').substring(0, 40));
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
        filtered.slice(0, 10).forEach(e =>
          console.log('    entry: "%s" type=%s class=%s', e.name, e.type || '?', e.data?.class || '?'));
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

  // --- Kando IPC connection ---

  const client = new KandoIPCClient();
  let menuOpened = false;
  client.on('open', () => { if (menuOpened) return; menuOpened = true; console.log('✓ Kando menu opened'); });

  let lastSelectKey = '';
  client.on('select', (ev) => {
    const key = ev.target + ':' + ev.path.join(',');
    if (key === lastSelectKey) return;
    lastSelectKey = key;

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

  // --- Keyboard capture ---

  const keyboard = new KeyboardCapture();
  keyboard.on('key', (ev) => {
    // --- ESCAPE ---
    if (ev.name === 'ESCAPE' && fuzzyMode && filterString) {
      console.log('→ ESC — exiting fuzzy search');
      filterString = ''; fuzzyMode = false; mainSelection = prevMainSelection; lastFuzzyItems = null;
      if (prevSubmenuState) {
        submenuExpanded = prevSubmenuState; submenuSelection = 0;
      }
      currentRoot = sendCurrentPage(client); return;
    }
    if (ev.name === 'ESCAPE') {
      console.log('→ ESC — closing menu'); keyboard.stop(); client.close(); process.exit(0);
    }

    let menuChanged = false;

    // --- TAB / Shift+TAB — cycle selection ---
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

    // --- Ctrl+h — back from submenu ---
    } else if (ev.name === 'h' && ev.ctrl) {
      if (submenuExpanded) { submenuExpanded = null; submenuSelection = 0; filterString = ''; mainSelection = 0; menuChanged = true; }

    // --- BACKSPACE — delete filter char ---
    } else if (ev.name === 'BACKSPACE') {
      if (filterString.length > 0) { filterString = filterString.slice(0, -1); mainSelection = 0; menuChanged = true; }

    // --- F1-F6 — quick select / expand ---
    } else if (/^F[1-6]$/.test(ev.name)) {
      const fIdx = parseInt(ev.name[1]) - 1;
      let fItem = null;
      if (submenuExpanded) {
        fItem = (submenuExpanded.entry.children || [])[fIdx];
      } else {
        const fFiltered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
        fItem = fFiltered[fIdx];
      }
      if (fItem) {
        if (fItem.type === 'submenu') {
          console.log('→ F%d — expanding %s', fIdx + 1, fItem.name);
          submenuExpanded = {
            entry: fItem, parentRoot: currentRoot,
            overflowClass: fItem.data?.class || fItem.name, overflowDepth: 0,
          };
          submenuSelection = 0;
          currentRoot = buildSubmenuPage(fItem, config, filterString, 0);
          client.showMenu(currentRoot);
        } else {
          console.log('→ F%d — executing %s', fIdx + 1, fItem.name);
          executeItem(fItem, client, config); return;
        }
      }

    // --- c / Ctrl+C — type 'c' or close selected window ---
    } else if (ev.name === 'c') {
      if (!ev.ctrl) { filterString += 'c'; mainSelection = 0; menuChanged = true; }
      else {
        handleCtrlC(client);
      }

    // --- a-z, 0-9, space — type filter character ---
    } else if (ev.character && /^[a-zA-Z0-9 ]$/.test(ev.character)) {
      if (config.fuzzySearch && !fuzzyMode && filterString.length === 0) {
        fuzzyMode = true;
        prevFilterString = filterString;
        prevMainSelection = mainSelection;
        prevSubmenuState = submenuExpanded
          ? { entry: submenuExpanded.entry, overflowClass: submenuExpanded.overflowClass,
              overflowDepth: submenuExpanded.overflowDepth }
          : null;
      }
      filterString += ev.character.toLowerCase(); mainSelection = 0; menuChanged = true;

    // --- Ctrl+Enter — spawn new instance ---
    } else if (ev.name === 'ENTER' && ev.ctrl) {
      handleCtrlEnter(client);

    // --- Enter — execute / expand ---
    } else if (ev.name === 'ENTER' && !ev.ctrl) {
      if (submenuExpanded) {
        const children = submenuExpanded.entry.children || [];
        const target = children[submenuSelection];
        if (target) {
          if (target.type === 'submenu') {
            console.log('→ Enter — expanding nested %s', target.name);
            const overflowClass = target.data?.class || submenuExpanded?.overflowClass || '';
            const overflowDepth = (submenuExpanded?.overflowDepth || 0) + 1;
            submenuExpanded = { entry: target, parentRoot: currentRoot, overflowClass, overflowDepth };
            submenuSelection = 0;
            currentRoot = buildSubmenuPage(target, config, filterString, 0);
            client.showMenu(currentRoot);
          } else {
            console.log('→ Enter — focusing %s', target.name);
            executeItem(target, client, config); return;
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
          } else {
            console.log('→ Enter — executing %s', entry.name);
            executeItem(entry, client, config); return;
          }
        }
      }
      return;
    }

    // --- Rebuild menu if state changed ---
    if (menuChanged) {
      if (submenuExpanded) {
        if (fuzzyMode && filterString) {
          handleFuzzySubmenu(client);
          return;
        }
        currentRoot = buildSubmenuPage(submenuExpanded.entry, config, filterString, submenuSelection);
        client.showMenu(currentRoot); return;
      }
      // Auto-select: if exactly one match remains, execute or expand it
      const fuzzyForAuto = fuzzyMode && filterString && config.fuzzySearch
        ? runFuzzySearch(filterString, config, focusedFirstEntries, submenuExpanded)
        : null;
      if (fuzzyForAuto) lastFuzzyItems = fuzzyForAuto;
      const matches = getFiltered(focusedFirstEntries, filterString, fuzzyMode, fuzzyForAuto);
      if (matches.length === 1 && filterString.length > 0) {
        const entry = matches[0];
        if (entry.type === 'submenu') {
          console.log('→ Auto-select: expanding %s (%d windows)',
            entry.name, entry.children?.length || 0);
          submenuExpanded = {
            entry, parentRoot: currentRoot,
            overflowClass: entry.data?.class || entry.name, overflowDepth: 0,
          };
          submenuSelection = 0;
          currentRoot = buildSubmenuPage(entry, config, filterString, 0);
          client.showMenu(currentRoot); return;
        }
        console.log('→ Auto-select: executing %s', entry.name);
        keyboard.stop();
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

  // -----------------------------------------------------------------------
  // Inline helper handlers (extracted for clarity but keep state access)
  // -----------------------------------------------------------------------

  /**
   * Ctrl+C — close the selected window and regenerate menu.
   */
  function handleCtrlC(client) {
    let target = null;
    if (submenuExpanded) {
      target = (submenuExpanded.entry.children || [])[submenuSelection];
    } else {
      const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, lastFuzzyItems);
      target = filtered[mainSelection];
    }
    if (target && target.data?.action === 'focus' && target.data?.address) {
      const closedAddr = target.data.address;
      try {
        execSync("hyprctl dispatch 'hl.dsp.window.close({ window = \"address:" + closedAddr + "\" })'",
          { timeout: 3000 });
        console.log('→ Closed %s', target.name);
      } catch (err) { console.error('✖ Close failed:', err.message); return; }
      pollUntilGone(closedAddr, client);
    }
  }

  /**
   * Poll until a closed window is gone, then refresh the menu.
   */
  function pollUntilGone(closedAddr, client) {
    let attempts = 0;
    const poll = () => {
      attempts++;
      try {
        const clients = JSON.parse(
          execSync('hyprctl clients -j', { timeout: 3000, encoding: 'utf-8' })
        );
        const stillExists = clients.some(c => c.address === closedAddr);
        if (!stillExists) {
          doRefreshAfterClose(client, closedAddr);
          return;
        }
      } catch {}
      if (attempts < 20) setTimeout(poll, 200);
      else fallbackRefreshAfterClose(client, closedAddr);
    };
    setTimeout(poll, 300);
  }

  function doRefreshAfterClose(client, closedAddr) {
    try {
      const { appGroups: newGroups, newEntries, newFocused } = refreshWindowData(config, focusedClass);
      appGroups = newGroups; // keep appGroups in sync
      focusedFirstEntries = newFocused;
      allEntries = newEntries;
    } catch {}

    // Rebuild submenu or main menu
    let targetClass = submenuExpanded?.overflowClass || '';
    let entry = allEntries.find(e =>
      e.data?.class && e.data.class.toLowerCase() === targetClass.toLowerCase()
    ) || allEntries.find(e => e.name.toLowerCase() === targetClass.toLowerCase());
    if (entry && submenuExpanded?.overflowDepth > 0) {
      for (let d = 0; d < submenuExpanded.overflowDepth; d++) {
        const addSvg = (entry.children || []).find(c => c.type === 'submenu' && c.icon === 'add.svg');
        if (addSvg) entry = addSvg; else break;
      }
    }
    if (entry && (!entry.children || entry.children.length === 0)) {
      submenuExpanded = null; submenuSelection = 0;
      currentRoot = sendCurrentPage(client);
    } else if (entry && entry.children) {
      submenuExpanded.entry = entry;
      submenuSelection = Math.min(submenuSelection, entry.children.length - 1);
      currentRoot = buildSubmenuPage(entry, config, filterString, submenuSelection);
      client.showMenu(currentRoot);
    } else {
      submenuExpanded = null; submenuSelection = 0;
      currentRoot = sendCurrentPage(client);
    }
  }

  function fallbackRefreshAfterClose(client, closedAddr) {
    if (submenuExpanded) {
      const remaining = (submenuExpanded.entry.children || [])
        .filter(c => c.data?.address !== closedAddr);
      if (remaining.length === 0) {
        submenuExpanded = null; submenuSelection = 0;
        currentRoot = sendCurrentPage(client);
      } else {
        submenuExpanded.entry.children = remaining;
        submenuSelection = Math.min(submenuSelection, remaining.length - 1);
        currentRoot = buildSubmenuPage(submenuExpanded.entry, config, filterString, submenuSelection);
        client.showMenu(currentRoot);
      }
    }
  }

  /**
   * Ctrl+Enter — spawn new instance of selected app and refresh menu.
   */
  function handleCtrlEnter(client) {
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
      pollAfterSpawn(client);
    }
  }

  /**
   * Poll after spawning: wait for Kando to lose focus, refocus Kando, then refresh.
   */
  function pollAfterSpawn(client) {
    let kandoAddr = null;
    try {
      const aw = JSON.parse(
        execSync('hyprctl activewindow -j', { timeout: 2000, encoding: 'utf-8' })
      );
      kandoAddr = aw.address || null;
    } catch {}
    if (kandoAddr) {
      let attempts = 0;
      const poll = () => {
        attempts++;
        try {
          const cur = JSON.parse(
            execSync('hyprctl activewindow -j', { timeout: 2000, encoding: 'utf-8' })
          );
          if (cur.address && cur.address !== kandoAddr) {
            execSync("hyprctl dispatch 'hl.dsp.focus({ last = true })'", { timeout: 2000 });
            doSpawnRefresh(client);
            return;
          }
        } catch {}
        if (attempts < 30) setTimeout(poll, 300);
        else doSpawnRefresh(client);
      };
      setTimeout(poll, 500);
    } else {
      setTimeout(() => doSpawnRefresh(client), 1500);
    }
  }

  function doSpawnRefresh(client) {
    try {
      const { newEntries, newFocused } = refreshWindowData(config, focusedClass);
      focusedFirstEntries = newFocused;
      allEntries = newEntries;
    } catch {}
    if (submenuExpanded) {
      let entry = allEntries.find(e =>
        e.data?.class && e.data.class.toLowerCase() ===
          (submenuExpanded.overflowClass || '').toLowerCase()
      );
      if (entry && submenuExpanded.overflowDepth > 0) {
        for (let d = 0; d < submenuExpanded.overflowDepth; d++) {
          const addSvg = (entry.children || []).find(c => c.type === 'submenu' && c.icon === 'add.svg');
          if (addSvg) entry = addSvg; else break;
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
  }

  /**
   * Handle fuzzy search inside a submenu.
   */
  function handleFuzzySubmenu(client) {
    const useFuzzy = runFuzzySearch(filterString, config, focusedFirstEntries, submenuExpanded);
    lastFuzzyItems = useFuzzy;
    if (useFuzzy) {
      console.log('  Submenu fuzzy debug: %d raw for "%s":', useFuzzy.length, filterString);
      useFuzzy.slice(0, 10).forEach(f =>
        console.log('    text="%s" name="%s"', f.text.substring(0, 50),
          (f.entry?.name || '').substring(0, 40)));
    }
    const filtered = getFiltered(focusedFirstEntries, filterString, fuzzyMode, useFuzzy);
    const rootName = filterString;
    const count = filtered.length;
    console.log('  Fuzzy in submenu: %d item(s) for "%s"', count, filterString);
    if (count === 0) {
      client.showMenu({
        type: 'simple-button', name: rootName, icon: 'gps_fixed',
        iconTheme: 'material-symbols-rounded', children: undefined,
      });
      return;
    }
    const root = buildPaginatedRootWithName(filtered, config, mainSelection, rootName, config.maxItems);
    client.showMenu(root);
  }
}

main().catch((err) => { console.error('Unhandled error:', err); process.exit(1); });
