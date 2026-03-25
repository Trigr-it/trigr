const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Windows taskbar identity — must be set before app.whenReady()
app.setAppUserModelId('com.trigr.app');

// ── Chromium memory optimisations ────────────────────────────────────────────
// Must be set before app.whenReady().
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');  // cap each renderer's V8 old-space heap
app.commandLine.appendSwitch('disable-http-cache');                    // no on-disk HTTP cache
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');         // no shader disk cache

let mainWindow;
let overlayWindow         = null;
let overlayHotkeyId       = null;  // numeric ID used with RegisterHotKey
let fillInWindow          = null;
let fillInWindowReady     = false; // true once the renderer has sent 'fill-in-ready'
let fillInPending         = false; // true while a fill-in prompt is active
let _fillInSubmitHandler  = null;  // current submit listener ref, for cleanup on window close
let searchOverlayHotkey   = 'Ctrl+Space'; // default; overridden from config
let tray          = null;
let isQuitting    = false;   // set true before app.quit() so close → destroy not hide
let hasShownBalloon = false; // one-time "running in background" notification

// ─────────────────────────────────────────────
// CONFIG PERSISTENCE
// ─────────────────────────────────────────────
const configPath  = path.join(app.getPath('userData'), 'keyforge-config.json');
const backupDir   = path.join(app.getPath('userData'), 'backups');
const MAX_BACKUPS = 10;

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[KeyForge] Failed to load config:', e);
  }
  return null;
}

function saveConfig(config) {
  const tmpPath = configPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (e) {
    console.error('[KeyForge] Failed to save config:', e);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return false;
  }
}

// ─────────────────────────────────────────────
// CONFIG BACKUP
// ─────────────────────────────────────────────

function isValidConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) return false;
  if (cfg.profiles.some(p => p == null)) return false;
  if (!cfg.assignments || typeof cfg.assignments !== 'object' || Array.isArray(cfg.assignments)) return false;
  return true;
}

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
}

function createTimestampedBackup(config) {
  if (!isValidConfig(config)) return;
  try {
    ensureBackupDir();
    const d    = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
    const dest  = path.join(backupDir, `keyforge-config-${stamp}.json`);
    fs.writeFileSync(dest, JSON.stringify(config, null, 2));
    console.log(`[KeyForge] Backup created: keyforge-config-${stamp}.json`);
    pruneBackups();
  } catch (e) {
    console.error('[KeyForge] Failed to create timestamped backup:', e.message);
  }
}

function updateLastKnownGood(config) {
  if (!isValidConfig(config)) return;
  try {
    ensureBackupDir();
    fs.writeFileSync(
      path.join(backupDir, 'keyforge-config-last-known-good.json'),
      JSON.stringify(config, null, 2)
    );
  } catch (e) {
    console.error('[KeyForge] Failed to update last-known-good:', e.message);
  }
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => /^keyforge-config-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    const excess = files.slice(0, Math.max(0, files.length - MAX_BACKUPS));
    for (const f of excess) {
      fs.unlinkSync(path.join(backupDir, f));
      console.log(`[KeyForge] Pruned old backup: ${f}`);
    }
  } catch (e) {
    console.error('[KeyForge] Failed to prune backups:', e.message);
  }
}

// loadConfigSafe — used on startup only.
// Tries the main config, then last-known-good, then newest timestamped backup.
// Returns { config, restoredFrom } where restoredFrom is null or a filename string.
function loadConfigSafe() {
  // 1. Try main config file
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (isValidConfig(cfg)) return { config: cfg, restoredFrom: null };
      console.warn('[KeyForge] Main config has invalid structure — trying backup');
    }
  } catch (e) {
    console.error('[KeyForge] Main config unreadable:', e.message);
  }

  // 2. Try last-known-good
  const lkgPath = path.join(backupDir, 'keyforge-config-last-known-good.json');
  try {
    if (fs.existsSync(lkgPath)) {
      const cfg = JSON.parse(fs.readFileSync(lkgPath, 'utf-8'));
      if (isValidConfig(cfg)) {
        console.log('[KeyForge] Restored from last-known-good backup');
        return { config: cfg, restoredFrom: 'keyforge-config-last-known-good.json' };
      }
    }
  } catch (e) {
    console.error('[KeyForge] last-known-good unreadable:', e.message);
  }

  // 3. Try timestamped backups, newest first
  try {
    ensureBackupDir();
    const files = fs.readdirSync(backupDir)
      .filter(f => /^keyforge-config-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(f))
      .sort().reverse();
    for (const f of files) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(backupDir, f), 'utf-8'));
        if (isValidConfig(cfg)) {
          console.log(`[KeyForge] Restored from backup: ${f}`);
          return { config: cfg, restoredFrom: f };
        }
      } catch (_) { /* try next */ }
    }
  } catch (e) {
    console.error('[KeyForge] Failed to scan backup directory:', e.message);
  }

  return { config: null, restoredFrom: null };
}

// Returns true when the incoming save represents a structurally significant change
// (profile list altered, or more than 5 assignment keys added/removed) worth snapshotting.
function isSignificantChange(incoming, existing) {
  if (incoming.profiles) {
    const inP = incoming.profiles;
    const exP = existing.profiles || [];
    if (inP.length !== exP.length || inP.some((p, i) => p !== exP[i])) return true;
  }
  if (incoming.assignments) {
    const inKeys = new Set(Object.keys(incoming.assignments));
    const exKeys = new Set(Object.keys(existing.assignments || {}));
    let diff = 0;
    for (const k of inKeys) { if (!exKeys.has(k)) diff++; }
    for (const k of exKeys) { if (!inKeys.has(k)) diff++; }
    if (diff > 5) return true;
  }
  return false;
}

// Summary stats extracted from a config object — used by list-backups
function configSummary(cfg) {
  const keys = Object.keys(cfg.assignments || {});
  return {
    profileCount:    (cfg.profiles || []).length,
    expansionCount:  keys.filter(k => k.includes('::EXPANSION::')).length,
    assignmentCount: keys.filter(k => !k.includes('::EXPANSION::') && !k.includes('::AUTOCORRECT::')).length,
  };
}

// ─────────────────────────────────────────────
// KEY CODE MAP  (uiohook keycode → our key IDs)
// ─────────────────────────────────────────────
const UIOHOOK_KEY_MAP = {
  // Letters
  30: 'KeyA', 48: 'KeyB', 46: 'KeyC', 32: 'KeyD', 18: 'KeyE', 33: 'KeyF',
  34: 'KeyG', 35: 'KeyH', 23: 'KeyI', 36: 'KeyJ', 37: 'KeyK', 38: 'KeyL',
  50: 'KeyM', 49: 'KeyN', 24: 'KeyO', 25: 'KeyP', 16: 'KeyQ', 19: 'KeyR',
  31: 'KeyS', 20: 'KeyT', 22: 'KeyU', 47: 'KeyV', 17: 'KeyW', 45: 'KeyX',
  21: 'KeyY', 44: 'KeyZ',
  // Numbers row
  2: 'Digit1', 3: 'Digit2', 4: 'Digit3', 5: 'Digit4', 6: 'Digit5',
  7: 'Digit6', 8: 'Digit7', 9: 'Digit8', 10: 'Digit9', 11: 'Digit0',
  // Function keys
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
  65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',
  // Special keys
  1:    'Escape',   28:   'Enter',     15:   'Tab',
  57:   'Space',    14:   'Backspace',
  12:   'Minus',    13:   'Equal',
  26:   'BracketLeft', 27: 'BracketRight',
  39:   'Semicolon', 40:  'Quote',
  41:   'Backquote', // x64 Windows scan code
  125:  'Backquote', // ARM64 Windows (uiohook-napi reports 0x007D on this platform)
  43:   'Backslash', 51:  'Comma',     52:   'Period',    53: 'Slash',
  // Modifiers
  42:   'ShiftLeft',   54:   'ShiftRight',
  29:   'ControlLeft', 3613: 'ControlRight',
  56:   'AltLeft',     3640: 'AltRight',
  3675: 'MetaLeft',    3676: 'MetaRight',
  58:   'CapsLock',
};

const MODIFIER_KEY_IDS = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock',
]);

// ─────────────────────────────────────────────
// ENGINE STATE
// ─────────────────────────────────────────────
let activeAssignments    = {};
let activeProfile        = 'Default';
let activeGlobalProfile  = 'Default'; // fallback when no app-specific profile matches
let macrosEnabled        = true;
let profileSettings      = {}; // { 'Gaming': { linkedApp: 'C:\\...\\game.exe' }, ... }
let autocorrectEnabled = false;

// ── Input method & timing (global defaults, overridable per-macro) ────────
let globalInputMethod  = 'direct'; // 'direct'|'shift-insert'|'ctrl-v'|'send-input'
let keystrokeDelay     = 30;       // ms between chars for direct/send-input modes
let macroTriggerDelay  = 150;      // ms before text output begins (replaces hardcoded 150ms)

let modifierState   = { ctrl: false, alt: false, shift: false, meta: false };
// True while a text input / textarea / contenteditable inside KeyForge has focus.
// When set, the uiohook keydown handler skips all macro and expansion logic so
// that keyboard shortcuts (Ctrl+A, Ctrl+C, …) are handled natively by the input.
let appInputFocused = false;

// When true, the next non-modifier keypress is captured and sent to the renderer
// as a 'hotkey-recorded' event instead of triggering a macro.
let _isRecordingHotkey = false;

// Macro matched on keydown but deferred until all modifier keys are physically
// released (keyup).  Guarantees no held physical keys interfere with output.
let pendingMacro = null;

// True when the pending macro was triggered by a Ctrl+Alt (AltGr) combo.
// Captured at keydown match time — modifierState is already cleared by the time
// executeMacro runs, so we can't check it there.
let pendingMacroAltGr = false;

// True when the pending macro was triggered by a bare key (no modifiers).
// In this case the trigger character always leaks to the active app because
// uiohook-napi v1.5.4 is a passive hook — event.preventDefault() is not part
// of its API, so the trigger keypress always propagates.
let pendingMacroIsBare = false;

// NOTE: uiohook-napi v1.5.4 does NOT support event suppression.
// The UiohookKeyboardEvent interface has no preventDefault() method, and the
// native binding always calls CallNextHookEx, passing every event through.
// lastKeySuppressed is therefore always false for all trigger types.
// Leaked characters are erased via a Backspace injection in executeMacro.
let lastKeySuppressed = false;

// ── Double-tap detection ──────────────────────────────────────────────────────
// doubleTapWindow: how long (ms) to wait for a second press before firing single
let doubleTapWindow = 300;
// lastHotkeyTime: storageKey → timestamp of most recent dispatch for that hotkey
const lastHotkeyTime = new Map();
// pendingHotkeyTimer: storageKey → timer ID for the pending single-tap execution
const pendingHotkeyTimer = new Map();
// pendingMacroStorageKey: storage key paired with pendingMacro (for double-tap lookup)
let pendingMacroStorageKey = null;

// Text expansion keypress buffer
let keypressBuffer = '';
const MAX_BUFFER_LENGTH = 50;

// ─────────────────────────────────────────────
// BUILT-IN TYPO CORRECTIONS (50 common English typos)
// ─────────────────────────────────────────────
const BUILTIN_TYPOS = {
  'teh': 'the', 'hte': 'the', 'adn': 'and', 'nad': 'and', 'ahve': 'have',
  'hvaing': 'having', 'recieve': 'receive', 'recieves': 'receives',
  'recieved': 'received', 'definately': 'definitely', 'seperate': 'separate',
  'occured': 'occurred', 'occurence': 'occurrence', 'untill': 'until',
  'wich': 'which', 'wiht': 'with', 'taht': 'that', 'thier': 'their',
  'theirselves': 'themselves', 'alot': 'a lot', 'alright': 'all right',
  'beleive': 'believe', 'concious': 'conscious', 'existance': 'existence',
  'freind': 'friend', 'freinds': 'friends', 'goverment': 'government',
  'grammer': 'grammar', 'harrassment': 'harassment', 'independant': 'independent',
  'judgement': 'judgment', 'knowlege': 'knowledge', 'lisence': 'license',
  'maintainance': 'maintenance', 'millenium': 'millennium', 'mispell': 'misspell',
  'neccessary': 'necessary', 'nieghbor': 'neighbor', 'occassion': 'occasion',
  'persistance': 'persistence', 'priviledge': 'privilege', 'publically': 'publicly',
  'recomend': 'recommend', 'relevent': 'relevant', 'religous': 'religious',
  'responsability': 'responsibility', 'rythm': 'rhythm', 'succesful': 'successful',
  'suprise': 'surprise', 'tatoo': 'tattoo', 'tendancy': 'tendency',
  'tommorow': 'tomorrow', 'truely': 'truly', 'wierd': 'weird',
};

// ── Foreground window logger (Windows only, async/best-effort) ─────────────
// Pre-encode the PS script at startup to avoid runtime escaping complexity.
// PowerShell -EncodedCommand expects Base64-encoded UTF-16LE.
const _FG_PS_SCRIPT = [
  'try {',
  '  Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);\' -Name FgWin -Namespace KF -ErrorAction SilentlyContinue',
  '  $hwnd = [KF.FgWin]::GetForegroundWindow()',
  '  $sb   = New-Object System.Text.StringBuilder 256',
  '  [KF.FgWin]::GetWindowText($hwnd, $sb, 256)',
  '  $sb.ToString()',
  '} catch { "unknown" }',
].join('\r\n');
const _FG_CMD = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(_FG_PS_SCRIPT, 'utf16le').toString('base64')}`;

function logForegroundApp() {
  if (process.platform !== 'win32') return;
  exec(_FG_CMD, { timeout: 3000 }, (_err, stdout) => {
    const title = stdout?.trim();
    console.log(`[KeyForge]   Foreground: ${title || '(unknown)'}`);
  });
}

// Maps key IDs to printable characters (lowercase) for buffer tracking
const KEY_CHAR_MAP = {
  'KeyA': 'a', 'KeyB': 'b', 'KeyC': 'c', 'KeyD': 'd', 'KeyE': 'e',
  'KeyF': 'f', 'KeyG': 'g', 'KeyH': 'h', 'KeyI': 'i', 'KeyJ': 'j',
  'KeyK': 'k', 'KeyL': 'l', 'KeyM': 'm', 'KeyN': 'n', 'KeyO': 'o',
  'KeyP': 'p', 'KeyQ': 'q', 'KeyR': 'r', 'KeyS': 's', 'KeyT': 't',
  'KeyU': 'u', 'KeyV': 'v', 'KeyW': 'w', 'KeyX': 'x', 'KeyY': 'y',
  'KeyZ': 'z',
  'Digit1': '1', 'Digit2': '2', 'Digit3': '3', 'Digit4': '4', 'Digit5': '5',
  'Digit6': '6', 'Digit7': '7', 'Digit8': '8', 'Digit9': '9', 'Digit0': '0',
  'Minus': '-', 'Equal': '=', 'BracketLeft': '[', 'BracketRight': ']',
  'Semicolon': ';', 'Quote': "'", 'Backquote': '`',
  'Backslash': '\\', 'Comma': ',', 'Period': '.', 'Slash': '/',
};

