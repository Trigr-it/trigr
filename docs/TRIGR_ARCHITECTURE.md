# TRIGR — Architecture & Technical Decisions
> Key technical patterns, decisions, and rules for Claude Code.
> Read before making any structural changes.

---

## Stack

- **Framework:** Electron 28
- **Frontend:** React 18
- **Input capture:** uiohook-napi (global keyboard + mouse hooks)
- **Hotkey registration:** WinAPI RegisterHotKey
- **Storage:** JSON config file in AppData
- **Installer:** NSIS via electron-builder
- **Platform:** Windows 10/11 (x64 + ARM64)

---

## Critical Rules — Never Break These

### 1. Auto-updater
The auto-updater uses direct HTTPS download to `os.tmpdir()` — it does NOT use electron-updater's built-in download mechanism. This was specifically implemented after electron-updater's blockmap differential stalls proved unreliable.

```js
// CORRECT pattern — do not change
const dest = path.join(os.tmpdir(), 'TrigirSetup.exe');
// Direct HTTPS download to dest
// Then:
const child = spawn(dest, ['/VERYSILENT', '/RESTARTAPPLICATIONS'], {
  detached: true,
  stdio: 'ignore'
});
child.unref();
app.quit();
```

- Fire-and-forget — no `await` after spawn
- `app.quit()` immediately after spawn
- Only runs in production: `if (!isDev) { initAutoUpdater() }`
- Will NEVER appear in `npm run electron-dev` console — test in installed version only

### 2. Icons
App icons MUST live in `assets/icons/` — never in `build/`. React wipes `build/` on every build cycle.

### 3. Keyboard Scaling
Width-only ResizeObserver scaling. Do NOT divide by `devicePixelRatio`. This fixes the visual scaling bug between ARM64 (150% DPI) and x64 (100% DPI) machines.

### 4. Config Writes
All config writes are owned by `main.js`. The renderer never writes directly to disk. Import config writes to disk in `main.js` immediately after validation — never via a renderer `saveConfig` round-trip.

### 5. Help Guide Scaling
The scaling IIFE must not intercept `window.show`. Call `_trigrRescale` directly from `show()`. Hide `.kf` elements via `visibility:hidden` until `kf-ready` class is added post-scaling, with 150ms opacity fade-in to prevent snap-in flash.

### 6. Font Loading
Fonts are bundled locally — no Google Fonts CDN dependency.

```
public/
  fonts/
    Rajdhani-400/500/600/700.woff2   (latin, static)
    DMSans-300/400/500/600.woff2     (latin, static — from Fontsource)
    DMSans-300italic.woff2
    Syne-800.woff2                   (latin, static)
  fonts.css   ← @font-face declarations, url('fonts/filename.woff2')
  index.html  ← <link rel="stylesheet" href="%PUBLIC_URL%/fonts.css">
```

**Critical:** `@font-face` declarations must NOT go in any `src/` CSS file. CRA's webpack treats `url()` in src CSS as module import paths and fails the build. `public/fonts.css` is copied verbatim and not processed by webpack.

`keyforge-help.html` has its own inline `<style>` block with the subset it needs (Rajdhani 600/700, DM Sans 400/500/600), using relative paths `fonts/filename.woff2`.

### 7. Auto-Launch (Start with Windows)
```js
const isAutoLaunch = process.argv.includes('--autolaunch');
```
Registry entry written by `setStartupEnabled`:
```
"C:\path\to\Trigr.exe" --autolaunch
```
`BrowserWindow` constructed with `show: !isAutoLaunch`. When auto-launched: tray initialises, window stays hidden. User opens via tray as normal. No other startup logic is affected.

### 8. Foreground Watcher Visibility Guard
`handleForegroundChange()` now returns early if the main window is on screen:
```js
if (mainWindow.isVisible() && !mainWindow.isMinimized()) return;
```
This guard sits immediately after the existing `_SELF_PROC_NAMES` check. Profile auto-switching only runs when the window is hidden to tray (`isVisible() = false`) or minimised to taskbar (`isMinimized() = true`). No stored state — evaluated live on every 1500ms tick. Crash-safe: the existing `if (!mainWindow) return` guard above it handles window destruction.

---

## Storage Key Format

```
ProfileName::Modifier::KeyCode           // single press hotkey
ProfileName::Modifier::KeyCode::double   // double press hotkey
ProfileName::Bare::KeyCode               // bare key (no modifier)
AppName::Modifier::KeyCode               // app-specific hotkey
```

