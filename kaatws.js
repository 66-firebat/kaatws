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

function collectAllEntries(config, appGroups) {
  const { truncationLimit, defaultApps, submenuThreshold } = config;
  const entries = [];
  for (const group of appGroups) {
    const icon = resolveIcon(group.class, config);
    const truncatedName = truncate(group.class, truncationLimit);
    if (group.count >= submenuThreshold) {
      const children = group.windows.map((win) => ({
        type: 'simple-button',
        name: truncate(win.title, truncationLimit),
        icon, iconTheme: config.iconTheme,
        data: { address: win.address, class: win.class, action: 'focus' },
      }));
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

function assignAngles(items, maxItems) {
  const step = 360 / maxItems;
  return items.map((item, i) => ({ ...item, angle: i * step }));
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
    case 'next-page':
    case 'previous-page':
      return 'navigate';
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
      return { ...entry, icon: 'radio_button_checked', iconTheme: 'material-symbols-rounded' };
    }
    return entry;
  });

  if (marked.length <= maxItems) {
    return {
      type: 'simple-button', name: rootName, icon: 'gps_fixed', iconTheme: 'material-symbols-rounded',
      children: assignAngles([...marked], maxItems),
    };
  }

  const perPage = maxItems - 1;
  const totalPages = Math.ceil(marked.length / perPage);
  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;
  const start = currentPage * perPage;
  let pageItems = marked.slice(start, start + perPage);

  if (hasPrev) {
    pageItems.unshift({
      type: 'simple-button', name: '← Back', icon: 'arrow_back',
      iconTheme: 'material-symbols-rounded', data: { action: 'previous-page' },
    });
  }
  if (hasNext) {
    pageItems.push({
      type: 'simple-button', name: '→ Next', icon: 'arrow_forward',
      iconTheme: 'material-symbols-rounded', data: { action: 'next-page' },
    });
  }

  return {
    type: 'simple-button', name: rootName, icon: 'gps_fixed', iconTheme: 'material-symbols-rounded',
    children: assignAngles(pageItems, maxItems),
  };
}

function buildSubmenuPage(submenuEntry, config, filterString, selection) {
  const children = (submenuEntry.children || []).map((child, i) => {
    const c = { ...child };
    if (i === selection) { c.icon = 'radio_button_checked'; c.iconTheme = 'material-symbols-rounded'; }
    return c;
  });
  const maxItems = config.maxItems;
  const selName = children[selection]?.name || '';
  const center = truncate(selName, 35) + '  (' + (selection + 1) + '/' + children.length + ')';
  return {
    type: 'simple-button', name: center, icon: 'gps_fixed', iconTheme: 'material-symbols-rounded',
    iconTheme: config.iconTheme, children: assignAngles(children, maxItems),
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

  let currentPage = 0, currentRoot = null, filterString = '';
  let mainSelection = 0, submenuExpanded = null, submenuSelection = 0;

  function sendCurrentPage(client) {
    const root = buildPaginatedRoot(focusedFirstEntries, currentPage, config, filterString, mainSelection);
    const count = root.children ? root.children.length : 0;
    const info = filterString ? ' filter="' + filterString + '"' : '';
    console.log('  Page %d: %d item(s)%s', currentPage + 1, count, info);
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
    if (ev.target !== 'item') return;
    const item = lookupItemByPath(currentRoot, ev.path);
    if (!item) { console.error('✖ No item at path %j', ev.path); return; }
    const result = executeItem(item, client, config);
    if (result === 'navigate') {
      currentPage += item.data.action === 'next-page' ? 1 : -1;
      currentRoot = sendCurrentPage(client);
    }
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

    } else if (ev.name === 'l' && ev.ctrl && !submenuExpanded) {
      const display = getFiltered(focusedFirstEntries, filterString);
      const perPage = config.maxItems - 1;
      const totalPages = Math.ceil(display.length / perPage);
      if (currentPage < totalPages - 1) { currentPage++; menuChanged = true; }
    } else if (ev.name === 'h' && ev.ctrl) {
      if (submenuExpanded) { submenuExpanded = null; submenuSelection = 0; filterString = ''; currentPage = 0; menuChanged = true; }
      else if (currentPage > 0) { currentPage--; menuChanged = true; }
    } else if (ev.name === 'BACKSPACE') {
      if (filterString.length > 0) { filterString = filterString.slice(0, -1); currentPage = 0; mainSelection = 0; menuChanged = true; }
    } else if (ev.character && /^[a-zA-Z0-9 ]$/.test(ev.character)) {
      filterString += ev.character.toLowerCase(); currentPage = 0; mainSelection = 0; menuChanged = true;

    } else if (ev.name === 'ENTER' && !ev.ctrl) {
      if (submenuExpanded) {
        const children = submenuExpanded.entry.children || [];
        const target = children[submenuSelection];
        if (target) { console.log('→ Enter — focusing %s', target.name); executeItem(target, client, config); return; }
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
