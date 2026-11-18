# Phase 5 — Windows integration implementation

**Date:** 2026-11-18  
**State:** Source implemented. **Native Windows execution remains UNVERIFIED until CI and interactive testing succeed.**

## Implemented
- Tauri 2 System Tray icon with **Show SimpleRay / Connect-Disconnect / Exit SimpleRay** menu; left click brings app forward.
- Closing the main window hides the window **without stopping Xray** by default. "Minimize to tray" setting can be disabled. When disabled, closing invokes an explicit cleanup and exit path.
- Exit from the Tray attempts to disconnect, restores Windows System Proxy to its pre-app state, then exits; if Windows restoration fails it keeps the process alive and brings the window forward, with a warning, rather than abandoning a dead proxy listener.
- `Start with Windows` implemented by the current user's Windows Run registry value `SimpleRay`, referencing the installed `simpleray.exe --minimized`. Does not need administrator privileges. Does not overwrite a different existing value.
- `Auto-connect on app start` implemented separately (off by default), using the previously selected configuration. No automatic connection unless the user opts in.
- Settings gear retains Dark / Light / System and Ping (1 or default 3) while adding real Start with Windows, Minimize to Tray and Auto-connect toggles. Preferences stored in the app's local data directory.
- Startup with `--minimized` hides the window after setup; the tray stays active.
- Single main connection switch preserved; no sidebar or redundant disconnect button.

## Checked locally
- Node unit/static suite (including 8 new Phase5/6 assertions) has **51 passing tests**.
- JS syntax and version/source checks pass (`npm run build` is NOT a native installer build).
- Browser UI smoke attempted but blocked by environment administrator policy (`net::ERR_BLOCKED_BY_ADMINISTRATOR`).
- Rust/Cargo and Windows toolchain unavailable in this Linux runner; **native Windows compile and actual tray/startup behavior have NOT been proven**.

## Caveats to test on Windows
- Closing window while connection is active must not terminate the core, but Exit from Tray must terminate it and restore proxy settings.
- Reboot/sign-in with and without auto-connect, and disable/re-enable startup.
- Verify registry entry is under HKCU and only removed when owned by this program.
- Verify status / notification behavior if proxy restoration fails or external software modifies settings.
- Check that launching `--minimized` does not flash the main window visibly.
