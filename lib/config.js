'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  defaultApps: [],
  hiddenWindows: [],
  iconTheme: 'fireshark',
  iconThemeDirectory: path.join(process.env.HOME || '/home/fireshark', '.config/kando/icon-themes'),
  maxItems: 8,
  submenuThreshold: 2,
  fuzzySearch: true,
  truncationLimit: 30,
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates a single default-app entry.
 * @param {unknown} entry
 * @param {number} index
 * @returns {string[]} Array of error messages. Empty means valid.
 */
function validateDefaultApp(entry, index) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    errors.push(`defaultApps[${index}]: must be an object with "name" and "command"`);
    return errors;
  }

  if (typeof entry.name !== 'string' || entry.name.trim() === '') {
    errors.push(`defaultApps[${index}]: "name" must be a non-empty string`);
  }

  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    errors.push(`defaultApps[${index}]: "command" must be a non-empty string`);
  }

  return errors;
}

/**
 * Validates a single hidden-window entry.
 * @param {unknown} entry
 * @param {number} index
 * @returns {string[]} Array of error messages. Empty means valid.
 */
function validateHiddenWindow(entry, index) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    errors.push(`hiddenWindows[${index}]: must be an object with "class" and/or "title"`);
    return errors;
  }

  const hasClass = typeof entry.class === 'string' && entry.class.trim() !== '';
  const hasTitle = typeof entry.title === 'string' && entry.title.trim() !== '';

  if (!hasClass && !hasTitle) {
    errors.push(
      `hiddenWindows[${index}]: must have at least one of "class" (string) or "title" (string)`
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads and validates the KAATWS configuration file.
 *
 * @param {string} [configPath]  Absolute path to KAATWS.json.
 *                                Defaults to ~/.config/kaatws/KAATWS.json.
 * @returns {{ config: object, errors: string[], warnings: string[] }}
 */
function loadConfig(configPath) {
  const resolvedPath = configPath || path.join(process.env.HOME, '.config/kaatws/KAATWS.json');
  const errors = [];
  const warnings = [];

  // --- Read file -----------------------------------------------------------
  let raw = {};
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      warnings.push(`Config file not found at ${resolvedPath}. Using defaults.`);
    } else if (err instanceof SyntaxError) {
      errors.push(`Config file ${resolvedPath}: invalid JSON — ${err.message}`);
    } else {
      errors.push(`Failed to read ${resolvedPath}: ${err.message}`);
    }
    // Return defaults early if we couldn't read the file.
    return { config: { ...DEFAULTS }, errors, warnings };
  }

  // --- Build config with defaults -----------------------------------------
  const config = { ...DEFAULTS };

  // defaultApps
  if (Array.isArray(raw.defaultApps)) {
    config.defaultApps = [];
    raw.defaultApps.forEach((entry, i) => {
      const errs = validateDefaultApp(entry, i);
      errors.push(...errs);
      if (errs.length === 0) {
        config.defaultApps.push({
          name: entry.name.trim(),
          command: entry.command.trim(),
        });
      }
    });
  }

  // hiddenWindows
  if (Array.isArray(raw.hiddenWindows)) {
    config.hiddenWindows = [];
    raw.hiddenWindows.forEach((entry, i) => {
      const errs = validateHiddenWindow(entry, i);
      errors.push(...errs);
      if (errs.length === 0) {
        config.hiddenWindows.push({
          class: typeof entry.class === 'string' ? entry.class.trim() : undefined,
          title: typeof entry.title === 'string' ? entry.title.trim() : undefined,
        });
      }
    });
  }

  // iconTheme
  if (typeof raw.iconTheme === 'string' && raw.iconTheme.trim() !== '') {
    config.iconTheme = raw.iconTheme.trim();
  }

  // iconThemeDirectory
  if (typeof raw.iconThemeDirectory === 'string' && raw.iconThemeDirectory.trim() !== '') {
    config.iconThemeDirectory = raw.iconThemeDirectory.trim();
  }

  // maxItems
  if (raw.maxItems !== undefined) {
    const n = Number(raw.maxItems);
    if (Number.isInteger(n) && n >= 1) {
      config.maxItems = n;
    } else {
      errors.push(`"maxItems" must be a positive integer (got ${JSON.stringify(raw.maxItems)})`);
    }
  }

  // submenuThreshold
  if (raw.submenuThreshold !== undefined) {
    const n = Number(raw.submenuThreshold);
    if (Number.isInteger(n) && n >= 1) {
      config.submenuThreshold = n;
    } else {
      errors.push(
        `"submenuThreshold" must be a positive integer (got ${JSON.stringify(raw.submenuThreshold)})`
      );
    }
  }

  // fuzzySearch
  if (raw.fuzzySearch !== undefined) {
    if (typeof raw.fuzzySearch === 'boolean') {
      config.fuzzySearch = raw.fuzzySearch;
    } else {
      errors.push(`"fuzzySearch" must be a boolean (got ${JSON.stringify(raw.fuzzySearch)})`);
    }
  }

  // truncationLimit
  if (raw.truncationLimit !== undefined) {
    const n = Number(raw.truncationLimit);
    if (Number.isInteger(n) && n >= 1) {
      config.truncationLimit = n;
    } else {
      errors.push(
        `"truncationLimit" must be a positive integer (got ${JSON.stringify(raw.truncationLimit)})`
      );
    }
  }

  return { config, errors, warnings };
}

module.exports = { loadConfig, DEFAULTS };
