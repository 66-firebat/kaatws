# KAATWS — Kando ALT+TAB Window Switcher

> *A fast, fuzzy-filtered window-switching pie menu for Hyprland, powered by [Kando](https://github.com/kando-menu/kando).*

## TODO
- Remove all ALT+<number> bindings as numkeys are now treated as quickselect keys
- Add functionality to scrape the xdg desktop directory and allow for fast filter access to all desktop apps in the users system
---

## ⚠️ This repo depends on hyprland and kando

1. **[Kando](https://github.com/kando-menu/kando)** — the pie menu renderer. KAATWS connects to Kando's IPC WebSocket server, sends it a dynamic menu tree built from your running windows, and listens for selection/cancel events. **Without Kando, there is no pie menu.** Full stop.

2. **[Hyprland](https://hyprland.org/)** — the Wayland compositor. KAATWS talks to Hyprland via `hyprctl` to enumerate windows (`hyprctl clients -j`), detect the currently focused app (`hyprctl activewindow -j`), and focus specific windows (`hyprctl dispatch`). **Without Hyprland, there are no windows to switch between.** Full stop.

These are **hard dependencies**. This is not a general-purpose window switcher. This is a Kando pie menu that queries Hyprland's state.

---

## What It Does

KAATWS is a standalone Node.js script (`kaatws.js`) that:

- **Collects** all mapped windows from Hyprland via `hyprctl clients -j`.
- **Groups** them by window class (app name).
- **Builds** a hierarchical pie menu — one slice per app, with submenus for apps that have multiple windows.
- **Sends** the menu to Kando's IPC server, which renders it as a radial menu under your cursor.
- **Lets you navigate** with `Tab`/`Shift+Tab` to cycle selection, type letters to fuzzy-filter, press `1`–`6` to jump to a slot, or `Enter` to select. Submenus auto-expand when there's only one match.
- **Focuses** the selected window (or **launches** a default app if it wasn't running).

## Configuration

Edit `KAATWS.json` in this directory:

| Field | Default | Description |
|-------|---------|-------------|
| `defaultApps` | `[]` | Apps to show as launchable shortcuts even when not running |
| `hiddenWindows` | `[]` | Window matchers (`{ class?, title? }`) to exclude from the switcher |
| `iconTheme` | `"fireshark"` | Name of the Kando icon theme to use |
| `iconThemeDirectory` | `~/.config/kando/icon-themes` | Where Kando icon themes live |
| `maxItems` | `8` | Maximum items visible on one page (overflow creates submenus) |
| `submenuThreshold` | `2` | Minimum windows needed before apps get a submenu |
| `truncationLimit` | `30` | Max chars before window titles are truncated with `…` |

## Running

```bash
node kaatws.js
```

Or, if you assigned a keybind (e.g. via Hyprland's `bind = $mainMod, Tab, exec, node ~/.config/kaatws/kaatws.js`), just press it.

## Keybindings

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle selection clockwise / counter-clockwise |
| `1`–`6` | Select the slot at that position |
| Letter keys | Incremental fuzzy filter by app/window name |
| `Backspace` | Remove last character from filter |
| `Enter` | Select focused item (expand submenu or focus/launch) |
| `Ctrl+H` | Return to root level |
| `Escape` | Close and exit |

## How It Works (Briefly)

```
Hyprland ──hyprctl──▶ KAATWS ──WebSocket IPC──▶ Kando (pie menu)
   ▲                      │                         │
   └──hyprctl focus───────┘                         │
            │                                       │
            └── user clicks/presses key ────────────┘
```

1. KAATWS calls `hyprctl clients -j` to enumerate all visible windows.
2. Windows are grouped by class, sorted, and converted into a Kando menu tree.
3. KAATWS connects to Kando's IPC WebSocket and sends the tree via `show-menu`.
4. The user navigates the pie menu; selection events flow back over the WebSocket.
5. On selection, KAATWS calls `hyprctl dispatch` to focus the target window (or `exec` to launch a default app).

## Requirements

- **Hyprland** (Wayland compositor) — the `hyprctl` CLI must be available.
- **Kando** (pie menu application) — must expose its IPC WebSocket (it does by default on the latest releases).
- **Node.js ≥ 14** — the `ws` package is the only runtime dependency.
- **`input` group membership** — KAATWS reads `/dev/input/event*` for keyboard capture. Add your user to the `input` group if you haven't already: `sudo usermod -aG input $USER && reboot`.

## License

MIT
