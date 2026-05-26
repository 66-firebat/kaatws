'use strict';

// ---------------------------------------------------------------------------
// key-capture.js — Global keyboard capture for KAATWS
//
// Reads keystrokes directly from /dev/input/event* on Linux.
// The user must be in the "input" group for this to work.
// On systems with keyd, reads from the keyd virtual keyboard first.
// ---------------------------------------------------------------------------

const fs = require('fs');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// Linux key code → name mapping (subset of linux/input-event-codes.h)
// ---------------------------------------------------------------------------

const KEY_NAMES = {
  // Letters
  30: 'a', 48: 'b', 46: 'c', 32: 'd', 18: 'e', 33: 'f', 34: 'g', 35: 'h',
  23: 'i', 36: 'j', 37: 'k', 38: 'l', 50: 'm', 49: 'n', 24: 'o', 25: 'p',
  16: 'q', 19: 'r', 31: 's', 20: 't', 22: 'u', 47: 'v', 17: 'w', 45: 'x',
  21: 'y', 44: 'z',

  // Digits
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',

  // Special keys
  1: 'ESCAPE', 15: 'TAB', 28: 'ENTER', 14: 'BACKSPACE', 57: 'SPACE',
  56: 'LEFTALT', 100: 'RIGHTALT',
  42: 'LEFTSHIFT', 54: 'RIGHTSHIFT',
  29: 'LEFTCTRL', 97: 'RIGHTCTRL',
  125: 'LEFTMETA', 126: 'RIGHTMETA',

  // Navigation
  103: 'UP', 108: 'DOWN', 105: 'LEFT', 106: 'RIGHT',
  102: 'HOME', 107: 'END', 104: 'PAGEUP', 109: 'PAGEDOWN',
  111: 'DELETE', 110: 'INSERT',

  // Punctuation (US layout)
  12: '-', 13: '=', 26: '[', 27: ']', 39: ';', 40: "'", 41: '`',
  43: '\\', 51: ',', 52: '.', 53: '/',
};

const SHIFT_LETTERS = {
  'a': 'A', 'b': 'B', 'c': 'C', 'd': 'D', 'e': 'E', 'f': 'F', 'g': 'G',
  'h': 'H', 'i': 'I', 'j': 'J', 'k': 'K', 'l': 'L', 'm': 'M', 'n': 'N',
  'o': 'O', 'p': 'P', 'q': 'Q', 'r': 'R', 's': 'S', 't': 'T', 'u': 'U',
  'v': 'V', 'w': 'W', 'x': 'X', 'y': 'Y', 'z': 'Z',
};

const SHIFT_SYMBOLS = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&',
  '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}',
  ';': ':', "'": '"', '`': '~', '\\': '|', ',': '<', '.': '>', '/': '?',
};

const MODIFIER_KEYS = new Set([29, 97, 42, 54, 56, 100, 125, 126]);

// ---------------------------------------------------------------------------
// Device discovery
// ---------------------------------------------------------------------------

function findKeyboardDevices() {
  const devices = [];
  try {
    const procData = fs.readFileSync('/proc/bus/input/devices', 'utf-8');
    const entries = procData.split('\n\n');
    for (const entry of entries) {
      if (!entry.includes('Handlers=') || !entry.includes('kbd')) continue;
      const handlerLine = entry.split('\n').find(l => l.includes('Handlers='));
      if (!handlerLine) continue;
      const eventMatch = handlerLine.match(/event(\d+)/);
      if (!eventMatch) continue;
      const eventNum = parseInt(eventMatch[1]);
      const nameMatch = entry.match(/N: Name="([^"]+)"/);
      devices.push({ eventNum, path: `/dev/input/event${eventNum}`, name: nameMatch ? nameMatch[1] : 'unknown' });
    }
  } catch (e) {
    console.error('Failed to read /proc/bus/input/devices:', e.message);
  }
  // Sort: keyd virtual keyboard first, then by event number
  devices.sort((a, b) => {
    const aIsKeyd = a.name.toLowerCase().includes('keyd') ? -1 : 0;
    const bIsKeyd = b.name.toLowerCase().includes('keyd') ? -1 : 0;
    if (aIsKeyd !== bIsKeyd) return aIsKeyd - bIsKeyd;
    return a.eventNum - b.eventNum;
  });
  return devices;
}

// ---------------------------------------------------------------------------
// KeyboardCapture
// ---------------------------------------------------------------------------

class KeyboardCapture extends EventEmitter {
  constructor() {
    super();
    this._fd = null;
    this._timer = null;
    this._pollInterval = 15;
    this._shift = false;
    this._ctrl = false;
    this._alt = false;
    this._meta = false;
    this._devicePath = null;
    this._deviceName = null;
  }

  start(options = {}) {
    if (options.pollInterval) this._pollInterval = options.pollInterval;

    const devices = findKeyboardDevices();
    if (devices.length === 0) {
      this.emit('error', { message: 'No keyboard devices found' });
      return false;
    }

    for (const dev of devices) {
      try {
        this._fd = fs.openSync(dev.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        this._devicePath = dev.path;
        this._deviceName = dev.name;
        console.log('KeyboardCapture: using %s (%s)', dev.path, dev.name);
        break;
      } catch (e) {
        console.warn('KeyboardCapture: cannot open %s: %s', dev.path, e.message);
      }
    }

    if (!this._fd) {
      this.emit('error', { message: 'Could not open any keyboard device' });
      return false;
    }

    this._poll();
    return true;
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._fd !== null) { try { fs.closeSync(this._fd); } catch {} this._fd = null; }
  }

  _poll() {
    if (this._fd === null) return;
    const buf = Buffer.alloc(24);

    while (true) {
      try {
        const bytes = fs.readSync(this._fd, buf, 0, 24, null);
        if (bytes === 24) this._processEvent(buf);
      } catch (e) {
        if (e.code === 'EAGAIN') break;
        this.emit('error', { message: `Read error: ${e.message}` });
        this.stop();
        return;
      }
    }

    this._timer = setTimeout(() => this._poll(), this._pollInterval);
  }

  _processEvent(buf) {
    const type = buf.readUInt16LE(16);
    const code = buf.readUInt16LE(18);
    const value = buf.readInt32LE(20);

    if (type !== 1) return; // EV_KEY only

    // Track modifier state
    if (MODIFIER_KEYS.has(code)) {
      switch (code) {
        case 29: case 97: this._ctrl = value === 1; break;
        case 42: case 54: this._shift = value === 1; break;
        case 56: case 100:
          this._alt = value === 1;
          if (value === 0) {
            // ALT released — emit a synthetic key event
            this.emit('key', {
              name: 'ALT_UP', code, character: null,
              shift: this._shift, ctrl: this._ctrl,
              alt: false, meta: this._meta,
            });
          }
          break;
        case 125: case 126: this._meta = value === 1; break;
      }
      return;
    }

    if (value !== 1) return; // Press only, not release or repeat

    const name = KEY_NAMES[code];
    if (!name) return;

    const ev = { name, code, shift: this._shift, ctrl: this._ctrl, alt: this._alt, meta: this._meta };

    if (name.length === 1) {
      ev.character = this._shift ? (SHIFT_LETTERS[name] || SHIFT_SYMBOLS[name] || name) : name;
    } else {
      ev.character = null;
    }

    this.emit('key', ev);
  }
}

module.exports = { KeyboardCapture, findKeyboardDevices, KEY_NAMES };