let uiohook = null;
let uiohookAvailable = false;
let nutjs = null;
let nutjsAvailable = false;

// ─────────────────────────────────────────────
// WINDOWS VIRTUAL KEY CODES  (key ID → VK code for RegisterHotKey)
// ─────────────────────────────────────────────
const VK_CODE_MAP = {
  'KeyA':0x41,'KeyB':0x42,'KeyC':0x43,'KeyD':0x44,'KeyE':0x45,
  'KeyF':0x46,'KeyG':0x47,'KeyH':0x48,'KeyI':0x49,'KeyJ':0x4A,
  'KeyK':0x4B,'KeyL':0x4C,'KeyM':0x4D,'KeyN':0x4E,'KeyO':0x4F,
  'KeyP':0x50,'KeyQ':0x51,'KeyR':0x52,'KeyS':0x53,'KeyT':0x54,
  'KeyU':0x55,'KeyV':0x56,'KeyW':0x57,'KeyX':0x58,'KeyY':0x59,'KeyZ':0x5A,
  'Digit1':0x31,'Digit2':0x32,'Digit3':0x33,'Digit4':0x34,'Digit5':0x35,
  'Digit6':0x36,'Digit7':0x37,'Digit8':0x38,'Digit9':0x39,'Digit0':0x30,
  'F1':0x70,'F2':0x71,'F3':0x72,'F4':0x73,'F5':0x74,'F6':0x75,
  'F7':0x76,'F8':0x77,'F9':0x78,'F10':0x79,'F11':0x7A,'F12':0x7B,
  'Space':0x20,'Enter':0x0D,'Tab':0x09,'Escape':0x1B,'Backspace':0x08,
  'Delete':0x2E,'Insert':0x2D,'Home':0x24,'End':0x23,
  'PageUp':0x21,'PageDown':0x22,
  'ArrowLeft':0x25,'ArrowRight':0x27,'ArrowUp':0x26,'ArrowDown':0x28,
  'Minus':0xBD,'Equal':0xBB,'BracketLeft':0xDB,'BracketRight':0xDD,
  'Semicolon':0xBA,'Quote':0xDE,'Backquote':0xC0,
  'Backslash':0xDC,'Comma':0xBC,'Period':0xBE,'Slash':0xBF,
};

const MOD_ALT      = 0x0001;
const MOD_CONTROL  = 0x0002;
const MOD_SHIFT    = 0x0004;
const MOD_WIN      = 0x0008;
const MOD_NOREPEAT = 0x4000;
const WM_HOTKEY    = 0x0312;
const OVERLAY_HOTKEY_ID     = 0xFFFF; // fixed ID reserved for the overlay toggle hotkey

// ─────────────────────────────────────────────
// KOFFI / RegisterHotKey  (Windows only, graceful — app works without it)
// uiohook-napi stays for ALL existing functionality.  koffi adds OS-level
// key suppression on top: registered hotkeys are intercepted before the
// foreground app sees them, so no Backspace-erase workaround is needed.
// ─────────────────────────────────────────────
let koffiAvailable                  = false;
let koffiRegisterHotKey             = null;
let koffiUnregisterHotKey           = null;
let koffiGetForegroundWindow        = null;
let koffiSetForegroundWindow        = null;
let koffiSendInput                  = null;
let koffiGetWindowThreadProcessId   = null;
let koffiOpenProcess                = null;
let koffiQueryFullProcessImageNameW = null;
let koffiCloseHandle                = null;

function loadKoffi() {
  if (process.platform !== 'win32') return;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // HWND passed as uint64 so we can hand the BigInt from getNativeWindowHandle()
    koffiRegisterHotKey      = user32.func('bool RegisterHotKey(uint64 hwnd, int id, uint32 fsModifiers, uint32 vk)');
    koffiUnregisterHotKey    = user32.func('bool UnregisterHotKey(uint64 hwnd, int id)');
    koffiGetForegroundWindow = user32.func('uint64 GetForegroundWindow()');
    koffiSetForegroundWindow = user32.func('bool SetForegroundWindow(uint64 hwnd)');
    koffiSendInput           = user32.func('uint32 SendInput(uint32 cInputs, void *pInputs, int32 cbSize)');
    // For native foreground-process detection (replaces PowerShell watcher subprocess)
    koffiGetWindowThreadProcessId   = user32.func('uint32 GetWindowThreadProcessId(uint64 hwnd, void *lpdwProcessId)');
    const kernel32 = koffi.load('kernel32.dll');
    koffiOpenProcess                = kernel32.func('uint64 OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
    koffiQueryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(uint64 hProcess, uint32 dwFlags, void *lpExeName, void *lpdwSize)');
    koffiCloseHandle                = kernel32.func('bool CloseHandle(uint64 hObject)');
    koffiAvailable = true;
    console.log('[KeyForge] koffi / user32 + kernel32 loaded ✓');
  } catch (e) {
    console.warn('[KeyForge] koffi not available — OS hotkey suppression disabled:', e.message);
  }
}

// ─────────────────────────────────────────────
// HOTKEY REGISTRATION STATE
// ─────────────────────────────────────────────
const registeredHotkeys    = new Map(); // id → { storageKey, macro }
const storageKeyToHotkeyId = new Map(); // storageKey → id
let   hotkeyIdCounter      = 1;
let   _koffiHwnd           = 0n; // BigInt HWND — set after mainWindow is created
let   _macroTargetHwnd    = 0n; // HWND of the foreground app captured at macro-fire time
let   _searchTargetHwnd   = 0n; // HWND captured before the search overlay steals focus
let   _currentMacroMethod = 'direct'; // effective input method for the current macro execution

function _modsFromComboStr(comboStr) {
  let mods = MOD_NOREPEAT;
  for (const part of comboStr.split('+')) {
    switch (part) {
      case 'Ctrl':  mods |= MOD_CONTROL; break;
      case 'Alt':   mods |= MOD_ALT;     break;
      case 'Shift': mods |= MOD_SHIFT;   break;
      case 'Win':   mods |= MOD_WIN;     break;
    }
  }
  return mods;
}

function _registerHotkey(storageKey, macro) {
  if (!koffiAvailable) return false;
  if (storageKeyToHotkeyId.has(storageKey)) return true; // already registered
  const parts = storageKey.split('::');
  if (parts.length < 3) return false;
  // Skip double-tap variants — they share the OS hotkey with their single counterpart
  if (parts[parts.length - 1] === 'double') return false;
  const comboStr = parts[1];
  const keyId    = parts[parts.length - 1];
  const vk = VK_CODE_MAP[keyId];
  if (!vk) return false; // no VK mapping (e.g. MOUSE_* keys — skip silently)
  const fsModifiers = (comboStr === 'BARE') ? MOD_NOREPEAT : _modsFromComboStr(comboStr);
  const id = hotkeyIdCounter++;
  const ok = koffiRegisterHotKey(_koffiHwnd, id, fsModifiers, vk);
  if (ok) {
    registeredHotkeys.set(id, { storageKey, macro });
    storageKeyToHotkeyId.set(storageKey, id);
    console.log(`[KeyForge] RegisterHotKey ✓ id=${id}: ${storageKey}`);
  } else {
    console.warn(`[KeyForge] RegisterHotKey ✗ ${storageKey} (key taken by another app?)`);
  }
  return ok;
}

function _unregisterHotkey(storageKey) {
  if (!koffiAvailable) return;
  const id = storageKeyToHotkeyId.get(storageKey);
  if (id === undefined) return;
  koffiUnregisterHotKey(_koffiHwnd, id);
  registeredHotkeys.delete(id);
  storageKeyToHotkeyId.delete(storageKey);
}

function unregisterAllHotkeys() {
  if (!koffiAvailable) return;
  const count = registeredHotkeys.size;
  for (const [id, { storageKey }] of registeredHotkeys.entries()) {
    console.log(`[KeyForge] UnregisterHotKey id=${id}: ${storageKey}`);
    koffiUnregisterHotKey(_koffiHwnd, id);
  }
  registeredHotkeys.clear();
  storageKeyToHotkeyId.clear();
  console.log(`[KeyForge] unregisterAllHotkeys — cleared ${count} entries from registeredHotkeys`);
}

function updateTrayTooltip() {
  if (!tray) return;
  tray.setToolTip(macrosEnabled ? 'Trigr — Active' : 'Trigr — Paused');
}

// Central pause/resume function — single source of truth for the global pause state.
// Handles: Win32 hotkey un/re-registration, tray label, tray tooltip, IPC to renderer.
function applyMacrosPause(paused) {
  macrosEnabled = !paused;
  if (paused) {
    unregisterAllHotkeys();
    // Also unregister the overlay hotkey — it lives in a separate slot outside registeredHotkeys
    if (overlayHotkeyId !== null) {
      console.log(`[KeyForge] UnregisterHotKey id=${overlayHotkeyId}: overlay (${searchOverlayHotkey})`);
      unregisterOverlayHotkey();
    }
    console.log('[KeyForge] Global pause — all hotkeys unregistered');
    // Verify nothing leaked — both maps must be empty
    setTimeout(() => {
      console.log(
        `[KeyForge] Pause verification — registeredHotkeys.size=${registeredHotkeys.size}, ` +
        `storageKeyToHotkeyId.size=${storageKeyToHotkeyId.size}, ` +
        `overlayHotkeyId=${overlayHotkeyId}`
      );
      if (registeredHotkeys.size > 0 || storageKeyToHotkeyId.size > 0 || overlayHotkeyId !== null) {
        console.warn('[KeyForge] ⚠ Hotkeys still registered after pause — forcing cleanup');
        unregisterAllHotkeys();
        unregisterOverlayHotkey();
      }
    }, 100);
  } else {
    registerModifierHotkeys();
    registerBareKeys();
    registerOverlayHotkey(searchOverlayHotkey);
    console.log('[KeyForge] Global resume — hotkeys re-registered');
  }
  updateTrayTooltip();
  buildTrayMenu();
  mainWindow?.webContents.send('engine-status', {
    uiohookAvailable, nutjsAvailable, macrosEnabled, activeProfile,
  });
}

// Re-register all modifier-combo hotkeys for the active profile.
// Bare keys are managed separately via registerBareKeys/unregisterBareKeys.
function registerModifierHotkeys() {
  if (!koffiAvailable) return;
  // Unregister existing non-bare registrations before re-registering
  for (const storageKey of [...storageKeyToHotkeyId.keys()]) {
    if (!storageKey.includes('::BARE::')) _unregisterHotkey(storageKey);
  }
  for (const [storageKey, macro] of Object.entries(activeAssignments)) {
    if (!storageKey.startsWith(activeProfile + '::')) continue;
    const parts = storageKey.split('::');
    if (parts.length < 3) continue;
    const comboStr = parts[1];
    if (comboStr === 'BARE' || comboStr === 'GLOBAL') continue;
    if (parts[parts.length - 1] === 'double') continue; // double-tap variants share OS hotkey
    _registerHotkey(storageKey, macro);
  }
}

// Register bare-key hotkeys for the active profile.
// Safe to call repeatedly — _registerHotkey is a no-op if key is already registered.
// Mouse bare assignments are handled via uiohook — never register via RegisterHotKey
const BARE_MOUSE_BLOCKED_IDS = new Set(['MOUSE_LEFT', 'MOUSE_RIGHT']);

function registerBareKeys() {
  if (!koffiAvailable) return;
  if (!profileSettings[activeProfile]?.linkedApp) return;
  for (const [storageKey, macro] of Object.entries(activeAssignments)) {
    if (!storageKey.startsWith(activeProfile + '::BARE::')) continue;
    const keyId = storageKey.split('::')[2];
    if (BARE_MOUSE_BLOCKED_IDS.has(keyId)) continue; // safety: never register bare L/R click
    _registerHotkey(storageKey, macro);
  }
}

function unregisterBareKeys() {
  if (!koffiAvailable) return;
  for (const storageKey of [...storageKeyToHotkeyId.keys()]) {
    if (storageKey.includes('::BARE::')) _unregisterHotkey(storageKey);
  }
}

// ─────────────────────────────────────────────
// DOUBLE-TAP DISPATCH
// ─────────────────────────────────────────────
// Dispatches a hotkey, handling double-tap detection when a ::double variant
// exists in activeAssignments.  Called from both WM_HOTKEY and the keyup
// deferred-execution path.  pendingMacroIsBare / pendingMacroAltGr must be
// set by the caller before invoking this function.
function dispatchHotkeyWithDoubleTap(storageKey, macro) {
  if (!storageKey) {
    executeMacro(macro).catch(console.error);
    return;
  }

  const doubleMacro = activeAssignments[storageKey + '::double'];

  if (!doubleMacro) {
    // No double-tap variant — fire immediately with no delay
    executeMacro(macro).catch(console.error);
    return;
  }

  // Snapshot isBare/altGr so timer closure sees the correct values even if
  // another hotkey fires between the first and second tap.
  const wasBare  = pendingMacroIsBare;
  const wasAltGr = pendingMacroAltGr;

  const now  = Date.now();
  const last = lastHotkeyTime.get(storageKey) || 0;

  if (now - last < doubleTapWindow && pendingHotkeyTimer.has(storageKey)) {
    // ── Second tap within window → fire double macro ──────────────────────
    clearTimeout(pendingHotkeyTimer.get(storageKey));
    pendingHotkeyTimer.delete(storageKey);
    lastHotkeyTime.delete(storageKey);
    console.log(`[KeyForge] ×2 Double-tap: ${storageKey}`);
    pendingMacroIsBare = wasBare;
    pendingMacroAltGr  = wasAltGr;
    executeMacro(doubleMacro).catch(console.error);
  } else {
    // ── First tap (or outside window) → schedule single after doubleTapWindow ──
    if (pendingHotkeyTimer.has(storageKey)) {
      clearTimeout(pendingHotkeyTimer.get(storageKey));
    }
    lastHotkeyTime.set(storageKey, now);
    console.log(`[KeyForge] ×1 First tap: ${storageKey} — waiting ${doubleTapWindow}ms`);
    const timer = setTimeout(() => {
      pendingHotkeyTimer.delete(storageKey);
      lastHotkeyTime.delete(storageKey);
      pendingMacroIsBare = wasBare;
      pendingMacroAltGr  = wasAltGr;
      console.log(`[KeyForge] ×1 Single confirmed: ${storageKey}`);
      executeMacro(macro).catch(console.error);
    }, doubleTapWindow);
    pendingHotkeyTimer.set(storageKey, timer);
  }
}

// ─────────────────────────────────────────────
// SENDINPUT HELPERS  (Windows low-level text injection)
// ─────────────────────────────────────────────
// sizeof(INPUT) on 64-bit Windows = 40 bytes:
//   DWORD type (4) + [4 pad] + union(32) where KEYBDINPUT uses:
//   wVk(2)+wScan(2)+dwFlags(4)+time(4)+[4pad]+dwExtraInfo(8) at union offset 0-23
const _INPUT_SIZE        = 40;
const _KEYEVENTF_UNICODE = 0x0004;
const _KEYEVENTF_KEYUP   = 0x0002;

