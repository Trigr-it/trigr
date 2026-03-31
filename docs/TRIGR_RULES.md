# TRIGR — Rules & Do-Not-Touch List
> Read before every session. These rules exist because things broke when they were ignored.

---

## ABSOLUTE DO NOT TOUCH

### 1. Auto-updater mechanism
The direct HTTPS download to `os.tmpdir()` is confirmed working end-to-end. Do NOT:
- Switch back to electron-updater's built-in download
- Add await after spawn
- Change the spawn flags (`/VERYSILENT /RESTARTAPPLICATIONS`)
- Move `app.quit()` after spawn
- Add any delay between spawn and quit

If the auto-updater breaks, check the publish sequence first before touching the code.

### 2. Icon location
App icons live in `assets/icons/`. Never move them to `build/`. React wipes `build/` on every npm run build.

### 3. Keyboard scaling formula
Width-only ResizeObserver. Never divide by `devicePixelRatio`. The current formula is correct for both ARM64 (150% DPI) and x64 (100% DPI).

### 4. Config write ownership
`main.js` owns all config writes. The renderer never writes to disk directly.

---

## PUBLISH SEQUENCE — Always Exactly This Order

```bash
git add .
git commit -m "message"
npm run build
npm version patch
npm run publish
```

Never skip `npm run build` before `npm version patch`. Never publish without committing first.

---

## TESTING RULES

- Auto-updater NEVER appears in `npm run electron-dev` console — test only in the installed version
- Installed version is always one behind the latest GitHub release
- Fixes in dev do not appear in the installed app until the next publish cycle
- To test auto-updater: install a build, publish a new version, wait 10 seconds in the installed app

---

## CC PROMPT RULES

When Rory pastes a CC result back to Claude Chat for review:
- Claude Chat reviews, identifies issues, writes the NEXT CC prompt
- Each CC prompt goes in its own separately copyable block
- Label prompts: Prompt 1, Prompt 2, etc.
- Never combine multiple CC actions into one block
- For risky or structural changes: plan before implementing — ask CC to describe what it will change before making changes

---

## MOUSE BUTTONS

Mouse button assignments are COMPLETE and have been working for multiple versions. Never assume this feature is missing or unbuilt. Never suggest it needs to be added.

---

## DOUBLE PRESS

Double press is COMPLETE for both keyboard and mouse. Never assume it is missing.

---

## SESSION START CHECKLIST (for CC)

At the start of every CC session:
1. Read `docs/TRIGR_CONTEXT.md`
2. Read `docs/TRIGR_RULES.md`
3. Read `docs/TRIGR_FEATURES.md` if working on a specific feature
4. Confirm current version with `cat package.json | grep version`
5. Never assume a feature is unbuilt — check the codebase first

---

## KNOWN GOTCHAS

- Config file is internally named `keyforge-config.json` — do not rename without a migration path
- `loadConfig()` can return null on parse error — always use `loadConfigSafe()` for any read that matters
- Help guide scaling IIFE must not intercept `window.show` — call `_trigrRescale` directly from `show()`
- `.kf` elements in help guide: hide via `visibility:hidden` until `kf-ready` class added post-scaling, 150ms fade-in
