#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
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
function buildOverflowPage(windows, config, truncationLimit, icon) {
  const page = windows.slice(0, 6);
  const remaining = windows.length - page.length;
  const children = page.map((win, i) => ({
    type: 'simple-button',
    name: truncate(win.title, truncationLimit),
    icon, iconTheme: config.iconTheme,
    angle: i * 60,
    data: { address: win.address, class: win.class, action: 'focus' },
  }));
  if (remaining > 0) {
    const nextOverflow = buildOverflowPage(windows.slice(6), config, truncationLimit, icon);
    children.push({
      type: 'submenu',
      name: '+' + remaining,
      icon: 'add.svg', iconTheme: config.iconTheme,
      angle: children.length * 60,
      data: { action: 'show-overflow' },
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
        const overflowChildren = buildOverflowPage(group.windows.slice(5), config, truncationLimit, icon);
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

function getFiltered(allEntries, filterString) {
  if (!filterString) return allEntries;
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

function buildPaginatedRoot(allEntries, currentPage, config, filterString, mainSelection) {
  const { maxItems } = config;
  let displayEntries = getFiltered(allEntries, filterString);

  if (displayEntries.length === 0) {
    return { type: 'simple-button', name: '>', icon: 'gps_fixed', iconTheme: 'material-symbols-rounded', children: undefined };
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
      type: 'simple-button', name: rootName, icon: 'gps_fixed', iconTheme: 'material-symbols-rounded',
      children: assignAngles(pageItems, maxItems),
    };
  }

  return {
    type: 'simple-button', name: rootName, icon: 'gps_fixed', iconTheme: 'material-symbols-rounded',
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
    type: 'simple-button', name: center, icon: 'left_arrow.svg', iconTheme: config.iconTheme,
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

  const allEntries = collectAllEntries(config, appGroups);
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

  function sendCurrentPage(client) {
    const root = buildPaginatedRoot(focusedFirstEntries, 0, config, filterString, mainSelection);
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
        const filtered = getFiltered(focusedFirstEntries, filterString);
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
        const filtered = getFiltered(focusedFirstEntries, filterString);
        if (filtered.length > 1) {
          mainSelection = ((mainSelection - 1) + filtered.length) % filtered.length;
          menuChanged = true;
        }
      }

    } else if (ev.name === 'h' && ev.ctrl) {
      if (submenuExpanded) { submenuExpanded = null; submenuSelection = 0; filterString = ''; mainSelection = 0; menuChanged = true; }
    } else if (ev.name === 'BACKSPACE') {
      if (filterString.length > 0) { filterString = filterString.slice(0, -1); mainSelection = 0; menuChanged = true; }
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
            submenuExpanded = { entry: target, parentRoot: currentRoot };
            submenuSelection = 0;
            currentRoot = buildSubmenuPage(target, config, filterString, 0);
            client.showMenu(currentRoot);
          } else {
            console.log('→ Alt+%d — focusing %s', pos + 1, target.name);
            executeItem(target, client, config); return;
          }
        }
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString);
        const target = filtered[pos];
        if (target) {
          if (target.type === 'submenu') {
            console.log('→ Alt+%d — expanding %s', pos + 1, target.name);
            submenuExpanded = { entry: target, parentRoot: currentRoot };
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
      filterString += ev.character.toLowerCase(); mainSelection = 0; menuChanged = true;

    } else if (ev.name === 'ENTER' && !ev.ctrl) {
      if (submenuExpanded) {
        const children = submenuExpanded.entry.children || [];
        const target = children[submenuSelection];
        if (target) {
          if (target.type === 'submenu') {
            // Expand nested submenu (e.g. add.svg overflow)
            console.log('→ Enter — expanding nested %s', target.name);
            submenuExpanded = { entry: target, parentRoot: currentRoot };
            submenuSelection = 0;
            currentRoot = buildSubmenuPage(target, config, filterString, 0);
            client.showMenu(currentRoot);
          } else {
            console.log('→ Enter — focusing %s', target.name); executeItem(target, client, config); return;
          }
        }
      } else {
        const filtered = getFiltered(focusedFirstEntries, filterString);
        if (filtered.length > 0) {
          const entry = filtered[mainSelection] || filtered[0];
          if (entry.type === 'submenu') {
            console.log('→ Enter — expanding %s', entry.name);
            submenuExpanded = { entry, parentRoot: currentRoot }; submenuSelection = 0;
            currentRoot = buildSubmenuPage(entry, config, filterString, 0);
            client.showMenu(currentRoot);
          } else { console.log('→ Enter — executing %s', entry.name); executeItem(entry, client, config); return; }
        }
      }
      return;
    }

    if (menuChanged) {
      if (submenuExpanded) {
        currentRoot = buildSubmenuPage(submenuExpanded.entry, config, filterString, submenuSelection);
        client.showMenu(currentRoot); return;
      }
      const matches = getFiltered(focusedFirstEntries, filterString);
      if (matches.length === 1 && filterString.length > 0) {
        const entry = matches[0];
        if (entry.type === 'submenu') {
          console.log('→ Auto-select: expanding %s (%d windows)', entry.name, entry.children?.length || 0);
          submenuExpanded = { entry, parentRoot: currentRoot }; submenuSelection = 0;
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
