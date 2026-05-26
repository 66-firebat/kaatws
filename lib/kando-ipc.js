'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KANDO_CONFIG_DIR = path.join(process.env.HOME, '.config/kando');
const IPC_INFO_PATH = path.join(KANDO_CONFIG_DIR, 'ipc-info.json');

const POLL_INTERVAL_MS = 200;
const MAX_POLL_ATTEMPTS = 50; // ~10 seconds total

// ---------------------------------------------------------------------------
// Helper: wait for Kando's ipc-info.json to appear
// ---------------------------------------------------------------------------

/**
 * Polls for the ipc-info.json file to appear (in case Kando was just launched).
 *
 * @returns {Promise<{ port: number, apiVersion: number }>}
 */
function waitForIPCInfo() {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const poll = () => {
      attempts++;
      try {
        if (fs.existsSync(IPC_INFO_PATH)) {
          const raw = fs.readFileSync(IPC_INFO_PATH, 'utf-8');
          const info = JSON.parse(raw);

          if (typeof info.port === 'number' && typeof info.apiVersion === 'number') {
            resolve(info);
            return;
          }
        }
      } catch {
        // File may be partially written; try again.
      }

      if (attempts >= MAX_POLL_ATTEMPTS) {
        reject(
          new Error(
            `Timed out waiting for Kando IPC info at ${IPC_INFO_PATH} ` +
              `(tried ${MAX_POLL_ATTEMPTS} times over ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s)`
          )
        );
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();
  });
}

// ---------------------------------------------------------------------------
// KandoIPCClient
// ---------------------------------------------------------------------------

/**
 * @typedef {'select' | 'cancel' | 'hover' | 'error' | 'open'} KandoIPCEvent
 */

/**
 * A client that connects to Kando's IPC WebSocket server to show custom menus
 * and receive selection / cancel / hover events.
 *
 * Emits the following events:
 *   - 'open'     Kando's menu has opened on screen.
 *   - 'select'   { target: string, path: number[] }
 *   - 'cancel'   (no arguments) — user cancelled / closed the menu.
 *   - 'hover'    { target: string, path: number[] }
 *   - 'error'    { message: string }
 */
class KandoIPCClient extends EventEmitter {
  constructor() {
    super();
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {boolean} - Whether we've registered as a persistent observer. */
    this._observed = false;
  }

  /**
   * Connect to the Kando IPC server. If Kando is not running, you can pass
   * `{ autoLaunch: true }` and the method will spawn Kando and wait for it.
   *
   * The method handles stale ipc-info.json files: if the file exists but
   * Kando is not actually listening on the advertised port, it will clean up
   * the stale file and (if autoLaunch is true) relaunch Kando.
   *
   * @param {object} [options]
   * @param {boolean} [options.autoLaunch=false] - Spawn Kando if not running.
   * @returns {Promise<void>}
   */
  async connect(options = {}) {
    const { autoLaunch = false } = options;

    // --- Resolve port & apiVersion ----------------------------------------
    let { port, apiVersion } = await this._resolveIPCInfo(autoLaunch);

    // --- API version check ------------------------------------------------
    if (apiVersion !== 1) {
      throw new Error(
        `Kando IPC API version ${apiVersion} is not supported (expected 1)`
      );
    }

    // --- Proactively verify the port is alive before WebSocket handshake ---
    const portAlive = await this._verifyPortAlive(port);

    if (!portAlive && autoLaunch) {
      // Stale ipc-info.json — remove it, launch Kando, wait for fresh info.
      console.log('Kando not responding. Launching…');
      try { fs.unlinkSync(IPC_INFO_PATH); } catch { /* ignore */ }
      this._spawnKando();
      const info = await waitForIPCInfo();
      port = info.port;
      apiVersion = info.apiVersion;
      if (apiVersion !== 1) {
        throw new Error(
          `Kando IPC API version ${apiVersion} is not supported (expected 1)`
        );
      }
    } else if (!portAlive) {
      throw new Error(
        `Kando is not listening on port ${port} (stale ipc-info.json?). ` +
        `Pass { autoLaunch: true } to spawn it automatically.`
      );
    }

    // --- Connect WebSocket -------------------------------------------------
    await this._connectWebSocket(port);
  }