function _writeKeyInput(buf, offset, scan, flags) {
  buf.writeUInt32LE(1,            offset);      // type = INPUT_KEYBOARD (1)
  // offset+4: 4 bytes padding (union alignment to 8)
  buf.writeUInt16LE(0,            offset + 8);  // wVk = 0 (unused for unicode)
  buf.writeUInt16LE(scan & 0xFFFF, offset + 10); // wScan = UTF-16 code unit
  buf.writeUInt32LE(flags,        offset + 12); // dwFlags
  // time, dwExtraInfo: already 0 (Buffer is zero-initialised)
}

async function _sendInputText(text, delayMs) {
  if (!koffiAvailable || !koffiSendInput) return false;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code > 0xFFFF) {
      // Surrogate pair — inject as two UTF-16 code units
      const hi = 0xD800 + Math.floor((code - 0x10000) / 0x400);
      const lo = 0xDC00 + (code - 0x10000) % 0x400;
      const buf = Buffer.alloc(4 * _INPUT_SIZE, 0);
      _writeKeyInput(buf, 0,                hi, _KEYEVENTF_UNICODE);
      _writeKeyInput(buf, _INPUT_SIZE,      hi, _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP);
      _writeKeyInput(buf, 2 * _INPUT_SIZE,  lo, _KEYEVENTF_UNICODE);
      _writeKeyInput(buf, 3 * _INPUT_SIZE,  lo, _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP);
      koffiSendInput(4, buf, _INPUT_SIZE);
    } else {
      const buf = Buffer.alloc(2 * _INPUT_SIZE, 0);
      _writeKeyInput(buf, 0,           code, _KEYEVENTF_UNICODE);
      _writeKeyInput(buf, _INPUT_SIZE, code, _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP);
      koffiSendInput(2, buf, _INPUT_SIZE);
    }
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return true;
}

// Resolve effective input method: macro override → global default
function _resolveInputMethod(macroData) {
  const override = macroData?.inputMethod || macroData?.pasteMethod; // pasteMethod = legacy
  if (override && override !== 'global') return override;
  return globalInputMethod;
}

// Central text output — used by both executeMacro('text') and executeMacroStep('Type Text')
async function _outputText(text, method) {
  if (!text) return;
  console.log(`[KeyForge] _outputText: method=${method}, length=${text.length}`);

  if (method === 'send-input') {
    console.log(`[KeyForge] SendInput: ${text.length} chars @ ${keystrokeDelay}ms/char`);
    const ok = await _sendInputText(text, keystrokeDelay);
    if (!ok) {
      console.warn('[KeyForge] SendInput unavailable — falling back to direct keystrokes');
      if (nutjsAvailable) await nutjs.keyboard.type(text);
    }
    return;
  }

  if (method === 'direct') {
    if (!nutjsAvailable) { console.warn('[KeyForge] nut-js required for direct keystroke output'); return; }
    console.log(`[KeyForge] Direct keystrokes: ${text.length} chars @ ${keystrokeDelay}ms/char`);
    if (keystrokeDelay > 0) {
      for (const char of text) {
        await nutjs.keyboard.type(char);
        await new Promise(r => setTimeout(r, keystrokeDelay));
      }
    } else {
      await nutjs.keyboard.type(text);
    }
    return;
  }

  // Clipboard methods (shift-insert / ctrl-v)
  if (!nutjsAvailable) { console.warn('[KeyForge] nut-js required for clipboard paste'); return; }
  const { Key } = nutjs;
  const prev = clipboard.readText();
  console.log(`[KeyForge] Clipboard save: "${prev.slice(0, 40)}${prev.length > 40 ? '…' : ''}"`);
  clipboard.writeText(text);
  console.log(`[KeyForge] Clipboard write: "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}" (${text.length} chars)`);
  if (method === 'ctrl-v') {
    console.log('[KeyForge] Paste: Ctrl+V');
    await nutjs.keyboard.pressKey(Key.LeftControl, Key.V);
    await nutjs.keyboard.releaseKey(Key.LeftControl, Key.V);
  } else {
    console.log('[KeyForge] Paste: Shift+Insert');
    await nutjs.keyboard.pressKey(Key.LeftShift, Key.Insert);
    await nutjs.keyboard.releaseKey(Key.LeftShift, Key.Insert);
  }
  await new Promise(r => setTimeout(r, 200));
  clipboard.writeText(prev);
  console.log('[KeyForge] Clipboard restored');
}

// ─────────────────────────────────────────────
// LOAD NATIVE LIBS (graceful — app still works without them)
// ─────────────────────────────────────────────
function loadUiohook() {
  try {
    const mod = require('uiohook-napi');
    uiohook = mod.uIOhook;
    uiohookAvailable = true;
    console.log('[KeyForge] uiohook-napi loaded ✓');
  } catch (e) {
    console.warn('[KeyForge] uiohook-napi not available — install with: npm install uiohook-napi');
    uiohookAvailable = false;
  }
}

let _nutjsLoadAttempted = false;
function loadNutjs() {
  if (_nutjsLoadAttempted) return;
  _nutjsLoadAttempted = true;
  try {
    nutjs = require('@nut-tree-fork/nut-js');
    nutjs.keyboard.config.autoDelayMs = 0;
    nutjsAvailable = true;
    console.log('[KeyForge] nut-js loaded ✓');
  } catch (e) {
    console.warn('[KeyForge] nut-js not available — install with: npm install @nut-tree-fork/nut-js');
    nutjsAvailable = false;
  }
}

// ─────────────────────────────────────────────
// NUT-JS HELPERS
// ─────────────────────────────────────────────
function getNutModifiers(modifiers) {
  if (!nutjsAvailable) return [];
  const { Key } = nutjs;
  return (modifiers || []).map(mod => {
    switch (mod.toLowerCase()) {
      case 'ctrl':  return Key.LeftControl;
      case 'alt':   return Key.LeftAlt;
      case 'shift': return Key.LeftShift;
      case 'win':   return Key.LeftSuper;
      default:      return null;
    }
  }).filter(Boolean);
}

function getNutKey(keyName) {
  if (!nutjsAvailable || !keyName) return null;
  const { Key } = nutjs;
  const map = {
    'A': Key.A, 'B': Key.B, 'C': Key.C, 'D': Key.D, 'E': Key.E,
    'F': Key.F, 'G': Key.G, 'H': Key.H, 'I': Key.I, 'J': Key.J,
    'K': Key.K, 'L': Key.L, 'M': Key.M, 'N': Key.N, 'O': Key.O,
    'P': Key.P, 'Q': Key.Q, 'R': Key.R, 'S': Key.S, 'T': Key.T,
    'U': Key.U, 'V': Key.V, 'W': Key.W, 'X': Key.X, 'Y': Key.Y, 'Z': Key.Z,
    'F1': Key.F1, 'F2': Key.F2, 'F3': Key.F3, 'F4': Key.F4,
    'F5': Key.F5, 'F6': Key.F6, 'F7': Key.F7, 'F8': Key.F8,
    'F9': Key.F9, 'F10': Key.F10, 'F11': Key.F11, 'F12': Key.F12,
    'SPACE': Key.Space, 'TAB': Key.Tab, 'ENTER': Key.Return,
    'ESCAPE': Key.Escape, 'DELETE': Key.Delete,
    'HOME': Key.Home, 'END': Key.End,
    'UP': Key.Up, 'DOWN': Key.Down, 'LEFT': Key.Left, 'RIGHT': Key.Right,
    'PAGEUP': Key.PageUp, 'PAGEDOWN': Key.PageDown,
    '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3,
    '4': Key.Num4, '5': Key.Num5, '6': Key.Num6, '7': Key.Num7,
    '8': Key.Num8, '9': Key.Num9,
  };
  return map[keyName.toUpperCase()] || null;
}

// ─────────────────────────────────────────────
// MACRO EXECUTOR
// ─────────────────────────────────────────────
async function executeMacro(macro) {
  if (!macrosEnabled) return;

  // Capture the foreground HWND RIGHT NOW, before any async delay.
  // This is the app the user was working in when the hotkey fired.
  // executeMacroStep reads _macroTargetHwnd to restore focus before pasting.
  if (koffiAvailable && koffiGetForegroundWindow) {
    const fgHwnd = koffiGetForegroundWindow();
    // Only store if it isn't KeyForge's own window
    if (fgHwnd !== _koffiHwnd) {
      _macroTargetHwnd = fgHwnd;
      console.log(`[KeyForge] Target HWND captured: 0x${_macroTargetHwnd.toString(16)}`);
    }
  }

  // Snapshot trigger-type flags before any await so a subsequent macro queued
  // during our delay doesn't inherit this invocation's state.
  const altGrWasFired  = pendingMacroAltGr;  pendingMacroAltGr  = false;
  const bareWasFired   = pendingMacroIsBare;  pendingMacroIsBare = false;

  // Short initial delay — gives Windows time to finish delivering the keydown
  // event to other hooks and the foreground application before we start output.
  await new Promise(r => setTimeout(r, 50));

  // ── Shared preamble: modifier release + leaked-character erase ────────────
  // uiohook-napi v1.5.4 is a PASSIVE hook; it has no suppression API.
  // Modifier-combo triggers (Ctrl+E etc.) don't produce WM_CHAR, so they're
  // safe.  Two cases DO leak a character into the active app:
  //   • Bare keys:   the trigger char (e.g. ]) is typed verbatim.
  //   • AltGr combos: Ctrl+Alt dead-key state generates a Unicode char (é, á…).
  // In both cases we inject one Backspace immediately before any macro output
  // to erase the leaked character — the same technique used by AutoHotkey's
  // "erase" mode.  The 50ms initial delay above guarantees the character has
  // already appeared in the app before we send the Backspace.
  if (nutjsAvailable) {
    // Release any modifiers still showing as held.  For bare-key macros there
    // are none; for modifier combos Shift/Meta may still be physically down.
    const heldKeys = [];
    if (modifierState.ctrl)  heldKeys.push(nutjs.Key.LeftControl);
    if (modifierState.alt)   heldKeys.push(nutjs.Key.LeftAlt);
    if (modifierState.shift) heldKeys.push(nutjs.Key.LeftShift);
    if (modifierState.meta)  heldKeys.push(nutjs.Key.LeftSuper);
    if (heldKeys.length > 0) await nutjs.keyboard.releaseKey(...heldKeys);

    if (bareWasFired || altGrWasFired) {
      await new Promise(r => setTimeout(r, 30));
      await nutjs.keyboard.pressKey(nutjs.Key.Backspace);
      await nutjs.keyboard.releaseKey(nutjs.Key.Backspace);
      await new Promise(r => setTimeout(r, 20));
    }
  }

  console.log(`[KeyForge] ▶ Firing: [${macro.type}] ${macro.label}`);

  try {
    switch (macro.type) {

      case 'text': {
        if (!macro.data?.text) break;
        const method = _resolveInputMethod(macro.data);
        _currentMacroMethod = method;
        // Wait for modifier releases to fully settle before sending output.
        await new Promise(r => setTimeout(r, macroTriggerDelay));
        // Restore focus to the target app captured at macro-fire time.
        if (koffiAvailable && koffiSetForegroundWindow && _macroTargetHwnd) {
          const focusOk = koffiSetForegroundWindow(_macroTargetHwnd);
          const fgNow   = koffiGetForegroundWindow?.() ?? 0n;
          console.log(`[KeyForge] SetForegroundWindow(0x${_macroTargetHwnd.toString(16)}) → ${focusOk}, fg now: 0x${fgNow.toString(16)}`);
          await new Promise(r => setTimeout(r, 30));
        }
        await _outputText(macro.data.text, method);
        break;
      }

      case 'hotkey': {
        if (!nutjsAvailable) {
          console.warn('[KeyForge] nut-js required for hotkey sending');
          break;
        }
        if (!macro.data?.key) break;
        const { Key } = nutjs;
        // Modifier release and Backspace erase are handled in the shared preamble above.
        // Wait for Windows to fully process the releases before injecting the output.
        await new Promise(r => setTimeout(r, 150));
        const mods = getNutModifiers(macro.data.modifiers || []);
        const key  = getNutKey(macro.data.key);
        if (!key) { console.warn('[KeyForge] Unknown key:', macro.data.key); break; }
        await nutjs.keyboard.pressKey(...mods, key);
        await nutjs.keyboard.releaseKey(...mods, key);
        break;
      }

      case 'url': {
        if (!macro.data?.url) break;
        await shell.openExternal(macro.data.url);
        break;
      }

      case 'app': {
        if (!macro.data?.path) break;
        const result = await shell.openPath(macro.data.path);
        if (result) console.warn('[KeyForge] openPath error:', result);
        break;
      }

      case 'folder': {
        if (!macro.data?.path) break;
        const result = await shell.openPath(macro.data.path);
        if (result) console.warn('[KeyForge] openPath (folder) error:', result);
        break;
      }

      case 'macro': {
        const steps = macro.data?.steps || [];
        console.log(`[KeyForge] Macro sequence: ${steps.length} step(s)`);
        if (steps.length === 0) {
          console.warn('[KeyForge] Macro sequence has no steps — nothing to run');
          break;
        }
        // Resolve input method once for the whole sequence
        _currentMacroMethod = _resolveInputMethod(macro.data);
        console.log(`[KeyForge] Macro sequence input method: ${_currentMacroMethod}`);
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          console.log(`[KeyForge]   Step ${i + 1}/${steps.length}: [${step.type}] "${step.value}"`);
          await executeMacroStep(step);
        }
        break;
      }

      default:
        console.warn('[KeyForge] Unknown macro type:', macro.type);
    }
  } catch (e) {
    console.error('[KeyForge] Macro execution error:', e.message);
  }

  // Visual feedback to UI
  mainWindow?.webContents.send('macro-fired', {
    label: macro.label,
    type: macro.type,
  });
}

