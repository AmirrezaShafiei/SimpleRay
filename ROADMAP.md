# SimpleRay — Phased Implementation Plan

**Status (2026-11-18): Phase 1–2 source delivered; Phase 3 and Phase 4 source committed together by explicit user request, 43/43 Node tests pass. Native Windows build, Xray connectivity, proxy changes and real Ping are NOT verified. Phases 5 and 6 now have source code, reports and a Windows beta workflow (verification pending).**
**Working rule:** Execute only explicitly requested phase(s). The user authorized Phases 3 and 4 together, and then Phases 5 and 6 together, in the 2026-11-18 session. At the end of that phase, commit changes, document tests/issues, show concrete results, and stop. Do **not** start the following phase without the user's next instruction. Keep [SPEC.md](SPEC.md) as the design/behavior source of truth.

**Visual baseline:** user-uploaded image `SimpleRay VPN Server Dashboard(1).png` shared in the planning conversation, plus changes in SPEC.md (Source replaces Remarks, no separate Disconnect, Ping next to Update, sortable table, dark/light themes). Implement a faithful UI rather than redesigning it.

## Phase 1 — Foundation + faithful UI
- Create Windows desktop project skeleton, select feasible frontend/backend stack and build scripts.
- Implement the single-window visual design (NO sidebar), balanced connect toggle, traffic layout, toolbar, server list, Search, gear Settings shell, context menu.
- Dark and Light themes including theme persistence; first run can use a default system setting.
- Populate the UI with clearly labeled demo/mock records **only**, not real connection states.
- Implement clickable sortable headers for Favorite, Name, Type, Latency and Source; sorting toggles ascending / descending. Toggle favorites; preserve selection in view state.
- Visible Ping button immediately beside Update, with placeholder/disabled execution until Phase 4. No dedicated Ping Selected toolbar button.
**Acceptance:** app starts locally; both themes look polished; sort arrow behaves for every column; context menu and favorites function on demo data; header controls are visually balanced; no fake real connection claim.

## Phase 2 — Configurations, persistence and subscriptions
- Parse clipboard VMess/VLESS/Trojan/Shadowsocks URIs and eligible multi-line content, with clear import errors.
- Add/rename/edit/delete manual configs, duplicate config, store locally (no secrets committed).
- Import subscriptions from clipboard URL; prompt for **name + URL** and persist stable subscription ID.
- Show subscription name under Source for subscribed nodes; show **—** for standalone entries.
- Implement refresh of one / all subscriptions with last-good fallback, stable selection/favorites, safe deletion behavior.
**Acceptance:** restart preserves entries, favorites, selection, subscription names; update adds/removes nodes correctly without erasing standalone configs; errors do not expose credentials.

**Phase 2 checkpoint:** Implemented and committed in `77e7cea4621aec8808c37bf0f64ac4efc8feb12a`. Node tests 29/29 pass; native Windows build and live subscription fetch not yet verified. The user subsequently authorized phases 3 and 4 together.

## Phase 3 — Live Xray connection and traffic
- Integrate packaged Xray-core; generate/check valid runtime config for supported options and protocols.
- Implement real connect/disconnect with the **same compact toggle**, state machine (disconnected / connecting / connected / failed / reconnecting).
- Switching selected server, avoiding orphan core processes; System Proxy on/off and cleanup on exit/recovery where feasible.
- Display actual measured download ↓ and upload ↑ **rates beside the main toggle only when connected**; correct units/zero state.
**Acceptance:** real supported test configs connect; Windows system proxy correctly follows client state; failed connects report an error; traffic values derive from measured counters instead of mock data.