  /**
   * Send a show-menu request to Kando.
   *
   * The IPC server creates a ONE-TIME observer for show-menu requests, which gets
   * destroyed after the first select event. Since we need to handle submenu navigation
   * (two select events: submenu open → window pick), we first register as a persistent
   * observer via start-observing, then send the menu.
   *
   * @param {object} menuItem  - A tree conforming to Kando's MenuItem schema.
   */
  showMenu(menuItem) {
    if (!this.ws || !this.connected) {
      this.emit('error', { message: 'Not connected to Kando IPC' });
      return;
    }

    // Register as persistent observer on the FIRST call only.
    if (!this._observed) {
      this.ws.send(JSON.stringify({ type: 'start-observing' }));
      this._observed = true;
    }

    // Send the menu (creates a one-time observer too — we deduplicate on the
    // receiving end).
    this.ws.send(JSON.stringify({ type: 'show-menu', menu: menuItem }));
  }

  /**
   * Close the connection.
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Try to read ipc-info.json. If missing and autoLaunch is true, spawn Kando
   * and wait for the file to appear.
   *
   * @param {boolean} autoLaunch
   * @returns {Promise<{ port: number, apiVersion: number }>}
   */
  async _resolveIPCInfo(autoLaunch) {
    if (fs.existsSync(IPC_INFO_PATH)) {
      try {
        const raw = fs.readFileSync(IPC_INFO_PATH, 'utf-8');
        const info = JSON.parse(raw);
        return { port: info.port, apiVersion: info.apiVersion };
      } catch (err) {
        throw new Error(`Failed to parse ${IPC_INFO_PATH}: ${err.message}`);
      }
    }

    if (autoLaunch) {
      this._spawnKando();
      return await waitForIPCInfo();
    }

    throw new Error(
      `Kando IPC info not found at ${IPC_INFO_PATH}. ` +
        `Is Kando running? Pass { autoLaunch: true } to spawn it automatically.`
    );
  }

  /**
   * Quick TCP connect check — does any process actually listen on the port?
   * Returns within ~200ms if the port is dead, instead of waiting for a
   * WebSocket handshake timeout.
   *
   * @param {number} port
   * @returns {Promise<boolean>}
   */
  _verifyPortAlive(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const sock = new net.Socket();
      sock.setTimeout(300); // 300ms timeout
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => { sock.destroy(); resolve(false); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port, '127.0.0.1');
    });
  }

  /**
   * Spawn Kando in the background (detached).
   */
  _spawnKando() {
    try {
      const { spawn } = require('child_process');
      const child = spawn('kando', [], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      console.log('Kando was not running. Spawned in background (pid %d).', child.pid);
    } catch (err) {
      console.error('Failed to spawn Kando:', err.message);
    }
  }

  /**
   * Open the WebSocket and set up message / close / error handlers.
   *
   * @param {number} port
   * @returns {Promise<void>}
   */
  _connectWebSocket(port) {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}`;

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(new Error(`Failed to create WebSocket: ${err.message}`));
        return;
      }

      this.ws.on('open', () => {
        console.log('Connected to Kando IPC at %s', url);
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case 'open-menu':
              this.emit('open');
              break;

            case 'select-item':
              this.emit('select', { target: msg.target, path: msg.path });
              break;

            case 'cancel-menu':
              this.emit('cancel');
              break;

            case 'hover-item':
              this.emit('hover', { target: msg.target, path: msg.path });
              break;

            case 'error':
              this.emit('error', {
                message: `Kando IPC error: ${msg.reason} — ${msg.description}`,
              });
              break;

            default:
              break;
          }
        } catch (err) {
          this.emit('error', { message: `Failed to parse IPC message: ${err.message}` });
        }
      });

      this.ws.on('close', () => {
        if (this.connected) {
          console.log('Disconnected from Kando IPC');
        }
        this.connected = false;
        this.ws = null;
      });

      this.ws.on('error', (err) => {
        // If we haven't connected yet, the promise below will reject —
        // do NOT emit an 'error' event because the caller will handle
        // the rejection gracefully (e.g. by re-launching Kando).
        if (!this.connected) {
          reject(err);
        } else {
          this.emit('error', { message: `WebSocket error: ${err.message}` });
        }
      });

      // Safety timeout: if the connection doesn't open in 5s, reject.
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error(`WebSocket connection to ${url} timed out after 5s`));
        }
      }, 5000);
    });
  }
}

module.exports = { KandoIPCClient, IPC_INFO_PATH, waitForIPCInfo };