async function executeMacroStep(step) {
  try {
    switch (step.type) {

      case 'Type Text': {
        if (!step.value) { console.warn('[KeyForge]   ↳ skip: empty value'); break; }
        // Release held modifiers so they don't combine with injected input
        if (nutjsAvailable) {
          const { Key } = nutjs;
          const heldKeys = [];
          if (modifierState.ctrl)  heldKeys.push(Key.LeftControl);
          if (modifierState.alt)   heldKeys.push(Key.LeftAlt);
          if (modifierState.shift) heldKeys.push(Key.LeftShift);
          if (modifierState.meta)  heldKeys.push(Key.LeftSuper);
          if (heldKeys.length > 0) {
            console.log(`[KeyForge]   ↳ releasing ${heldKeys.length} held modifier(s)`);
            await nutjs.keyboard.releaseKey(...heldKeys);
          }
        }
        // Wait for modifier releases and the OS to be ready for input
        await new Promise(r => setTimeout(r, macroTriggerDelay));
        // Restore focus to the target app captured at macro-fire time
        if (koffiAvailable && koffiSetForegroundWindow && _macroTargetHwnd) {
          const focusOk = koffiSetForegroundWindow(_macroTargetHwnd);
          const fgNow   = koffiGetForegroundWindow?.() ?? 0n;
          console.log(`[KeyForge]   ↳ SetForegroundWindow(0x${_macroTargetHwnd.toString(16)}) → ${focusOk}, fg now: 0x${fgNow.toString(16)}`);
          await new Promise(r => setTimeout(r, 30));
        }
        console.log(`[KeyForge]   ↳ Type Text via method: ${_currentMacroMethod}`);
        await _outputText(step.value, _currentMacroMethod);
        break;
      }

      case 'Press Key': {
        if (!nutjsAvailable) { console.warn('[KeyForge]   ↳ skip: nut-js not available'); break; }
        if (!step.value)     { console.warn('[KeyForge]   ↳ skip: empty value');           break; }
        // Parse "Ctrl+Shift+N" style strings produced by KeyCaptureInput
        const parts = step.value.split('+').map(s => s.trim());
        const keyName = parts.pop();
        const mods = getNutModifiers(parts);
        const key = getNutKey(keyName);
        if (!key) { console.warn(`[KeyForge]   ↳ skip: unknown key "${keyName}"`); break; }
        console.log(`[KeyForge]   ↳ pressing ${step.value}`);
        await nutjs.keyboard.pressKey(...mods, key);
        await nutjs.keyboard.releaseKey(...mods, key);
        break;
      }

      case 'Wait (ms)': {
        const ms = Math.min(parseInt(step.value) || 500, 30000);
        console.log(`[KeyForge]   ↳ waiting ${ms}ms`);
        await new Promise(resolve => setTimeout(resolve, ms));
        break;
      }

      case 'Open URL': {
        if (!step.value) { console.warn('[KeyForge]   ↳ skip: empty URL'); break; }
        console.log(`[KeyForge]   ↳ opening URL: ${step.value}`);
        await shell.openExternal(step.value);
        break;
      }

      case 'Wait for Input': {
        if (!uiohookAvailable || !uiohook) {
          console.warn('[KeyForge]   ↳ skip: uiohook not available for Wait for Input');
          break;
        }

        // Parse config stored as JSON in step.value
        let wfi = { inputType: 'LButton', trigger: 'press', specificKey: '' };
        try { wfi = { ...wfi, ...JSON.parse(step.value || '{}') }; } catch (_) {}
        const { inputType, trigger, specificKey } = wfi;

        // Map stored inputType to uiohook mouse button number
        const MOUSE_BTN = { LButton: 1, RButton: 2, MButton: 3 };
        const isMouseType = inputType in MOUSE_BTN;
        const button = MOUSE_BTN[inputType];

        // Convert uiohook keyId (e.g. "KeyA", "Digit1", "Space") to the display
        // name format produced by KeyCaptureInput (e.g. "A", "1", "Space").
        function keyIdToLabel(id) {
          if (!id) return '';
          if (id.startsWith('Key'))   return id.slice(3);
          if (id.startsWith('Digit')) return id.slice(5);
          return id;
        }

        // specificKey may include modifiers ("Ctrl+Enter") — only the last segment
        // (the non-modifier key) is checked so the wait isn't sensitive to modifier
        // state at the time the user presses the key.
        const wantedKey = specificKey ? specificKey.split('+').pop() : '';

        const TIMEOUT_MS = 30_000;
        console.log(`[KeyForge]   ↳ waiting for input: ${inputType} / ${trigger}${specificKey ? ` (key: ${specificKey})` : ''}`);

        await new Promise((resolve, reject) => {
          let settled = false;
          let timer;
          // For pressRelease: track whether we've seen the down event yet
          let phase = 'down';

          function finish(err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Always remove all four possible listeners — no-op if not attached
            uiohook.removeListener('mousedown', onMouseDown);
            uiohook.removeListener('mouseup',   onMouseUp);
            uiohook.removeListener('keydown',   onKeyDown);
            uiohook.removeListener('keyup',     onKeyUp);
            if (err) reject(err); else resolve();
          }

          function onMouseDown(event) {
            if (!macrosEnabled)               { finish(new Error('macros disabled')); return; }
            if (event.button !== button)      return;
            if (trigger === 'press')          { finish(); return; }
            if (trigger === 'pressRelease' && phase === 'down') { phase = 'up'; }
          }

          function onMouseUp(event) {
            if (!macrosEnabled)               { finish(new Error('macros disabled')); return; }
            if (event.button !== button)      return;
            if (trigger === 'release')        { finish(); return; }
            if (trigger === 'pressRelease' && phase === 'up') { finish(); }
          }

          function onKeyDown(event) {
            if (!macrosEnabled) { finish(new Error('macros disabled')); return; }
            const keyId = UIOHOOK_KEY_MAP[event.keycode];
            if (!keyId || MODIFIER_KEY_IDS.has(keyId)) return;
            if (inputType === 'SpecificKey' && keyIdToLabel(keyId) !== wantedKey) return;
            if (trigger === 'press')          { finish(); return; }
            if (trigger === 'pressRelease' && phase === 'down') { phase = 'up'; }
          }

          function onKeyUp(event) {
            if (!macrosEnabled) { finish(new Error('macros disabled')); return; }
            const keyId = UIOHOOK_KEY_MAP[event.keycode];
            if (!keyId || MODIFIER_KEY_IDS.has(keyId)) return;
            if (inputType === 'SpecificKey' && keyIdToLabel(keyId) !== wantedKey) return;
            if (trigger === 'release')        { finish(); return; }
            if (trigger === 'pressRelease' && phase === 'up') { finish(); }
          }

          timer = setTimeout(
            () => finish(new Error(`Wait for Input timed out after ${TIMEOUT_MS / 1000}s`)),
            TIMEOUT_MS,
          );

          if (isMouseType) {
            if (trigger !== 'release') uiohook.on('mousedown', onMouseDown);
            if (trigger !== 'press')   uiohook.on('mouseup',   onMouseUp);
          } else {
            if (trigger !== 'release') uiohook.on('keydown', onKeyDown);
            if (trigger !== 'press')   uiohook.on('keyup',   onKeyUp);
          }
        });

        break;
      }

      default:
        console.warn(`[KeyForge]   ↳ skip: unrecognised step type "${step.type}"`);
    }
  } catch (e) {
    console.error(`[KeyForge]   ↳ step error (${step.type}):`, e.message);
  }
}

// ─────────────────────────────────────────────
// TOKEN PROCESSING HELPERS
// ─────────────────────────────────────────────

function _pad(n) { return String(n).padStart(2, '0'); }

function _formatDate(d, fmt) {
  return fmt
    .replace('DD',   _pad(d.getDate()))
    .replace('MM',   _pad(d.getMonth() + 1))
    .replace('YYYY', d.getFullYear());
}

function _formatTime(d, fmt) {
  return fmt
    .replace('HH', _pad(d.getHours()))
    .replace('MM', _pad(d.getMinutes()))
    .replace('SS', _pad(d.getSeconds()));
}

const _DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// Create the floating fill-in prompt window (frameless, always-on-top).
function createFillInWindow() {
  fillInWindow = new BrowserWindow({
    width: 340,
    height: 180,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    fillInWindow.loadURL('http://localhost:3000/?fillin=1');
  } else {
    fillInWindow.loadFile(path.join(__dirname, '../build/index.html'), { query: { fillin: '1' } });
  }

  // Intercept close (Alt+F4, etc.) — hide instead of destroy so the renderer
  // stays loaded for fast reuse on subsequent fill-in triggers.
  fillInWindow.on('close', (e) => {
    if (!isQuitting && fillInWindow && !fillInWindow.isDestroyed()) {
      e.preventDefault();
      fillInWindow.hide();
      if (_fillInSubmitHandler) {
        ipcMain.removeListener('fill-in-submit', _fillInSubmitHandler);
        _fillInSubmitHandler = null;
      }
      fillInPending = false;
    }
  });

  fillInWindow.on('closed', () => {
    // Fires only during app quit (isQuitting=true) — clean up state.
    fillInWindow      = null;
    fillInWindowReady = false;
    fillInPending     = false;
  });
}

// Persistent ready signal — renderer sends this once after React mounts.
// Registered once here (not inside _promptFillInAll) so it persists across calls.
ipcMain.on('fill-in-ready', () => {
  console.log('[KeyForge] fill-in: renderer ready');
  fillInWindowReady = true;
});

// Show the fill-in window with a list of field labels.
// Resolves with { label: value } map, or null if cancelled.
function _promptFillInAll(labels) {
  return new Promise(resolve => {
    // Guard: only one fill-in prompt at a time.  A second expansion trigger
    // while a prompt is active is silently dropped (returns null = cancelled).
    if (fillInPending) {
      console.log('[KeyForge] fill-in: already active, ignoring duplicate trigger');
      resolve(null);
      return;
    }
    fillInPending = true;

    if (!fillInWindow || fillInWindow.isDestroyed()) {
      fillInWindowReady = false; // new window — need to wait for ready signal again
      createFillInWindow();
    }

    // Size to fit all fields: header (42) + each field row (64) + actions (46)
    const winWidth  = 340;
    const winHeight = 42 + labels.length * 64 + 46;

    // Position near the current cursor, clamped to the display
    const cursor  = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x: dx, y: dy, width: dw, height: dh } = display.bounds;

    let wx = cursor.x + 12;
    let wy = cursor.y + 12;
    if (wx + winWidth  > dx + dw) wx = dx + dw - winWidth  - 8;
    if (wy + winHeight > dy + dh) wy = cursor.y - winHeight - 8;
    wx = Math.max(dx + 8, wx);
    wy = Math.max(dy + 8, wy);

    // Capture the foreground window BEFORE the fill-in popup steals focus.
    // This is the app the user was typing in — we restore focus here after close.
    let fillInTargetHwnd = 0n;
    if (koffiAvailable && koffiGetForegroundWindow) {
      const fgHwnd = koffiGetForegroundWindow();
      if (fgHwnd && fgHwnd !== _koffiHwnd) {
        fillInTargetHwnd = fgHwnd;
        console.log(`[KeyForge] fill-in: captured target HWND 0x${fillInTargetHwnd.toString(16)}`);
      }
    }

    // Named submit handler stored at module level so the closed-window handler
    // can remove it if the OS closes the window without a submit event.
    function onSubmit(_evt, values) {
      console.log('[KeyForge] fill-in-submit received, values:', JSON.stringify(values));
      ipcMain.removeListener('fill-in-submit', onSubmit);
      _fillInSubmitHandler = null;
      fillInPending = false;
      if (fillInWindow && !fillInWindow.isDestroyed()) {
        // Hide (not close) — closing can cause Windows to focus an unexpected window
        fillInWindow.hide();
      }
      // Restore focus to the original app before the expansion text fires.
      // This must happen before resolve() so the focus transfer has maximum
      // lead time before _outputText / Shift+Insert runs.
      if (koffiAvailable && koffiSetForegroundWindow && fillInTargetHwnd) {
        const ok    = koffiSetForegroundWindow(fillInTargetHwnd);
        const fgNow = koffiGetForegroundWindow?.() ?? 0n;
        console.log(`[KeyForge] fill-in: SetForegroundWindow(0x${fillInTargetHwnd.toString(16)}) → ${ok}, fg now: 0x${fgNow.toString(16)}`);
      }
      resolve(values ?? null); // null = user cancelled (Escape or ✕)
    }
    _fillInSubmitHandler = onSubmit;
    ipcMain.on('fill-in-submit', onSubmit);

    // Show + send only after React has signalled it is mounted (fill-in-ready).
    // This prevents the black-box flash where the window was visible but blank
    // because React hadn't rendered yet.
    function showAndSend() {
      if (!fillInWindow || fillInWindow.isDestroyed()) return;
      fillInWindow.setBounds({ x: wx, y: wy, width: winWidth, height: winHeight });
      fillInWindow.show();
      fillInWindow.focus();
      console.log('[KeyForge] fill-in: sending fields to renderer:', labels);
      fillInWindow.webContents.send('fill-in-show', { fields: labels, theme: loadConfig()?.theme || 'dark' });
    }

    if (fillInWindowReady) {
      showAndSend();
    } else {
      ipcMain.once('fill-in-ready', showAndSend);
    }
  });
}

// Resolve all dynamic tokens in plainText and parallel HTML.
// Returns { text, html, cursorBack } where cursorBack is how many
// characters to move the cursor left after pasting (for {cursor}).
async function _resolveTokens(plainText, htmlContent) {
  const now = new Date();

  // ── 0. Substitute {{varName}} global variables ────────────────────────────
  // Defined variables are replaced silently; unknown variables fall through to
  // the fill-in prompt system by being converted to {fillIn:varName}.
  const globalVariables = loadConfig()?.globalVariables || {};
  if (plainText.includes('{{')) {
    const substituteGv = (str) =>
      str.replace(/\{\{([a-z][a-z0-9._]*)\}\}/g, (_, name) =>
        name in globalVariables ? globalVariables[name] : `{fillIn:${name}}`
      );
    plainText    = substituteGv(plainText);
    if (htmlContent) htmlContent = substituteGv(htmlContent);
  }

  // ── 1. Collect and resolve all fill-in fields (async, user-prompted) ──────
  // Gather unique labels in order of first appearance
  const fillInValues = {};
  const fillInLabels = [];
  const _seen = new Set();
  for (const [, label] of plainText.matchAll(/\{fillIn:([^}]+)\}/g)) {
    if (!_seen.has(label)) { _seen.add(label); fillInLabels.push(label); }
  }
  if (fillInLabels.length > 0) {
    console.log('[KeyForge] _promptFillInAll awaiting for labels:', fillInLabels);
    const values = await _promptFillInAll(fillInLabels);
    console.log('[KeyForge] _promptFillInAll resolved, values:', JSON.stringify(values));
    if (values === null) {
      console.log('[KeyForge] fill-in cancelled, aborting expansion');
      return { text: '', html: null, cursorBack: 0, cancelled: true };
    }
    for (const label of fillInLabels) {
      fillInValues[label] = values[label] ?? '';
    }
    console.log('[KeyForge] fillInValues built:', JSON.stringify(fillInValues));
  }

  // ── 2. Build the deterministic replacement table ──────────────────────────
  const clipText = clipboard.readText();
  const replMap = {
    '{clipboard}':       clipText,
    '{date:DD/MM/YYYY}': _formatDate(now, 'DD/MM/YYYY'),
    '{date:MM/DD/YYYY}': _formatDate(now, 'MM/DD/YYYY'),
    '{date:YYYY-MM-DD}': _formatDate(now, 'YYYY-MM-DD'),
    '{time:HH:MM:SS}':   _formatTime(now, 'HH:MM:SS'),
    '{time:HH:MM}':      _formatTime(now, 'HH:MM'),
    '{dayofweek}':       _DAYS[now.getDay()],
  };

  // ── 3. Apply all replacements to plain text ───────────────────────────────
  let text = plainText;
  // Fill-ins first
  text = text.replace(/\{fillIn:([^}]+)\}/g, (_, lbl) => fillInValues[lbl] ?? '');
  // Deterministic tokens
  for (const [tok, val] of Object.entries(replMap)) {
    text = text.split(tok).join(val);
  }

  // ── 4. Extract {cursor} position ─────────────────────────────────────────
  let cursorBack = 0;
  const cursorIdx = text.indexOf('{cursor}');
  if (cursorIdx !== -1) {
    cursorBack = text.length - cursorIdx - '{cursor}'.length;
    text = text.replace('{cursor}', '');
  }

  // ── 5. Apply replacements to HTML (replace token <span> chips) ───────────
  let html = htmlContent || null;
  if (html) {
    html = html.replace(
      /<span[^>]*\bdata-token="([^"]*)"[^>]*>.*?<\/span>/g,
      (_, tok) => {
        // Fill-in
        if (tok.startsWith('{fillIn:')) {
          return fillInValues[tok.slice(8, -1)] ?? '';
        }
        // Cursor chip → empty (position already tracked via plain text)
        if (tok === '{cursor}') return '';
        // Clipboard — escape HTML special chars in the pasted value
        if (tok === '{clipboard}') {
          return clipText
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        return replMap[tok] ?? tok;
      }
    );
  }

  return { text, html, cursorBack };
}