Config file: `app.getPath('userData') + '/keyforge-config.json'`  
Note: internally still named `keyforge-config.json`

---

## IPC Patterns

### Config loading
```js
// Resilient loader — always use this, not loadConfig()
loadConfigSafe()
// Tries: main config → last-known-good → timestamped backups
```

### Window controls
```js
ipcMain.on('window-minimize', ...)
ipcMain.on('window-maximize', ...)
ipcMain.on('window-close', ...)
```

### Assignment updates
When assignments change: call both `updateAssignments()` and `updateProfileSettings()` to sync the engine.

---

## Double Press Implementation

Applies to both **keyboard keys** and **mouse buttons**.

- Storage: base key + `::double` suffix variant
- Detection: `lastHotkeyTime` map + `pendingHotkeyTimer` map
- If hotkey has no double assignment → fire immediately, no delay
- If hotkey HAS a double assignment → wait 300ms before firing single press
- Configurable window: `doubleTapWindow` setting, default 300ms, range 150-500ms
- RegisterHotKey called once per base combo at OS level — double/single distinction handled in timer logic
- On reassign: both `::key` and `::key::double` variants move together

### Mouse double press — two paths

**Bare mouse** (no modifier): `dispatchHotkeyWithDoubleTap(bareStorageKey, bareMacro)` — same generic function as keyboard.

**Modifier + mouse**: Path-B inline detection at mousedown time (mirrors keyboard keydown-time detection):
```js
const doubleMacroMouse = activeAssignments[storageKey + '::double'];
if (doubleMacroMouse) {
  // First click: arm timer. Second click within window: resolve double.
  // Uses lastHotkeyTime / pendingHotkeyTimer maps, same as keyboard.
}
// Resolved macro stored in pendingMacro; fired when modifiers release (keyup).
```

UI: `ZONE_X2` coordinate map in `MouseCanvas.js` controls where ×2 badges appear per zone. `mc-double-badge` CSS class styles them. Single/Double toggle bar in `MacroPanel` now shown for mouse buttons (the `!selectedKey.startsWith('MOUSE_')` guard was removed).

---

## Export / Import

### Export
- Uses `loadConfigSafe()` — never `loadConfig()` (loadConfig can return null on error, exporting empty config)
- Logs assignment count before writing

### Import
- Validates structure
- Writes directly to disk in `main.js` immediately after validation
- No renderer `saveConfig` round-trip
- Calls `updateAssignments()` and `updateProfileSettings()` after write
- Renderer's redundant `saveConfig` call removed

---

## Publish Sequence (exact order required)

```bash
git add .
git commit -m "message"
npm run build
npm version patch
npm run publish
```

Installed version is always one behind the latest GitHub release. Changes in dev do not appear in installed version until the next publish cycle.

---

## Installer Optimisations (do not undo)

Installer is ~77MB because:
- koffi cross-platform binaries excluded
- Unused locale files excluded
- `react-scripts` moved to devDependencies
- Source maps removed

### Artifact naming
`package.json` nsis block: `"artifactName": "Trigr-Setup.${ext}"`
Output is always `Trigr-Setup.exe` regardless of version. This enables a permanent GitHub release download URL:
```
https://github.com/Trigr-it/trigr/releases/latest/download/Trigr-Setup.exe
```
Auto-updater download URL and landing page buttons all point to this URL.
**Note:** Users on pre-rename versions (< 0.1.44) will receive a failed auto-update once — the old URL references a versioned filename that no longer exists. They must download manually once. After that, all future updates work via the permanent URL.

---

## Code Signing

Azure Trusted Signing via `nodescaffold-signing` account (West Europe, Basic).  
Integration: electron-builder calls Azure signing service at build time.  
Status: identity validation submitted, awaiting Microsoft (1-3 weeks from March 2026).

---

## Future Technical Considerations

### Clipboard Manager
The Windows clipboard listener (`WM_CLIPBOARDUPDATE`) must be tested for conflicts with uiohook-napi BEFORE building the clipboard UI. This is the primary risk for the clipboard manager feature. Build and validate the native hook layer first.

### AHK Script Runner
Bundle AutoHotkey.exe via `electron-builder extraResources`. AHK is GPL v2 — credit required in About screen.

### Cloud Sync (v2.0)
Requires backend infrastructure. Target: Cloudflare Workers + Supabase. Not before v2.0.