**Phase 3 checkpoint:** Source [committed](https://github.com/AmirrezaShafiei/SimpleRay/commit/d5df47788a0b37c4726251efde72403eb8dba9c2). Includes Xray subprocess manager, HTTPS-through-proxy readiness test, WinINet per-user proxy snapshot/recovery, Xray StatsService traffic display and fallback handling. 43/43 Node/static tests pass overall. **Not accepted as live-verified** until Windows Rust build, official staged core, actual server and registry integration are tested. See [PHASE3_REPORT.md](PHASE3_REPORT.md).

## Phase 4 — Real-delay Ping + sorting
- Toolbar **Ping** next to Update tests all servers, default **3 separate through-proxy HTTP real-delay probes per server**, displaying the successful-sample average. Setting changes toolbar behavior to 1 attempt.
- Right-click on one node exposes explicit **Ping ×1** and **Ping ×3 (Average)** independently.
- Bounded concurrency; timeouts and partial failures labeled truthfully; cancel support as practical.
- Numeric text-only latency colors, no badges/boxes; sort with missing/failed entries last, both directions; distinguish HTTP real-delay from ICMP RTT.
**Acceptance:** compare captured test results with displayed average; x1 setting persists; Ping All doesn't hang UI; latency sort is numeric and correct.

**Phase 4 checkpoint:** Source [committed](https://github.com/AmirrezaShafiei/SimpleRay/commit/d5df47788a0b37c4726251efde72403eb8dba9c2). Includes per-server temporary Xray proxy, HTTP 204 real-delay x1/x3 averaged, Ping All concurrency 3, cancellation of pending work, partial failures, persistence and sort. JS tests pass, **live Xray and real-server Ping remain unverified**. See [PHASE4_REPORT.md](PHASE4_REPORT.md).

## Phase 5 — System integration and quality-of-life
- System Tray: closing window hides by default, explicit Exit stops core and cleans proxy; show/open/quit/context actions.
- Windows Start at Startup toggle and separate Auto-connect toggle (off by default).
- Finish gear Settings: Dark / Light / System, ping probe count 3 or 1, startup, tray, proxy options.
- Improve keyboard navigation, error messages, empty states, duplicate detection, non-blocking operations.
**Acceptance:** tray, exit, login startup and theme persistence work across restarts; no unintended disconnect on window close.

## Phase 6 — QA, packaging and beta release
- End-to-end tests (import/subscriptions/update, favorite and Source preservation, multiple protocols, connect/switch/disconnect, ping x1/x3/average, sorting, tray, startup, light/dark).
- Dependency/runtime review, no bundled secrets, robust logs without credentials.
- Windows installer and GitHub beta release, downloadable files + tagged version and short release notes.
**Acceptance:** reproducible build, installer starts cleanly, known limitations noted, beta artifacts linked.

## Phase-gate reporting format
After each phase, report:
1. What was implemented, with commit / PR links.
2. How it was verified (actual test steps and results; do not invent success).
3. Known issues, deferred items, and deviations from the visual reference.
4. One-sentence next phase; **stop** until specifically instructed to continue.

## Non-goals for first beta
TUN, split tunneling, elaborate rules editor, browser extension, a left sidebar, redundant Disconnect control, always-visible per-server Ping button, boxed latency badges.

## Phase 1 delivery log — 2026-11-18

- Desktop shell, frontend, sample table, themes and sorting: GitHub commit 173f9bfc4bf4c2599cd454f4db3aa92344b77614.
- Refined styling, reference screenshot, test suite and report: commit 83c002b40ede3bf8c9bdbad90bea24192aa22c3e.
- Verified: npm test 10/10 passing; npm run build (frontend source and JavaScript syntax check) passing; local Node HTTP dev server served index with HTTP 200.
- Not verified: Chromium click-through/visual screenshots (ERR_BLOCKED_BY_ADMINISTRATOR for local/file URLs) and native Tauri/Windows compilation (Rust/Cargo toolchain unavailable here).
- The checked-in design image is [design/reference.jpg](design/reference.jpg). Read [PHASE1_REPORT.md](PHASE1_REPORT.md) for precise test and limitation details. No native installer or real proxy functionality was produced.
- Phase 1 code delivery is complete, but Windows visual QA remains an open quality gate. Phase 2 was explicitly requested and its source was delivered. Do not begin Phase 3 unless explicitly instructed.

## Phase 5/6 delivery log — 2026-11-18

- Phase 5 native shell and settings: tray, close-to-tray, user startup, separate auto-connect, guarded proxy cleanup. See [PHASE5_REPORT.md](PHASE5_REPORT.md).
- Phase 6 source QA + Windows build pipeline, pinned official Xray-core staging/digest, NSIS and conditional GitHub prerelease. See [PHASE6_REPORT.md](PHASE6_REPORT.md) and [.github/workflows/windows-beta.yml](.github/workflows/windows-beta.yml).
- Local checks: **51/51 Node tests passed**, `npm run build` JS/source/version checks passed.
- Windows GitHub Actions run: [44382246461](https://github.com/AmirrezaShafiei/SimpleRay/actions/runs/44382246461). **Installer must not be declared available until actual successful workflow and release asset are verified.**
- Still open: Windows native runtime/real-server/manual tray QA, unsigned installer trust warning, plaintext user secrets in WebView storage requiring encrypted persistence before general public release.
- User-requested phase implementation source is delivered; the project remains **beta-validation pending**, not production-ready.

## Post-beta update: version 0.5.0-beta.5 (2026-11-19)
- [x] Implement Quick Switch Tray popup and native Suggest-mode notification when main window is hidden.
- [x] Add three palettes plus Custom primary/accent with separate Light/Dark/System brightness selection.
- [x] Change Ping All default to 2, preserve 1/2/3 options and per-server x2 action.
- [ ] Verify Windows GitHub Actions build and UI behavior on an actual Windows desktop before considering release final.
- [ ] Manual acceptance: observe a real Suggest candidate with app hidden, dismiss via focus loss, switch through quick popup, and verify no repeated interruptions.