// ─────────────────────────────────────────────
// TEXT EXPANSION EXECUTOR
// ─────────────────────────────────────────────
async function executeExpansion(trigger, plainText, htmlContent, deleteExtra = true) {
  if (!nutjsAvailable) {
    console.warn('[KeyForge] nut-js required for text expansion');
    return;
  }
  if (!plainText) return;

  const { Key } = nutjs;

  // Resolve dynamic tokens if any are present
  const hasTokens = /\{[a-zA-Z]/.test(plainText);
  let text = plainText;
  let html  = htmlContent || null;
  let cursorBack = 0;

  if (hasTokens) {
    try {
      console.log('[KeyForge] resolving tokens for:', plainText.slice(0, 80));
      const resolved = await _resolveTokens(plainText, htmlContent);
      if (resolved.cancelled) {
        console.log('[KeyForge] expansion aborted (fill-in cancelled)');
        return;
      }
      ({ text, html, cursorBack } = resolved);
      console.log('[KeyForge] tokens resolved, final text:', text.slice(0, 80));
      // After fill-in dialogs, allow time for Windows to complete the focus
      // transfer that SetForegroundWindow initiated in the submit handler.
      if (/\{fillIn:/.test(plainText)) {
        console.log('[KeyForge] fill-in closed — waiting 200ms for focus transfer...');
        await new Promise(r => setTimeout(r, 200));
        const fgAtPaste = koffiAvailable && koffiGetForegroundWindow ? koffiGetForegroundWindow() : 0n;
        console.log(`[KeyForge] proceeding with paste — fg at paste time: 0x${fgAtPaste.toString(16)}`);
      }
    } catch (e) {
      console.error('[KeyForge] Token resolution error:', e.message);
      text = plainText;
      html = htmlContent || null;
    }
  }

  if (!text && cursorBack === 0) return; // nothing to paste after token removal

  // Delete the trigger word (plus the space that triggered it, if applicable)
  const deleteCount = trigger.length + (deleteExtra ? 1 : 0);
  for (let i = 0; i < deleteCount; i++) {
    await nutjs.keyboard.pressKey(Key.Backspace);
    await nutjs.keyboard.releaseKey(Key.Backspace);
  }

  // Write both formats simultaneously — rich-text apps use the HTML.
  // Use Shift+Insert instead of Ctrl+V to avoid CAD apps intercepting Ctrl+V
  // as their own paste command (e.g. BricsCAD _PASTCLIP).
  const prevText = clipboard.readText();
  const prevHtml = clipboard.readHTML();
  clipboard.write({ text, html: html || text });
  await nutjs.keyboard.pressKey(Key.LeftShift, Key.Insert);
  await nutjs.keyboard.releaseKey(Key.LeftShift, Key.Insert);
  await new Promise(r => setTimeout(r, 500));
  clipboard.write({ text: prevText, html: prevHtml });

  // Move cursor to {cursor} position if needed
  if (cursorBack > 0) {
    await new Promise(r => setTimeout(r, 50));
    for (let i = 0; i < cursorBack; i++) {
      await nutjs.keyboard.pressKey(Key.Left);
      await nutjs.keyboard.releaseKey(Key.Left);
    }
  }

  const preview = text.length > 24 ? text.slice(0, 24) + '…' : text;
  mainWindow?.webContents.send('macro-fired', { label: `→ ${preview}`, type: 'expansion' });
}

// ─────────────────────────────────────────────
// UIOHOOK LISTENER
// ─────────────────────────────────────────────
function startHotkeyListener() {
  if (!uiohookAvailable || !uiohook) return;

  uiohook.removeAllListeners('keydown');
  uiohook.removeAllListeners('keyup');
  uiohook.removeAllListeners('mousedown');
  uiohook.removeAllListeners('wheel');

  // ── Diagnostic: track keycodes that never appear in UIOHOOK_KEY_MAP ──
  uiohook.on('keydown', (event) => {
    const keyId = UIOHOOK_KEY_MAP[event.keycode];
    if (!keyId) return;

    // Update modifier state (return early — modifiers don't trigger macros alone)
    // Also clear the expansion buffer: on ARM64, uiohook can deliver modifier
    // keydown events *after* the character keydown, so a character can leak into
    // the buffer before we know a modifier is held.  Clearing on modifier-down
    // prevents that leaked character from ever triggering an expansion.
    if (keyId === 'ControlLeft' || keyId === 'ControlRight') { modifierState.ctrl  = true; keypressBuffer = ''; return; }
    if (keyId === 'AltLeft'     || keyId === 'AltRight')     { modifierState.alt   = true; keypressBuffer = ''; return; }
    if (keyId === 'ShiftLeft'   || keyId === 'ShiftRight')   { modifierState.shift = true; keypressBuffer = ''; return; }
    if (keyId === 'MetaLeft'    || keyId === 'MetaRight')    { modifierState.meta  = true; keypressBuffer = ''; return; }
    if (MODIFIER_KEY_IDS.has(keyId)) return;

    // Hotkey recording mode — capture modifiers + key, send to renderer, suppress macro
    if (_isRecordingHotkey) {
      _isRecordingHotkey = false;
      const recMods = [];
      if (modifierState.ctrl)  recMods.push('Ctrl');
      if (modifierState.shift) recMods.push('Shift');
      if (modifierState.alt)   recMods.push('Alt');
      if (modifierState.meta)  recMods.push('Win');
      console.log(`[KeyForge] Hotkey recorded: [${recMods.join('+')}] + ${keyId}`);
      mainWindow?.webContents.send('hotkey-recorded',
        keyId === 'Escape' ? null : { modifiers: recMods, keyId }
      );
      return;
    }

    // Stand down while a KeyForge input / textarea / contenteditable is focused.
    // This lets Ctrl+A, Ctrl+C, Ctrl+V and any other shortcuts work natively
    // inside the app's own UI without being intercepted at the hook level.
    if (appInputFocused) return;

    // Combo order matches UI comboString(): Ctrl, Shift, Alt, Win
    const heldMods = [];
    if (modifierState.ctrl)  heldMods.push('Ctrl');
    if (modifierState.shift) heldMods.push('Shift');
    if (modifierState.alt)   heldMods.push('Alt');
    if (modifierState.meta)  heldMods.push('Win');

    // Text expansion buffer — only track bare keypresses (no modifiers held)
    if (heldMods.length === 0) {
      // ── Bare key assignments (app-linked profiles only) ──────────────────
      // Check before the text expansion buffer so a bare assignment takes
      // full priority and suppresses the key before any character is buffered.
      if (macrosEnabled) {
        const linkedApp = profileSettings[activeProfile]?.linkedApp;
        // Fire bare key macros whenever the active profile has a linked app,
        // UNLESS KeyForge itself is currently the foreground process.
        // The profile auto-switch already ensures we're in the linked app when
        // the profile is active — no need to re-check the exact process name here.
        if (linkedApp && !_SELF_PROC_NAMES.has(currentFgProc)) {
          const bareStorageKey = `${activeProfile}::BARE::${keyId}`;
          // If OS-level suppression is active for this key, skip — WM_HOTKEY will fire it.
          if (storageKeyToHotkeyId.has(bareStorageKey)) return;
          const bareMacro = activeAssignments[bareStorageKey];
          if (bareMacro) {
            // uiohook-napi v1.5.4 has no suppression API — the character
            // always leaks to the active app.  executeMacro will erase it
            // with a Backspace before injecting macro output.
            lastKeySuppressed = false;
            keypressBuffer = '';
            pendingMacroIsBare = true;
            pendingMacro = bareMacro;
            console.log(`[KeyForge] Bare key match: ${keyId} → [${bareMacro.type}] ${bareMacro.label} (char will be erased)`);
            return;
          }
        }
      }

      if (keyId === 'Backspace') {
        keypressBuffer = keypressBuffer.slice(0, -1);
      } else if (keyId === 'Space') {
        if (macrosEnabled && keypressBuffer.length > 0) {
          const bufferLower = keypressBuffer.toLowerCase();
          // 1. Custom autocorrect (takes priority)
          const acKey = `GLOBAL::AUTOCORRECT::${bufferLower}`;
          const acEntry = activeAssignments[acKey];
          if (acEntry) {
            console.log(`[KeyForge] Autocorrect (custom): "${bufferLower}" → "${acEntry.data?.correction}"`);
            executeExpansion(bufferLower, (acEntry.data?.correction || '') + ' ', null).catch(console.error);
          // 2. Built-in autocorrect (if enabled)
          } else if (autocorrectEnabled && BUILTIN_TYPOS[bufferLower]) {
            const correction = BUILTIN_TYPOS[bufferLower];
            console.log(`[KeyForge] Autocorrect (built-in): "${bufferLower}" → "${correction}"`);
            executeExpansion(bufferLower, correction + ' ', null).catch(console.error);
          // 3. Text expansion (space-triggered only — immediate-mode expansions are
          //    handled after each keypress and should not also fire on Space)
          } else {
            const expansionKey = `GLOBAL::EXPANSION::${bufferLower}`;
            const expansion = activeAssignments[expansionKey];
            if (expansion) {
              if (expansion.data?.triggerMode === 'immediate') {
                console.log(`[KeyForge] Skipping immediate expansion "${bufferLower}" on Space — should have fired already`);
              } else {
                console.log(`[KeyForge] Expansion: "${bufferLower}" → "${expansion.data?.text}"`);
                executeExpansion(bufferLower, expansion.data?.text, expansion.data?.html).catch(console.error);
              }
            }
          }
        }
        keypressBuffer = '';
      } else if (keyId === 'Enter' || keyId === 'Escape' || keyId === 'Tab') {
        keypressBuffer = '';
      } else if (KEY_CHAR_MAP[keyId]) {
        keypressBuffer += KEY_CHAR_MAP[keyId];
        if (keypressBuffer.length > MAX_BUFFER_LENGTH) {
          keypressBuffer = keypressBuffer.slice(-MAX_BUFFER_LENGTH);
        }
        // Scan for immediate-mode triggers (longest match first)
        if (macrosEnabled) {
          const bufLower = keypressBuffer.toLowerCase();
          const immediateTriggers = Object.entries(activeAssignments)
            .filter(([k, v]) => k.startsWith('GLOBAL::EXPANSION::') && v.data?.triggerMode === 'immediate')
            .map(([k, v]) => ({ trigger: k.slice('GLOBAL::EXPANSION::'.length), v }))
            .sort((a, b) => b.trigger.length - a.trigger.length);
          console.log(
            `[KeyForge] Buffer: "${bufLower}" | Immediate triggers: [${
              immediateTriggers.map(t => `"${t.trigger}"`).join(', ') || 'none'
            }]`
          );
          let fired = false;
          for (const { trigger, v } of immediateTriggers) {
            console.log(`[KeyForge]   Checking: "${bufLower}".endsWith("${trigger}") = ${bufLower.endsWith(trigger)}`);
            if (bufLower.endsWith(trigger)) {
              console.log(`[KeyForge] ✓ Expansion (immediate): "${trigger}" → "${v.data?.text}"`);
              keypressBuffer = '';
              executeExpansion(trigger, v.data?.text, v.data?.html, false).catch(console.error);
              fired = true;
              break;
            }
          }
          if (!fired && immediateTriggers.length === 0) {
            // Only log at full words to avoid spamming; skip single-char buffers
            if (bufLower.length > 1) {
              console.log(`[KeyForge] No immediate triggers defined — buffer: "${bufLower}"`);
            }
          }
        }
      }
      return; // bare keypress — no modifier combo to check
    }

    const comboStr = heldMods.join('+');
    const storageKey = `${activeProfile}::${comboStr}::${keyId}`;
    // If OS-level suppression is active for this combo, skip — WM_HOTKEY will fire it.
    // EXCEPTION: Backquote — hookWindowMessage / WM_HOTKEY is unreliable for this key
    // on ARM64 Windows (the callback never fires despite registration succeeding).
    // Backquote combos are always handled directly via the uiohook path instead.
    if (storageKeyToHotkeyId.has(storageKey) && keyId !== 'Backquote') {
      return;
    }
    const macro = activeAssignments[storageKey];

    if (macro && macrosEnabled) {
      // uiohook-napi v1.5.4 has no suppression API — lastKeySuppressed stays false.
      // Modifier-combo triggers don't leak a WM_CHAR (the modifier prevents it), so
      // no Backspace erase is needed for Ctrl/Shift/Alt/Win combos.
      // AltGr (Ctrl+Alt) is the exception — it generates a Unicode char even with
      // modifiers held, handled by pendingMacroAltGr + Backspace in executeMacro.
      lastKeySuppressed = false;
      keypressBuffer = '';
      logForegroundApp(); // async, best-effort

      // Backquote combos are fired via uiohook (WM_HOTKEY unreliable on ARM64).
      // The ` character can leak into the target app before the modifier is
      // detected, so treat it like a bare key and erase with Backspace.
      pendingMacroIsBare = (keyId === 'Backquote');

      // ── Capture AltGr state NOW — modifierState will be clear by execution time ──
      // executeMacro runs only after all modifiers are physically released (keyup),
      // so checking modifierState inside executeMacro always sees false.  Snapshot it here.
      pendingMacroAltGr = modifierState.ctrl && modifierState.alt;

      // ── Proactive AltGr flush ───────────────────────────────────────────
      // Ctrl+Alt is treated as AltGr by Windows.  Even when the trigger keydown
      // is suppressed at the LL hook level, some applications have already built
      // up AltGr dead-key state from the Ctrl+Alt key-downs (which we do not
      // suppress).  Injecting synthetic modifier key-ups via SendInput immediately
      // clears this state from the Windows input queue before the target app can
      // generate the Unicode character (é, á, etc.).
      // setImmediate fires on the very next event-loop tick — as early as possible
      // after the keydown callback returns, so the injection races ahead of any
      // WM_CHAR the foreground app might generate.
      if (pendingMacroAltGr && nutjsAvailable && nutjs) {
        setImmediate(() => {
          nutjs.keyboard.releaseKey(nutjs.Key.LeftControl, nutjs.Key.LeftAlt).catch(() => {});
        });
      }

      // ── Defer execution until modifier keys are physically released ────
      // Execution happens in the keyup handler once modifierState is fully
      // clear, so output is sent only after the user's fingers are off the
      // trigger keys.
      if (pendingMacro) {
        console.warn(`[KeyForge] Replacing unexecuted pending macro: [${pendingMacro.type}] ${pendingMacro.label}`);
      }
      console.log(`[KeyForge] Match: ${comboStr}+${keyId} — deferred until modifiers released`);

      // ── Keydown-time double-tap detection ────────────────────────────────
      // Enables "hold modifier, tap key twice" without releasing the modifier.
      // Also works when modifier is released between taps by cancelling any
      // pending single-tap timer started by dispatchHotkeyWithDoubleTap.
      const doubleMacroKd = activeAssignments[storageKey + '::double'];
      if (doubleMacroKd) {
        const nowKd  = Date.now();
        const lastKd = lastHotkeyTime.get(storageKey) || 0;
        if (nowKd - lastKd < doubleTapWindow && lastHotkeyTime.has(storageKey)) {
          // Second tap within window — resolve as double immediately at keydown
          if (pendingHotkeyTimer.has(storageKey)) {
            clearTimeout(pendingHotkeyTimer.get(storageKey));
            pendingHotkeyTimer.delete(storageKey);
          }
          lastHotkeyTime.delete(storageKey);
          console.log(`[KeyForge] ×2 Keydown double-tap: ${storageKey}`);
          pendingMacro           = doubleMacroKd;
          pendingMacroStorageKey = null; // null → executeMacro directly at keyup (no timer)
        } else {
          // First tap — record time so second keydown can detect the window
          lastHotkeyTime.set(storageKey, nowKd);
          pendingMacro           = macro;
          pendingMacroStorageKey = storageKey;
        }
      } else {
        pendingMacro           = macro;
        pendingMacroStorageKey = storageKey;
      }
    }
  });

  uiohook.on('keyup', (event) => {
    const keyId = UIOHOOK_KEY_MAP[event.keycode];
    if (!keyId) return;
    if (keyId === 'ControlLeft' || keyId === 'ControlRight') modifierState.ctrl  = false;
    if (keyId === 'AltLeft'     || keyId === 'AltRight')     modifierState.alt   = false;
    if (keyId === 'ShiftLeft'   || keyId === 'ShiftRight')   modifierState.shift = false;
    if (keyId === 'MetaLeft'    || keyId === 'MetaRight')    modifierState.meta  = false;

    // Execute the deferred macro once every modifier key has been physically
    // released.  This guarantees no held physical key interferes with output.
    if (
      pendingMacro &&
      !modifierState.ctrl && !modifierState.alt &&
      !modifierState.shift && !modifierState.meta
    ) {
      const macro      = pendingMacro;
      const storageKey = pendingMacroStorageKey;
      pendingMacro           = null;
      pendingMacroStorageKey = null;
      console.log(`[KeyForge] ▶ Deferred ready: [${macro.type}] ${macro.label}`);
      dispatchHotkeyWithDoubleTap(storageKey, macro);
    }
  });

  // ── Mouse button assignments ───────────────────────────────────────────
  const MOUSE_BUTTON_MAP = {
    1: 'MOUSE_LEFT',
    2: 'MOUSE_RIGHT',
    3: 'MOUSE_MIDDLE',
    4: 'MOUSE_SIDE1',
    5: 'MOUSE_SIDE2',
  };

  uiohook.on('mousedown', (event) => {
    if (appInputFocused) return;
    const mouseKeyId = MOUSE_BUTTON_MAP[event.button];
    if (!mouseKeyId) return;

    const heldMods = [];
    if (modifierState.ctrl)  heldMods.push('Ctrl');
    if (modifierState.shift) heldMods.push('Shift');
    if (modifierState.alt)   heldMods.push('Alt');
    if (modifierState.meta)  heldMods.push('Win');
    if (heldMods.length === 0) {
      // Bare mouse assignments — allowed for middle/side/scroll, never left/right
      const BARE_MOUSE_ALLOWED = new Set(['MOUSE_MIDDLE', 'MOUSE_SIDE1', 'MOUSE_SIDE2']);
      if (macrosEnabled && BARE_MOUSE_ALLOWED.has(mouseKeyId)) {
        const linkedApp = profileSettings[activeProfile]?.linkedApp;
        if (linkedApp && !_SELF_PROC_NAMES.has(currentFgProc)) {
          const bareStorageKey = `${activeProfile}::BARE::${mouseKeyId}`;
          const bareMacro = activeAssignments[bareStorageKey];
          if (bareMacro) {
            if (typeof event.preventDefault === 'function') {
              event.preventDefault();
              lastKeySuppressed = true;
              console.log(`[KeyForge] ✓ Suppressed bare mouse: ${mouseKeyId}`);
            }
            keypressBuffer = '';
            pendingMacroIsBare = false;
            console.log(`[KeyForge] Bare mouse match: ${mouseKeyId} → [${bareMacro.type}] ${bareMacro.label}`);
            executeMacro(bareMacro).catch(console.error);
          }
        }
      }
      return;
    }

    const comboStr   = heldMods.join('+');
    const storageKey = `${activeProfile}::${comboStr}::${mouseKeyId}`;
    const macro      = activeAssignments[storageKey];

    if (macro && macrosEnabled) {
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
        lastKeySuppressed = true;
        console.log(`[KeyForge] ✓ Suppressed mouse: ${comboStr}+${mouseKeyId}`);
      } else {
        lastKeySuppressed = false;
      }
      keypressBuffer = '';
      if (pendingMacro) {
        console.warn(`[KeyForge] Replacing unexecuted pending macro: [${pendingMacro.type}] ${pendingMacro.label}`);
      }
      console.log(`[KeyForge] Match: ${comboStr}+${mouseKeyId} — deferred until modifiers released`);
      pendingMacro = macro;
    }
  });

  uiohook.on('wheel', (event) => {
    if (appInputFocused) return;

    const heldMods = [];
    if (modifierState.ctrl)  heldMods.push('Ctrl');
    if (modifierState.shift) heldMods.push('Shift');
    if (modifierState.alt)   heldMods.push('Alt');
    if (modifierState.meta)  heldMods.push('Win');
    // rotation < 0 = scroll up, > 0 = scroll down (uiohook-napi convention)
    const wheelKeyId = (event.rotation < 0) ? 'MOUSE_SCROLL_UP' : 'MOUSE_SCROLL_DOWN';

    if (heldMods.length === 0) {
      // Bare scroll assignments (app-linked profiles only)
      if (macrosEnabled) {
        const linkedApp = profileSettings[activeProfile]?.linkedApp;
        if (linkedApp && !_SELF_PROC_NAMES.has(currentFgProc)) {
          const bareStorageKey = `${activeProfile}::BARE::${wheelKeyId}`;
          const bareMacro = activeAssignments[bareStorageKey];
          if (bareMacro) {
            if (typeof event.preventDefault === 'function') {
              event.preventDefault();
              console.log(`[KeyForge] ✓ Suppressed bare wheel: ${wheelKeyId}`);
            }
            keypressBuffer = '';
            console.log(`[KeyForge] Bare wheel match: ${wheelKeyId} → [${bareMacro.type}] ${bareMacro.label}`);
            executeMacro(bareMacro).catch(console.error);
          }
        }
      }
      return;
    }

    const comboStr   = heldMods.join('+');
    const storageKey = `${activeProfile}::${comboStr}::${wheelKeyId}`;
    const macro      = activeAssignments[storageKey];

    if (macro && macrosEnabled) {
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
        console.log(`[KeyForge] ✓ Suppressed wheel: ${comboStr}+${wheelKeyId}`);
      }
      keypressBuffer = '';
      console.log(`[KeyForge] ▶ Executing wheel macro: [${macro.type}] ${macro.label}`);
      executeMacro(macro).catch(console.error);
    }
  });

  try {
    uiohook.start();
    console.log('[KeyForge] Hotkey listener started ✓');
  } catch (e) {
    console.error('[KeyForge] Failed to start uiohook:', e.message);
  }
}

