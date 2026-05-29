'use strict';

const fs = require('fs');
const { exec, execSync } = require('child_process');
const { truncate } = require('./menu-builder');

// ---------------------------------------------------------------------------
// Desktop file lookup
// ---------------------------------------------------------------------------

const DESKTOP_DIRS = [
  '/run/current-system/sw/share/applications',
  process.env.HOME + '/.local/share/applications',
  '/usr/share/applications',
  '/usr/local/share/applications',
];

/**
 * Look up the launch command for an application by scanning .desktop files.
 *
 * @param {string} appClass - Window class (e.g. "firefox").
 * @returns {string} The Exec command from the matching .desktop file,
 *                   or the appClass as fallback.
 */
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
// Item lookup by path
// ---------------------------------------------------------------------------

/**
 * Navigate into a menu tree following a path of indices.
 *
 * @param {object}  root - Root menu node.
 * @param {number[]} path - Array of child indices.
 * @returns {object|null} The found item, or null.
 */
function lookupItemByPath(root, path) {
  let item = root;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (!item.children || idx >= item.children.length) return null;
    item = item.children[idx];
  }
  return item;
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

/**
 * Execute a menu item's action (focus, launch, or show-overflow).
 *
 * @param {object} item   - The menu item node.
 * @param {object} client - KandoIPCClient instance.
 * @param {object} config
 * @returns {string|undefined} 'ignore' for show-overflow, undefined otherwise.
 */
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

module.exports = {
  getLaunchCommand,
  lookupItemByPath,
  executeItem,
};
