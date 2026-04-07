# TRIGR — Feature Status Reference
> All features, their completion status, and tier placement.
> Updated: March 2026 (session 3)

---

## COMPLETE — DO NOT REBUILD

| Feature | Notes |
|---|---|
| Visual keyboard UI | Full keyboard, modifier bar, numpad slide-out |
| Modifier layers | Ctrl, Alt, Shift, Win, Bare Keys |
| Action types: Type Text | Fires text at cursor |
| Action types: Send Hotkey | Remaps combo |
| Action types: Macro Sequence | Chain with drag-drop reorder, Wait for Input |
| Action types: Open App | Launch app or file |
| Action types: Open URL | Default browser |
| Action types: Open Folder | File Explorer |
| Double press hotkeys | Single + double have separate assignments for keyboard keys AND mouse buttons. Timer 300ms default. Both move on reassign. |
| Mouse button assignments | Multiple versions implemented — confirmed working. Double press fully supported. |
| Mouse ×2 badge | ZONE_X2 coordinates in MouseCanvas; mc-double-badge SVG text element renders on zones with double assignment |
| Mouse double press toggle bar | Single/Double press toggle bar in action panel now shows for mouse buttons (MOUSE_ guard removed) |
| Permanent download URL | artifactName: "Trigr-Setup.${ext}" — installer always Trigr-Setup.exe. Landing page links to /releases/latest/download/Trigr-Setup.exe |
| Bare key assignments | No modifier required |
| App-specific profiles | Foreground watcher, auto-switch |
| Multiple global profiles | User selects active base |
| Quick Search overlay | Ctrl+Space, configurable |
| Record Hotkey button | Press combo, Trigr records it |
| Numpad panel | Slide-out |
| x2 badge | Shows on keys with double press |
| Single/Double press toggle | In action panel |
| Text expansions | Trigger + Space fires replacement |
| Fill-in fields | Prompt mid-expansion |
| Global Variables | {clipboard}, {cursor} |
| My Details | Stored personal info variables |
| Autocorrect | Built-in library |
| Expansion categories | Colour, rename, reorder |
| Global pause toggle | Modifier-combo only |
| Tray icon | Gold T active, different state paused |
| Taskbar overlay icon | setOverlayIcon |
| Light/dark mode | |
| Start with Windows | |
| Import/Export config | File dialog |
| Rolling config backups | Automatic |
| Config corruption protection | loadConfigSafe() |
| Settings panel | Help, About, Privacy, General, Pause, Quick Search, Compatibility, Backup & Restore |
| In-app feedback button | Opens Google Form URL |
| Auto-updater | Direct HTTPS download — DO NOT MODIFY |
| Keyboard scaling fix | Width-only ResizeObserver, no devicePixelRatio |
| 77MB installer | NSIS |
| Bundled fonts (offline) | 10 woff2 files in public/fonts/, loaded via public/fonts.css — no CDN dependency |
| Syne 800 wordmark | Header logo text uses Syne 800. T icon removed. Colour: var(--text-primary). |
| Start with Windows — silent launch | Auto-launch detected via --autolaunch arg. Window hidden on startup; tray icon only. |
| Foreground watcher visibility guard | Profile auto-switching suppressed while main window is visible. Resumes on hide/minimise. |
| Esc clears sidebar to All tab | Pressing Esc to clear modifier selection now resets sidebar tab to "All" |

---

## BETA (May 2026)

| Feature | Tier | Sessions | Notes |
|---|---|---|---|
| Onboarding flow | Free | 2-3 | First-run experience |
| Starter template library | Free | 1-2 | Pre-built for Support, Sales, Dev, CAD |
| List view toggle | Free | 1-2 | Keyboard on by default. Toggle in settings. Flat searchable table. |
| Basic analytics | Free | 2-3 | Total actions fired + time saved counter |
| LemonSqueezy free beta keys | N/A | 2-3 | Validates licence flow before money |
| AHK Script Runner v1 | Free | 4-6 | Bundles AHK runtime. No AHK install needed. |

---

## v1.0 (July 2026)

| Feature | Tier | Sessions | Notes |
|---|---|---|---|
| AHK v2 syntax support | Free | 2-3 | Bundle v2 runtime alongside v1 |
| AHK importer | Pro | 3-4 | Parse .ahk files, convert assignments |
| Clipboard Manager basic | Free | 4-5 | History, search, pin, 30-day retention |
| Clipboard Manager advanced | Pro | 2-3 | Smart tagging, source app, sensitive detection, unlimited |
| Save Snippet from Highlight | Pro | 4-6 | Ctrl+Space contextual card. Risk: clipboard timing. |
| Full analytics dashboard | Pro | 2-3 | 14-day chart, per-assignment, CSV export |
| Shared profile export/import | Free | 1-2 | File-based, no cloud |
| Macro recorder prominent | Free | 2-3 | Front-and-centre, default mental model |
| UI polish | All | 2-3 | Eliminate vibe-coded generic elements |
| LemonSqueezy paid tiers | N/A | 1 | Activate Pro + Teams pricing |
| Privacy policy + terms | N/A | 1-2 | |

---

## v1.1 (August 2026)

| Feature | Tier | Sessions |
|---|---|---|
| TextExpander importer | Pro | 2-3 |
| espanso importer | Pro | 2-3 |
| Run Macro on selection (Ctrl+Space) | Pro | 2-3 |
| Expand Here without hotkey (Ctrl+Space) | Pro | 2-3 |

---

## v1.2 (Sept-Oct 2026)

| Feature | Tier | Sessions |
|---|---|---|
| Conditional expansions | Pro | 3-4 |
| Scheduled macros | Pro | 3-5 |
| Mouse button assignments advanced | Pro | 2-3 |
| Dynamic variables {date} {time} {computername} | Pro | 1-2 |
| Regex triggers | Pro | 2-3 |

---

## v2.0 (Q4 2026)

| Feature | Tier | Sessions |
|---|---|---|
| Cloud sync | Pro | 10-15 |
| Shared team snippet libraries | Teams | 10-15 |
| Admin dashboard | Teams | 4-6 |
| Team analytics | Teams | 2-3 |
| SSO | Teams | 3-5 |
| Browser extension | Pro | 4-6 |
| AHK script export (.ahk output) | Pro | 2-3 |