function stopHotkeyListener() {
  if (!uiohookAvailable || !uiohook) return;
  try {
    uiohook.stop();
    console.log('[KeyForge] Hotkey listener stopped');
  } catch (e) {
    console.error('[KeyForge] Failed to stop uiohook:', e.message);
  }
}

// ─────────────────────────────────────────────
// FOREGROUND WINDOW WATCHER (Windows only)
// Uses a setInterval + native koffi Win32 calls in-process.
// GetForegroundWindow() fires every 1500 ms (one cheap syscall).
// GetWindowThreadProcessId / OpenProcess / QueryFullProcessImageNameW only
// run when the HWND actually changes — i.e. when the user switches apps.
// This replaces a persistent PowerShell subprocess that called Get-Process
// (iterates all system processes) every 500 ms, causing continuous CPU drain.
// ─────────────────────────────────────────────

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

let fgWatcher     = null;  // setInterval handle
let _lastFgHwnd   = 0n;    // last seen HWND — skip expensive lookup when unchanged
let currentFgProc = '';    // lowercase, .exe-stripped — updated by handleForegroundChange

// Resolve a foreground HWND to a process base name (no extension, lowercase).
// Only called when the HWND has changed from the previous tick.
function _getFgProcName(hwnd) {
  if (!koffiGetWindowThreadProcessId || !koffiOpenProcess ||
      !koffiQueryFullProcessImageNameW || !koffiCloseHandle) return '';
  try {
    const pidBuf = Buffer.alloc(4);
    koffiGetWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    if (!pid) return '';

    const hProc = koffiOpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!hProc) return '';
    try {
      const MAX_PATH  = 260;
      const nameBuf   = Buffer.alloc(MAX_PATH * 2); // UTF-16LE, 2 bytes per char
      const sizeBuf   = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(MAX_PATH, 0);
      const ok = koffiQueryFullProcessImageNameW(hProc, 0, nameBuf, sizeBuf);
      if (!ok) return '';
      const len      = sizeBuf.readUInt32LE(0);
      const fullPath = nameBuf.slice(0, len * 2).toString('utf16le');
      return path.basename(fullPath, '.exe').toLowerCase();
    } finally {
      koffiCloseHandle(hProc);
    }
  } catch (e) {
    return '';
  }
}

// Process names that identify KeyForge itself (dev: electron, packaged: exe stem).
const _SELF_PROC_NAMES = new Set([
  'electron',
  path.basename(app.getPath('exe'), '.exe').toLowerCase(),
]);

function handleForegroundChange(procName) {
  if (!mainWindow) return;

  const name = procName.toLowerCase().replace(/\.exe$/i, '');

  // Always track the current foreground process (even when it's KeyForge itself)
  currentFgProc = name;

  // Never auto-switch when KeyForge itself is the focused application.
  if (_SELF_PROC_NAMES.has(name)) return;

  // No-op when no profiles have a linked app configured
  const linked = Object.entries(profileSettings).filter(([, s]) => s.linkedApp);
  if (linked.length === 0) return;

  let matched = null;
  for (const [profile, settings] of linked) {
    const appName = path.basename(settings.linkedApp, '.exe').toLowerCase();
    if (name === appName) { matched = profile; break; }
  }

  const target = matched || activeGlobalProfile;
  const profileChanged = (target !== activeProfile);

  if (profileChanged) {
    activeProfile = target;
    mainWindow.webContents.send('profile-switched', { profile: target });
    console.log(`[KeyForge] ⟳ Auto-switched to profile "${target}" (foreground: ${procName})`);
    // Re-register modifier hotkeys for the newly active profile — only when not paused
    if (koffiAvailable && macrosEnabled) registerModifierHotkeys();
  }

  // Bare-key OS registrations — register when linked app is foreground, unregister otherwise.
  // _registerHotkey is idempotent so calling registerBareKeys() on every 500ms poll is safe.
  // Skip entirely while paused — applyMacrosPause already unregistered everything.
  if (koffiAvailable && macrosEnabled) {
    if (matched) registerBareKeys();
    else         unregisterBareKeys();
  }
}

function startFgWatcher() {
  if (process.platform !== 'win32' || fgWatcher || !koffiAvailable) return;
  fgWatcher = setInterval(() => {
    try {
      const hwnd = koffiGetForegroundWindow();
      if (!hwnd || hwnd === _lastFgHwnd) return; // no change — skip expensive lookup
      _lastFgHwnd = hwnd;
      const name = _getFgProcName(hwnd);
      if (name) handleForegroundChange(name);
    } catch (e) { /* ignore transient API errors */ }
  }, 1500);
  console.log('[KeyForge] Foreground watcher started (native koffi, 1500ms) ✓');
}

function stopFgWatcher() {
  if (fgWatcher) {
    clearInterval(fgWatcher);
    fgWatcher   = null;
    _lastFgHwnd = 0n;
  }
}

// ─────────────────────────────────────────────
// STARTUP REGISTRY (Windows only)
// ─────────────────────────────────────────────
const REG_RUN  = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_NAME = 'Trigr';

function getStartupEnabled(callback) {
  if (process.platform !== 'win32' || !app.isPackaged) return callback(false);
  exec(`reg query "${REG_RUN}" /v "${REG_NAME}" 2>nul`, (_err, stdout) =>
    callback(stdout.includes(REG_NAME))
  );
}

function setStartupEnabled(enable) {
  if (process.platform !== 'win32') return;
  if (enable) {
    exec(`reg add "${REG_RUN}" /v "${REG_NAME}" /d "${process.execPath}" /f`);
  } else {
    exec(`reg delete "${REG_RUN}" /v "${REG_NAME}" /f 2>nul`);
  }
}

// ─────────────────────────────────────────────
// TRAY
// ─────────────────────────────────────────────
function showWindow() {
  if (mainWindow) {
    mainWindow.webContents.setBackgroundThrottling(false);
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function hideWindowToTray() {
  if (!mainWindow) return;
  mainWindow.webContents.setBackgroundThrottling(true);
  mainWindow.hide();
  if (!hasShownBalloon && tray && process.platform === 'win32') {
    hasShownBalloon = true;
    tray.displayBalloon({
      title:    'Trigr',
      content:  'Trigr is still running in the background. Your macros are active.',
      iconType: 'info',
    });
  }
}

function buildTrayMenu() {
  getStartupEnabled((startupOn) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open Trigr',
        click: showWindow,
      },
      { type: 'separator' },
      {
        label: macrosEnabled ? '⏸ Pause Trigr' : '▶ Resume Trigr',
        click: () => {
          applyMacrosPause(macrosEnabled);
        },
      },
      { type: 'separator' },
      {
        label:   'Start with Windows',
        type:    'checkbox',
        checked: startupOn,
        click:   (item) => {
          setStartupEnabled(item.checked);
          buildTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Trigr',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(menu);
  });
}

function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.png')
    : path.join(__dirname, '..', 'public', 'app-icon.png');

  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Trigr — Macro Engine Active'); // updateTrayTooltip() called after tray is set
  tray.on('click', showWindow);
  buildTrayMenu();
  console.log('[KeyForge] System tray created ✓');
}

// ─────────────────────────────────────────────
// IPC HANDLERS
// ─────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
});
ipcMain.on('window-close', () => hideWindowToTray());

