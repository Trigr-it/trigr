# KeyForge 🎹
### Visual Hotkey & Macro Manager

A clean, non-technical desktop app for creating keyboard macros and hotkeys — with a visual keyboard UI.

---

## Quick Start (Development)

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or higher
- npm (comes with Node.js)

### Install & Run

```bash
# 1. Navigate to the project folder
cd keyforge

# 2. Install dependencies
npm install

# 3. Run in development mode (opens the app)
npm run electron-dev
```

That's it. The app will open in a window.

---

## What You Can Do

| Action | How |
|--------|-----|
| Assign a macro | Click any key on the keyboard → fill in the right panel → click **Assign to Key** |
| Edit a macro | Click an already-assigned key (shown with amber glow) |
| Clear a macro | Select the key → click **Clear Key** in the panel |
| Switch profiles | Click profile tabs in the titlebar (Default / Gaming / Work) |
| Add a profile | Click **+** next to the profile tabs |
| Toggle macros on/off | Click the **ACTIVE** button in the top right |

## Action Types

- **Type Text** — types a snippet of text when key is pressed
- **Send Hotkey** — fires a key combo (e.g. Ctrl+Shift+N)
- **Open App** — launches an .exe or file
- **Open URL** — opens a website in the default browser
- **Macro Sequence** — runs multiple steps in order (type text, wait, press key, etc.)

---

## Build to .exe (Windows)

```bash
npm run package
```

Output will be in the `dist/` folder as a Windows installer.

---

## Project Structure

```
keyforge/
├── electron/
│   ├── main.js          # Electron main process
│   └── preload.js       # IPC bridge
├── src/
│   ├── App.js           # Main React app + state
│   ├── index.js         # React entry point
│   ├── components/
│   │   ├── TitleBar.js       # Top bar with profiles + window controls
│   │   ├── Sidebar.js        # Left panel — assigned key list
│   │   ├── KeyboardCanvas.js # The visual keyboard
│   │   ├── keyboardLayout.js # Key definitions & layout data
│   │   ├── MacroPanel.js     # Right panel — macro editor
│   │   └── StatusBar.js      # Bottom status bar
│   └── styles/
│       ├── global.css
│       └── app.css
├── public/
│   └── index.html
└── package.json
```

---

## Roadmap Ideas (future development)

- [ ] Global hotkey listener (uiohook-napi) to actually fire macros
- [ ] Import/export profiles as JSON
- [ ] Numpad view toggle
- [ ] Per-app profiles (auto-switch when app is focused)
- [ ] Cloud sync of profiles
- [ ] Licence key system
- [ ] Mac support

---

## Tech Stack

- **Electron** — desktop shell
- **React 18** — UI framework
- **Rajdhani + DM Sans** — typography
- **electron-builder** — packaging to .exe/.dmg

---

*Built with KeyForge Prototype v1.0*
