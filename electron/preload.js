const { ipcRenderer } = require('electron');

window.electronAPI = {
  // Window controls
  minimize: ()          => ipcRenderer.send('window-minimize'),
  maximize: ()          => ipcRenderer.send('window-maximize'),
  close:    ()          => ipcRenderer.send('window-close'),

  // Config persistence
  loadConfig:  ()       => ipcRenderer.invoke('load-config'),
  saveConfig:  (config) => ipcRenderer.invoke('save-config', config),

  // Hotkey engine
  updateAssignments: (assignments, profile) =>
    ipcRenderer.send('update-assignments', { assignments, profile }),

  toggleMacros: (enabled) =>
    ipcRenderer.send('toggle-macros', enabled),

  getEngineStatus: () =>
    ipcRenderer.invoke('get-engine-status'),

  browseForFile:   () => ipcRenderer.invoke('browse-for-file'),
  browseForFolder: () => ipcRenderer.invoke('browse-for-folder'),

  // Profile settings (app-linking)
  updateProfileSettings: (settings) =>
    ipcRenderer.send('update-profile-settings', settings),

  // Listen for events from main process
  onMacroFired: (callback) =>
    ipcRenderer.on('macro-fired', (event, data) => callback(data)),

  onEngineStatus: (callback) =>
    ipcRenderer.on('engine-status', (event, data) => callback(data)),

  onProfileSwitched: (callback) =>
    ipcRenderer.on('profile-switched', (event, data) => callback(data)),

  // Fill-in field dialog (main window modal — kept for fallback)
  onFillInPrompt: (callback) =>
    ipcRenderer.on('fill-in-prompt', (event, data) => callback(data)),
  respondFillIn: (value) =>
    ipcRenderer.send('fill-in-response', value),

  // Fill-in floating window
  fillInReady:  ()         => ipcRenderer.send('fill-in-ready'),
  onFillInShow: (callback) => ipcRenderer.on('fill-in-show', (event, data) => callback(data)),
  submitFillIn: (values)   => ipcRenderer.send('fill-in-submit', values),

  // Active global profile (the base fallback when no app-specific profile matches)
  setActiveGlobalProfile: (profile) => ipcRenderer.send('set-active-global-profile', profile),

  // Input focus state — tells the macro engine to stand down while typing in the UI
  notifyInputFocus: (focused) => ipcRenderer.send('input-focus-changed', focused),

  // Autocorrect
  updateAutocorrectEnabled: (enabled) => ipcRenderer.send('update-autocorrect-enabled', enabled),

  // Global compatibility settings
  updateGlobalSettings: (settings) => ipcRenderer.send('update-global-settings', settings),

  // Settings — startup
  getStartupEnabled:  ()        => ipcRenderer.invoke('get-startup-enabled'),
  setStartupEnabled:  (enabled) => ipcRenderer.send('set-startup-enabled', enabled),
  getAppVersion:      ()        => ipcRenderer.invoke('get-app-version'),

  // Help
  openHelp:     ()    => ipcRenderer.send('open-help'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Settings — config path & folder
  getConfigPath:    ()  => ipcRenderer.invoke('get-config-path'),
  openConfigFolder: ()  => ipcRenderer.send('open-config-folder'),

  // Backup & restore
  exportConfig:   ()           => ipcRenderer.invoke('export-config'),
  importConfig:   ()           => ipcRenderer.invoke('import-config'),
  listBackups:    ()           => ipcRenderer.invoke('list-backups'),
  restoreBackup:  (filename)   => ipcRenderer.invoke('restore-backup', { filename }),

  // Hotkey recording
  startHotkeyRecording: () => ipcRenderer.send('start-hotkey-recording'),
  stopHotkeyRecording:  () => ipcRenderer.send('stop-hotkey-recording'),
  onHotkeyRecorded: (callback) =>
    ipcRenderer.on('hotkey-recorded', (event, data) => callback(data)),

  // Cleanup listeners
  removeAllListeners: (channel) =>
    ipcRenderer.removeAllListeners(channel),

  // Key capture (Press Key macro step + Send Hotkey field)
  startKeyCapture: ()         => ipcRenderer.send('start-key-capture'),
  stopKeyCapture:  ()         => ipcRenderer.send('stop-key-capture'),
  onKeyCaptured:   (callback) => ipcRenderer.on('key-captured', (_, combo) => callback(combo)),

  // Quick Search overlay
  closeOverlay:          ()          => ipcRenderer.send('close-overlay'),
  resizeOverlay:         (height)    => ipcRenderer.send('overlay-resize', { height }),
  executeSearchResult:   (result)    => ipcRenderer.send('execute-search-result', result),
  updateSearchSettings:  (settings)  => ipcRenderer.send('update-search-settings', settings),

  onOverlaySearchData: (callback) =>
    ipcRenderer.on('overlay-search-data', (event, data) => callback(data)),
  onOverlayFired: (callback) =>
    ipcRenderer.on('overlay-fired', (event, data) => callback(data)),

  // Global pause toggle
  setPauseHotkey:      (combo) => ipcRenderer.invoke('set-global-pause-key', combo),
  clearPauseHotkey:    ()      => ipcRenderer.send('clear-global-pause-key'),
  checkHotkeyConflict: (combo) => ipcRenderer.invoke('check-hotkey-conflict', combo),

  // Auto-updater
  onUpdateAvailable:  (callback) => ipcRenderer.on('update-available',  (event, data) => callback(data)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', ()             => callback()),
  installUpdate:      ()         => ipcRenderer.invoke('install-update'),
  startDownload:      (version)  => ipcRenderer.send('start-download', { version }),
  checkForUpdates:    ()         => ipcRenderer.invoke('check-for-updates'),
};