// Config load/save
ipcMain.handle('load-config', () => {
  const { config, restoredFrom } = loadConfigSafe();
  if (config) {
    if (!restoredFrom) {
      // Healthy load — create a timestamped backup snapshot
      createTimestampedBackup(config);
    } else {
      // We fell back to a backup — write it back as the main config so future
      // loads work normally, then update last-known-good with the recovered data.
      saveConfig(config);
      updateLastKnownGood(config);
    }
    return { ...config, _restoredFrom: restoredFrom || null };
  }
  return null;
});
ipcMain.handle('save-config', (event, config) => {
  // Always load existing config first so that partial saves (e.g. { numpadOpen: true }
  // or { tipsHidden: true }) only update their specific fields and never wipe the rest.
  const existing = loadConfig() || {};
  const merged = {
    ...existing,
    ...config,
    globalInputMethod:        config.globalInputMethod        ?? existing.globalInputMethod        ?? globalInputMethod,
    keystrokeDelay:           config.keystrokeDelay           ?? existing.keystrokeDelay           ?? keystrokeDelay,
    macroTriggerDelay:        config.macroTriggerDelay        ?? existing.macroTriggerDelay        ?? macroTriggerDelay,
    doubleTapWindow:          config.doubleTapWindow          ?? existing.doubleTapWindow          ?? doubleTapWindow,
    searchOverlayHotkey:      config.searchOverlayHotkey      ?? existing.searchOverlayHotkey      ?? searchOverlayHotkey,
    overlayShowAll:           config.overlayShowAll           ?? existing.overlayShowAll,
    overlayCloseAfterFiring:  config.overlayCloseAfterFiring  ?? existing.overlayCloseAfterFiring,
    overlayIncludeAutocorrect:config.overlayIncludeAutocorrect?? existing.overlayIncludeAutocorrect,
  };
  if (isSignificantChange(config, existing)) {
    createTimestampedBackup(existing);
  }
  const ok = saveConfig(merged);
  if (ok) updateLastKnownGood(merged);
  return ok;
});

// UI tells us assignments changed (after any assign/clear/profile switch)
ipcMain.on('update-assignments', (event, { assignments, profile }) => {
  activeAssignments = assignments || {};
  activeProfile = profile || 'Default';
  const allKeys = Object.keys(activeAssignments);
  const expansionKeys = allKeys.filter(k => k.startsWith('GLOBAL::EXPANSION::'));
  const immediateCount = expansionKeys.filter(k => activeAssignments[k]?.data?.triggerMode === 'immediate').length;
  const spaceCount     = expansionKeys.filter(k => activeAssignments[k]?.data?.triggerMode !== 'immediate').length;
  console.log(
    `[KeyForge] Assignments updated — profile: ${activeProfile}, ` +
    `total keys: ${allKeys.length}, ` +
    `expansions: ${expansionKeys.length} (${immediateCount} immediate, ${spaceCount} space/default)`
  );
  if (immediateCount > 0) {
    const triggers = expansionKeys
      .filter(k => activeAssignments[k]?.data?.triggerMode === 'immediate')
      .map(k => k.slice('GLOBAL::EXPANSION::'.length));
    console.log(`[KeyForge] Immediate triggers loaded: [${triggers.join(', ')}]`);
  }
  // Restart listener so new assignments take effect immediately
  stopHotkeyListener();
  startHotkeyListener();
  // Re-register OS-level hotkeys for the updated assignments — only when not paused
  if (macrosEnabled) {
    registerModifierHotkeys();
  }
  // Re-register bare keys if the linked app is currently foreground — only when not paused
  if (koffiAvailable && macrosEnabled) {
    unregisterBareKeys();
    const linkedApp = profileSettings[activeProfile]?.linkedApp;
    if (linkedApp) {
      const appBaseName = path.basename(linkedApp, '.exe').toLowerCase();
      if (currentFgProc === appBaseName) registerBareKeys();
    }
  }
});

// Renderer changed the active global profile (the fallback when no app-specific profile matches)
ipcMain.on('set-active-global-profile', (event, newGlobalProfile) => {
  activeGlobalProfile = newGlobalProfile || 'Default';
  console.log(`[KeyForge] Active global profile set to "${activeGlobalProfile}"`);
  // If no app-specific profile is currently overriding, switch to the new global profile now
  const currentIsAppSpecific = !!profileSettings[activeProfile]?.linkedApp;
  if (!currentIsAppSpecific && activeProfile !== activeGlobalProfile) {
    activeProfile = activeGlobalProfile;
    if (mainWindow) {
      mainWindow.webContents.send('profile-switched', { profile: activeProfile, profileSettings });
    }
    stopHotkeyListener();
    startHotkeyListener();
    if (macrosEnabled) registerModifierHotkeys();
    updateTrayTooltip();
  }
});

// Toggle macros on/off
ipcMain.on('toggle-macros', (event, enabled) => {
  applyMacrosPause(!enabled);
});

// Input focus — renderer tells us when a text field is active so we stand down
ipcMain.on('input-focus-changed', (_event, focused) => {
  appInputFocused = !!focused;
});

// Hotkey recording — next non-modifier keypress is captured and sent back
ipcMain.on('start-hotkey-recording', () => {
  _isRecordingHotkey = true;
  console.log('[KeyForge] Hotkey recording started — waiting for keypress');
});
ipcMain.on('stop-hotkey-recording', () => {
  _isRecordingHotkey = false;
  console.log('[KeyForge] Hotkey recording cancelled');
});

// Autocorrect toggle
ipcMain.on('update-autocorrect-enabled', (_event, enabled) => {
  autocorrectEnabled = !!enabled;
  console.log(`[KeyForge] Autocorrect ${autocorrectEnabled ? '✓ enabled' : '✗ disabled'}`);
});

// Profile settings (app-linking, etc.)
ipcMain.on('update-profile-settings', (event, settings) => {
  profileSettings = settings || {};
  console.log(`[KeyForge] Profile settings updated — ${Object.keys(profileSettings).length} profile(s) with settings`);
});

// Global compatibility settings (input method, timing)
ipcMain.on('update-global-settings', (_event, settings) => {
  if (settings.globalInputMethod  !== undefined) globalInputMethod  = settings.globalInputMethod;
  if (settings.keystrokeDelay     !== undefined) keystrokeDelay     = Math.max(0, Math.min(500, settings.keystrokeDelay));
  if (settings.macroTriggerDelay  !== undefined) macroTriggerDelay  = Math.max(0, Math.min(500, settings.macroTriggerDelay));
  if (settings.doubleTapWindow    !== undefined) doubleTapWindow    = Math.max(150, Math.min(500, settings.doubleTapWindow));
  // Persist to config immediately by merging with current config file
  const existing = loadConfig() || {};
  saveConfig({ ...existing, globalInputMethod, keystrokeDelay, macroTriggerDelay, doubleTapWindow });
  console.log(`[KeyForge] Global settings: inputMethod=${globalInputMethod}, keystrokeDelay=${keystrokeDelay}ms, triggerDelay=${macroTriggerDelay}ms, doubleTapWindow=${doubleTapWindow}ms`);
});

// ── Quick Search overlay IPC ────────────────────────────────────────
ipcMain.on('close-overlay', () => {
  hideOverlay();
  // Restore focus so the user is seamlessly returned to what they were doing
  if (koffiAvailable && koffiSetForegroundWindow && _searchTargetHwnd) {
    koffiSetForegroundWindow(_searchTargetHwnd);
    console.log(`[KeyForge] search overlay closed: restored focus to 0x${_searchTargetHwnd.toString(16)}`);
  }
});

ipcMain.on('overlay-resize', (_event, { height }) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setSize(600, Math.max(72, Math.min(480, Math.round(height))));
  }
});

ipcMain.on('execute-search-result', async (_event, result) => {
  hideOverlay();
  if (!macrosEnabled) return;

  // Restore focus to the app that was active when the search hotkey fired.
  // Must happen before the delay so Windows has maximum lead time to transfer focus.
  if (koffiAvailable && koffiSetForegroundWindow && _searchTargetHwnd) {
    const ok    = koffiSetForegroundWindow(_searchTargetHwnd);
    const fgNow = koffiGetForegroundWindow?.() ?? 0n;
    console.log(`[KeyForge] search: SetForegroundWindow(0x${_searchTargetHwnd.toString(16)}) → ${ok}, fg now: 0x${fgNow.toString(16)}`);
  }

  // Wait for Windows to complete the focus transfer before sending output
  await new Promise(r => setTimeout(r, 180));
  const fgAtFire = koffiAvailable && koffiGetForegroundWindow ? koffiGetForegroundWindow() : 0n;
  console.log(`[KeyForge] search: fg at macro fire: 0x${fgAtFire.toString(16)}`);

  if (result.type === 'assignment') {
    const macro = activeAssignments[result.storageKey];
    if (!macro) return;
    // Prime _macroTargetHwnd with our captured HWND so executeMacro's own
    // SetForegroundWindow call targets the right window even if focus is still settling
    if (_searchTargetHwnd) _macroTargetHwnd = _searchTargetHwnd;
    pendingMacroIsBare = false;
    pendingMacroAltGr  = false;
    executeMacro(macro).then(() => {
      mainWindow?.webContents.send('overlay-fired', { label: result.label || macro.label });
    }).catch(console.error);

  } else if (result.type === 'expansion') {
    if (!result.text) return;
    // Route through the complete expansion pipeline so rich text, dynamic tokens,
    // and fill-in prompts all work identically to a trigger-word-fired expansion.
    // trigger='' / deleteExtra=false because there is no typed trigger word to erase.
    executeExpansion('', result.text, result.html || null, false).then(() => {
      mainWindow?.webContents.send('overlay-fired', { label: result.label || 'Expansion' });
    }).catch(console.error);
  }
});

ipcMain.on('update-search-settings', (_event, settings) => {
  if (settings.searchOverlayHotkey !== undefined && settings.searchOverlayHotkey !== searchOverlayHotkey) {
    searchOverlayHotkey = settings.searchOverlayHotkey;
    registerOverlayHotkey(searchOverlayHotkey);
  }
  const existing = loadConfig() || {};
  saveConfig({
    ...existing,
    searchOverlayHotkey:    settings.searchOverlayHotkey    ?? existing.searchOverlayHotkey,
    overlayShowAll:         settings.overlayShowAll         ?? existing.overlayShowAll,
    overlayCloseAfterFiring:settings.overlayCloseAfterFiring ?? existing.overlayCloseAfterFiring,
    overlayIncludeAutocorrect: settings.overlayIncludeAutocorrect ?? existing.overlayIncludeAutocorrect,
  });
  console.log('[KeyForge] Search settings updated');
});

// File / folder pickers
ipcMain.handle('browse-for-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Application',
    properties: ['openFile'],
    filters: [
      { name: 'Applications', extensions: ['exe', 'cmd', 'bat', 'sh', 'app'] },
      { name: 'All Files',    extensions: ['*'] },
    ],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('browse-for-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Folder',
    properties: ['openDirectory'],
  });
  return canceled ? null : filePaths[0];
});

// UI requests engine status
ipcMain.handle('get-engine-status', () => ({
  uiohookAvailable,
  nutjsAvailable,
  macrosEnabled,
  activeProfile,
}));

// ── Help window ──────────────────────────────────────────────────────────
let helpWindow = null;

ipcMain.on('open-help', () => {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus();
    return;
  }
  const helpPath = isDev
    ? path.join(__dirname, '..', 'public', 'keyforge-help.html')
    : path.join(__dirname, '..', 'build',  'keyforge-help.html');

  helpWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: 'Trigr — User Guide',
    resizable: true,
    center: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  helpWindow.setMenuBarVisibility(false);
  helpWindow.loadFile(helpPath);
  helpWindow.on('closed', () => { helpWindow = null; });
});

// ── Settings: config path & folder ──────────────────────────────────────
ipcMain.handle('get-config-path', () => configPath);

ipcMain.on('open-config-folder', () => {
  shell.openPath(path.dirname(configPath));
});

ipcMain.on('open-external', (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('mailto:'))) {
    shell.openExternal(url);
  }
});

// ── Settings: Windows startup (login item) ───────────────────────────────
ipcMain.handle('get-startup-enabled', () =>
  new Promise(resolve => getStartupEnabled(resolve))
);

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.on('set-startup-enabled', (_event, enabled) => {
  setStartupEnabled(!!enabled);
  console.log(`[KeyForge] Start with Windows: ${enabled ? 'enabled' : 'disabled'}`);
});

// ── Backup: export config ────────────────────────────────────────────────
ipcMain.handle('export-config', async () => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Trigr Config',
    defaultPath: path.join(app.getPath('desktop'), `keyforge-backup-${today}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    const config = loadConfig() || {};
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[KeyForge] Config exported to: ${filePath}`);
    return { ok: true };
  } catch (e) {
    console.error('[KeyForge] Export failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// ── Backup: import config ────────────────────────────────────────────────
ipcMain.handle('import-config', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Trigr Config',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  try {
    const raw    = fs.readFileSync(filePaths[0], 'utf-8');
    const config = JSON.parse(raw);
    // Basic structure validation — must have an assignments object
    if (typeof config !== 'object' || config === null || typeof config.assignments !== 'object') {
      return { ok: false, error: 'Invalid Trigr config file — missing assignments object.' };
    }
    // Backup current config before overwriting so the import is always recoverable
    const current = loadConfig();
    if (current) createTimestampedBackup(current);
    console.log(`[KeyForge] Config import validated: ${filePaths[0]}`);
    return { ok: true, config };
  } catch (e) {
    console.error('[KeyForge] Import failed:', e.message);
    return { ok: false, error: `Could not read file: ${e.message}` };
  }
});

// ── Backup: list automatic backups ──────────────────────────────────────
ipcMain.handle('list-backups', () => {
  try {
    ensureBackupDir();
    const pad = n => String(n).padStart(2, '0');

    // Timestamped backups — newest first
    const timestamped = fs.readdirSync(backupDir)
      .filter(f => /^keyforge-config-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(f))
      .sort().reverse()
      .map(filename => {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(backupDir, filename), 'utf-8'));
          const m   = filename.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
          const date = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : filename;
          return { filename, date, ...configSummary(cfg) };
        } catch (_) {
          return { filename, date: filename, profileCount: 0, assignmentCount: 0, expansionCount: 0, invalid: true };
        }
      });

    // Last-known-good
    let lastKnownGood = null;
    const lkgPath = path.join(backupDir, 'keyforge-config-last-known-good.json');
    if (fs.existsSync(lkgPath)) {
      try {
        const cfg  = JSON.parse(fs.readFileSync(lkgPath, 'utf-8'));
        const stat = fs.statSync(lkgPath);
        const d    = new Date(stat.mtime);
        const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        lastKnownGood = { filename: 'keyforge-config-last-known-good.json', date, ...configSummary(cfg), isLkg: true };
      } catch (_) { /* skip */ }
    }

    return { backups: timestamped, lastKnownGood };
  } catch (e) {
    console.error('[KeyForge] list-backups failed:', e.message);
    return { backups: [], lastKnownGood: null };
  }
});

