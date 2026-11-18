# SimpleRay — Handoff / Project Status

Last implementation update: 2026-11-18

## Current state
- **Phase 1 UI source implemented, 10/10 frontend unit/static tests passing; Windows native and browser visual QA pending. Phases 2–6 not started.**
- GitHub private repo: `AmirrezaShafiei/SimpleRay`
- Main branch: `main`
- Requirements: [SPEC.md](SPEC.md) — authoritative source of truth.
- Phase-by-phase execution: [ROADMAP.md](ROADMAP.md).
- Overview: [README.md](README.md).

## Next action
Phase 1 has been implemented as an interactive source/UI preview. Wait for an explicit request to implement Phase 2 (configuration and subscription persistence), or for Phase 1 Windows visual QA. Do not implement any following phase automatically.

## Requirements not to overlook
- User's shared reference screenshot is `SimpleRay VPN Server Dashboard(1).png`, from the planning conversation (2026-11-18). A downscaled copy of the actual image is in [design/reference.jpg](design/reference.jpg), so future chats can inspect the screenshot.
- Simple single window, no sidebar; dark/light themes.
- Compact single ON/OFF switch, no separate Disconnect button; actual live down/up speeds next to switch only when connected.
- Server table: Favorite, Name, Type, Latency (numeric colored TEXT ONLY), Source (instead of Remarks). Source = named subscription or em dash for manual entries.
- Sort by clicking **all meaningful column headers**, toggling asc/desc with arrow. Search, stars, right-click menu.
- Toolbar buttons: Paste, Update, **Ping immediately next to Update**, Search, Settings (gear). Right-click single-server ping, NOT separate Ping Selected button.
- Ping All defaults to 3 separate through-proxy HTTP real-delay probes per server, display successful average; Settings can select 1 probe instead. Handle timeouts and partial successes truthfully.
- Subscription import supports naming and later renaming, update and persistence.
- Start at Startup, tray handling, System Proxy. TUN out of initial scope.

## Phase accounting
| Phase | Deliverable | State |
|:---:|---|---|
| 1 | Desktop skeleton + faithful Dark/Light UI, sortable demo table | Implemented; 10 tests pass; native/visual QA pending |
| 2 | Config/subscription import, naming, update, persistence | Code committed; 29 Node tests passed; Windows QA pending |
| 3 | Xray connection, System Proxy, live traffic | Not started — user request required |
| 4 | Real latency ping ×1/×3 average and sorting tests | Not started |
| 5 | Tray, Windows startup, settings and polish | Not started |
| 6 | QA, installer, beta release | Not started |

## Phase 2 handoff
- Technical and test details: [PHASE2_REPORT.md](PHASE2_REPORT.md).
- New modules: `frontend/config.js` (parsers), `frontend/store.js` (transactional persistence), `frontend/main.js` (UI), `src-tauri/src/lib.rs` (clipboard + bounded subscription HTTP fetch).
- Local storage is plaintext, including credentials/tokens; native secure storage is a future security improvement and must be reviewed before release.
- Browser automation blocked by the current environment administrator policy; Rust/Cargo unavailable here. Do not claim compiled Windows success.
- Official V2Fly/V2Ray (MIT) and Xray-core (MPL-2.0) are protocol architecture references; no upstream implementation source copied.

## After each phase
Update the table above with concrete results, commit SHA, verified test outcomes, outstanding bugs, and state of the *next* phase. Never mark a task completed based on a mockup or plan.

## Important
A previous unrelated starter ZIP/mockup was created during planning; it is NOT a tested executable client, not part of this GitHub repository, and does not satisfy a phase by itself.

## Phase 1 handoff — 2026-11-18

- Source: frontend/, src-tauri/, scripts/, tests/. The app is a UI-only preview with sample rows and no network connection.
- Main implementation commit: 173f9bfc4bf4c2599cd454f4db3aa92344b77614.
- Latest refinement and QA commit: 83c002b40ede3bf8c9bdbad90bea24192aa22c3e.
- Local verification: npm test passed (10 tests), npm run build passed JavaScript syntax/source checks, Node dev server HTTP 200.
- Unverified: actual browser interaction/visual QA blocked by Chromium environment policy; Windows Rust/Cargo/Tauri build unavailable. No installer yet.
- Reference screenshot is at [design/reference.jpg](design/reference.jpg). Detailed limitations in [PHASE1_REPORT.md](PHASE1_REPORT.md).
- For future chats: first read this file, SPEC.md and ROADMAP.md; check commits; do not infer real connectivity from sample UI. Wait for explicit Phase 2 instruction.