// ── Backup: restore a specific backup file ───────────────────────────────
ipcMain.handle('restore-backup', (event, { filename }) => {
  try {
    const src = path.join(backupDir, filename);
    if (!fs.existsSync(src)) return { ok: false, error: 'Backup file not found' };
    const cfg = JSON.parse(fs.readFileSync(src, 'utf-8'));
    if (!isValidConfig(cfg)) return { ok: false, error: 'Backup file is not a valid config' };
    saveConfig(cfg);
    console.log(`[KeyForge] Restored from backup: ${filename}`);
    return { ok: true, config: cfg };
  } catch (e) {
    console.error('[KeyForge] restore-backup failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// ─────────────────────────────────────────────
// QUICK SEARCH OVERLAY WINDOW
// ─────────────────────────────────────────────

function createOverlayWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.round((sw - 600) / 2);
  const y = Math.round(sh * 0.28);

  overlayWindow = new BrowserWindow({
    width: 600,
    height: 72,
    x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    overlayWindow.loadURL('http://localhost:3000/?overlay=1');
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../build/index.html'), { query: { overlay: '1' } });
  }

  // Auto-hide on blur
  overlayWindow.on('blur', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  });

  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();

  // Re-centre in case display changed
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow.setPosition(Math.round((sw - 600) / 2), Math.round(sh * 0.28));
  overlayWindow.setSize(600, 72);

  // Capture the foreground window BEFORE the overlay steals focus.
  // This is the app the user was working in — we restore focus here after firing.
  if (koffiAvailable && koffiGetForegroundWindow) {
    const fgHwnd = koffiGetForegroundWindow();
    if (fgHwnd && fgHwnd !== _koffiHwnd) {
      _searchTargetHwnd = fgHwnd;
      console.log(`[KeyForge] search overlay: captured target HWND 0x${_searchTargetHwnd.toString(16)}`);
    }
  }

  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.focus();

  // Send current data to overlay
  const cfg = loadConfig() || {};
  overlayWindow.webContents.send('overlay-search-data', {
    assignments: activeAssignments,
    activeProfile,
    globalInputMethod,
    theme: cfg.theme || 'dark',
    settings: {
      showAll:              cfg.overlayShowAll              ?? true,
      closeAfterFiring:     cfg.overlayCloseAfterFiring     ?? true,
      includeAutocorrect:   cfg.overlayIncludeAutocorrect   ?? false,
    },
  });
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    hideOverlay();
  } else {
    showOverlay();
  }
}

function registerOverlayHotkey(comboStr) {
  if (!koffiAvailable) return;
  // Unregister old one first
  if (overlayHotkeyId !== null) {
    koffiUnregisterHotKey(_koffiHwnd, overlayHotkeyId);
    overlayHotkeyId = null;
  }
  const parts = comboStr.split('+');
  const keyPart = parts[parts.length - 1];
  const modParts = parts.slice(0, -1);
  const vk = VK_CODE_MAP[keyPart];
  if (!vk) {
    console.warn(`[KeyForge] Overlay hotkey: no VK code for key "${keyPart}"`);
    return;
  }
  let mods = MOD_NOREPEAT;
  for (const m of modParts) {
    switch (m) {
      case 'Ctrl':  mods |= MOD_CONTROL; break;
      case 'Alt':   mods |= MOD_ALT;     break;
      case 'Shift': mods |= MOD_SHIFT;   break;
      case 'Win':   mods |= MOD_WIN;     break;
    }
  }
  const ok = koffiRegisterHotKey(_koffiHwnd, OVERLAY_HOTKEY_ID, mods, vk);
  if (ok) {
    overlayHotkeyId = OVERLAY_HOTKEY_ID;
    console.log(`[KeyForge] Overlay hotkey registered: ${comboStr} (id=${OVERLAY_HOTKEY_ID})`);
  } else {
    console.warn(`[KeyForge] Overlay hotkey registration failed for ${comboStr} — key may be in use`);
    // Ctrl+Space may be taken by some IME setups — try Ctrl+Shift+Space as automatic fallback
    if (comboStr === 'Ctrl+Space') {
      console.log('[KeyForge] Falling back to Ctrl+Shift+Space for overlay hotkey');
      registerOverlayHotkey('Ctrl+Shift+Space');
    }
  }
}

function unregisterOverlayHotkey() {
  if (!koffiAvailable || overlayHotkeyId === null) return;
  koffiUnregisterHotKey(_koffiHwnd, overlayHotkeyId);
  overlayHotkeyId = null;
  console.log('[KeyForge] Overlay hotkey unregistered');
}

// ─────────────────────────────────────────────
// WINDOW
// ─────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 640,
    minHeight: 500,
    frame: false,
    title: 'Trigr',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'app-icon.png')
      : path.join(__dirname, '..', 'public', 'app-icon.png'),
    backgroundColor: '#0d0d11',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Capture native HWND for RegisterHotKey and hook WM_HOTKEY messages.
  // getNativeWindowHandle() is valid immediately after BrowserWindow construction.
  if (koffiAvailable && process.platform === 'win32') {
    try {
      const hwndBuf = mainWindow.getNativeWindowHandle();
      _koffiHwnd = hwndBuf.readBigUInt64LE(0);
      console.log(`[KeyForge] HWND acquired: 0x${_koffiHwnd.toString(16)}`);
    } catch (e) {
      console.warn('[KeyForge] Could not read HWND:', e.message);
    }

    mainWindow.hookWindowMessage(WM_HOTKEY, (wParam) => {
      if (!wParam || wParam.length < 4) return;
      const id = wParam.readUInt32LE(0);
      if (id === OVERLAY_HOTKEY_ID) {
        toggleOverlay();
        return;
      }
      const entry = registeredHotkeys.get(id);
      if (!entry) return;
      console.log(`[KeyForge] WM_HOTKEY id=${id} → [${entry.macro.type}] ${entry.macro.label}`);
      pendingMacroIsBare = false;
      pendingMacroAltGr  = false;
      dispatchHotkeyWithDoubleTap(entry.storageKey, entry.macro);
    });
  }

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    // Load saved config and start listening
    const config = loadConfig();
    if (config?.assignments) {
      activeAssignments   = config.assignments;
      // Always start on the global (Default) profile — do not restore last-used profile
      activeGlobalProfile = config.activeGlobalProfile || 'Default';
      activeProfile       = activeGlobalProfile;
      const expansionKeys   = Object.keys(activeAssignments).filter(k => k.startsWith('GLOBAL::EXPANSION::'));
      const immediateCount  = expansionKeys.filter(k => activeAssignments[k]?.data?.triggerMode === 'immediate').length;
      const spaceCount      = expansionKeys.filter(k => activeAssignments[k]?.data?.triggerMode !== 'immediate').length;
      console.log(
        `[KeyForge] Config loaded — profile: ${activeProfile}, ` +
        `expansions: ${expansionKeys.length} (${immediateCount} immediate, ${spaceCount} space/default)`
      );
      if (immediateCount > 0) {
        const triggers = expansionKeys
          .filter(k => activeAssignments[k]?.data?.triggerMode === 'immediate')
          .map(k => k.slice('GLOBAL::EXPANSION::'.length));
        console.log(`[KeyForge] Immediate triggers from config: [${triggers.join(', ')}]`);
      }
    }
    if (config?.profileSettings) {
      profileSettings = config.profileSettings;
    }
    if (config?.autocorrectEnabled) {
      autocorrectEnabled = true;
    }
    if (config?.globalInputMethod  !== undefined) globalInputMethod  = config.globalInputMethod;
    if (config?.keystrokeDelay     !== undefined) keystrokeDelay     = config.keystrokeDelay;
    if (config?.macroTriggerDelay  !== undefined) macroTriggerDelay  = config.macroTriggerDelay;
    if (config?.doubleTapWindow    !== undefined) doubleTapWindow    = config.doubleTapWindow;
    // Respect the "enable macros on startup" preference (default: enabled)
    if (config?.macrosEnabledOnStartup === false) {
      macrosEnabled = false;
      console.log('[KeyForge] Macros disabled on startup per user preference');
    }
    startHotkeyListener();
    registerModifierHotkeys(); // OS-level hotkey suppression via RegisterHotKey

    // Tell the UI what's available
    mainWindow.webContents.send('engine-status', {
      uiohookAvailable,
      nutjsAvailable,
    });
    // Register overlay toggle hotkey
    const cfg = loadConfig() || {};
    if (cfg.searchOverlayHotkey) {
      // Migrate Win+Space → Ctrl+Space (Win+Space is reserved by Windows for IME switching)
      const migratedHotkey = cfg.searchOverlayHotkey === 'Win+Space' ? 'Ctrl+Space' : cfg.searchOverlayHotkey;
      if (migratedHotkey !== cfg.searchOverlayHotkey) {
        console.log('[KeyForge] Migrating search hotkey Win+Space → Ctrl+Space');
        saveConfig({ ...cfg, searchOverlayHotkey: migratedHotkey });
      }
      searchOverlayHotkey = migratedHotkey;
    }
    registerOverlayHotkey(searchOverlayHotkey);
    // Overlay window is created lazily on first use (showOverlay → createOverlayWindow)
    // to avoid a hidden renderer process consuming ~150MB at startup.
  });

  // Clear input-focus guard whenever the window loses OS focus so macros fire
  // normally the moment the user switches to another application.
  mainWindow.on('blur', () => { appInputFocused = false; });

  // Intercept native close (Alt+F4, taskbar close, etc.) — hide to tray instead
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      hideWindowToTray();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// AUTO-UPDATER
// ─────────────────────────────────────────────
function initAutoUpdater() {
  console.log('[Updater] initAutoUpdater() called — registering event handlers');
  console.log('[Updater] Current app version:', app.getVersion());
  console.log('[Updater] Feed config:', JSON.stringify(autoUpdater.getFeedURL?.() ?? '(using package.json publish config)'));

  autoUpdater.logger = console;
  autoUpdater.autoDownload = false;        // never download without explicit user action
  autoUpdater.autoInstallOnAppQuit = true; // apply cached update when app quits normally
  autoUpdater.allowDowngrade = false;      // never roll back to an older version

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', JSON.stringify(info));
    // Sum all release file sizes to give the renderer an upfront download size estimate.
    // With differentialPackage:true the actual download will be smaller (only changed blocks),
    // but this gives a worst-case ceiling until the real transfer size is known.
    const downloadSize = Array.isArray(info.files)
      ? info.files.reduce((sum, f) => sum + (f.size || 0), 0)
      : null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', { version: info.version, downloadSize });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] No update available. Current version is latest:', JSON.stringify(info));
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Updater] Download progress: ${progress.percent?.toFixed(1)}% (${progress.transferred}/${progress.total} bytes) @ ${Math.round((progress.bytesPerSecond || 0) / 1024)} KB/s`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', {
        percent:        progress.percent,
        transferred:    progress.transferred,
        total:          progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', JSON.stringify(info));
    // Log the cache path so we can verify the file is on disk
    try {
      const os = require('os');
      const path = require('path');
      const cachePath = path.join(os.tmpdir(), `${app.getName()}-updater`);
      console.log('[Updater] Expected cache directory:', cachePath);
      console.log('[Updater] autoInstallOnAppQuit:', autoUpdater.autoInstallOnAppQuit);
    } catch (e) { /* non-fatal */ }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded');
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err?.message ?? err);
    console.error('[Updater] Full error:', err);
  });

  console.log('[Updater] Scheduling checkForUpdatesAndNotify in 3 s...');
  setTimeout(() => {
    console.log('[Updater] Calling checkForUpdatesAndNotify()...');
    autoUpdater.checkForUpdatesAndNotify().then((result) => {
      console.log('[Updater] checkForUpdatesAndNotify result:', JSON.stringify(result));
    }).catch((err) => {
      console.error('[Updater] checkForUpdatesAndNotify failed:', err?.message ?? err);
      console.error('[Updater] NOTE: If this is a private GitHub repo, a GH_TOKEN env var is required for update checks.');
    });
  }, 3000);
}

ipcMain.handle('check-for-updates', async () => {
  console.log('[Updater] Manual check-for-updates triggered via IPC');
  console.log('[Updater] isDev:', isDev);
  console.log('[Updater] app.isPackaged:', app.isPackaged);
  console.log('[Updater] Current version:', app.getVersion());
  try {
    const result = await autoUpdater.checkForUpdates();
    console.log('[Updater] Manual check result:', JSON.stringify(result));
    return { success: true, result: result ? { version: result.updateInfo?.version } : null };
  } catch (err) {
    console.error('[Updater] Manual check error:', err?.message ?? err);
    return { success: false, error: err?.message ?? String(err) };
  }
});

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.on('start-download', () => {
  console.log('[Updater] User initiated download');
  autoUpdater.downloadUpdate().catch((err) => {
    console.error('[Updater] downloadUpdate failed:', err?.message ?? err);
  });
});

app.whenReady().then(() => {
  loadKoffi();
  loadUiohook();
  loadNutjs(); // load eagerly so status bar reflects correct state on startup
  createWindow();
  createTray();
  startFgWatcher();
  console.log('[Updater] isDev:', isDev, '| app.isPackaged:', app.isPackaged);
  if (!isDev) {
    initAutoUpdater();
  } else {
    console.log('[Updater] Skipping auto-updater — running in dev mode');
  }

  // Window audit — logs open BrowserWindows 5 s after startup.
  // Remove once process count is confirmed stable.
  setTimeout(() => {
    const wins = BrowserWindow.getAllWindows();
    console.log(`[KeyForge] Window audit: ${wins.length} BrowserWindow(s) open:`);
    wins.forEach((w, i) => {
      console.log(`  [${i}] title="${w.getTitle()}" url=${w.webContents.getURL()} visible=${w.isVisible()}`);
    });
  }, 5000);

  // CPU/RAM audit — logs per-process metrics every 30 s so we can spot which
  // process is burning CPU when Trigr is idle. Remove once usage is confirmed low.
  setInterval(() => {
    try {
      const mem = process.memoryUsage();
      console.log(`[RAM] main process — RSS: ${Math.round(mem.rss / 1024 / 1024)}MB  heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
      const metrics = app.getAppMetrics();
      const lines = metrics.map(m =>
        `  [${m.type}] pid=${m.pid} cpu=${m.cpu.percentCPUUsage.toFixed(1)}% mem=${Math.round(m.memory.workingSetSize / 1024)}MB`
      );
      console.log('[KeyForge] CPU/RAM audit:\n' + lines.join('\n'));
    } catch (e) { /* ignore */ }
  }, 30000);
});

app.on('window-all-closed', () => {
  // This event only fires when a window is actually destroyed.
  // Normal "close" hides the window to tray (no destroy), so this rarely fires.
  // When quitting via tray "Quit" option, isQuitting=true lets windows destroy,
  // triggering this event — at that point we want to quit.
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopHotkeyListener();
  stopFgWatcher();
  unregisterOverlayHotkey();
  unregisterAllHotkeys();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  if (fillInWindow && !fillInWindow.isDestroyed()) {
    fillInWindow.destroy();
    fillInWindow = null;
  }
  tray?.destroy();
  tray = null;
});
