# SimpleRay — Phased Implementation Plan

**Status (2026-11-18): planning only. No phases have been implemented yet.**
**Working rule:** Execute *exactly one phase per explicit user request*. At the end of that phase, commit changes, document tests/issues, show concrete results, and stop. Do **not** start the following phase without the user's next instruction. Keep [SPEC.md](SPEC.md) as the design/behavior source of truth.

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

## Phase 3 — Live Xray connection and traffic
- Integrate packaged Xray-core; generate/check valid runtime config for supported options and protocols.
- Implement real connect/disconnect with the **same compact toggle**, state machine (disconnected / connecting / connected / failed / reconnecting).
- Switching selected server, avoiding orphan core processes; System Proxy on/off and cleanup on exit/recovery where feasible.
- Display actual measured download ↓ and upload ↑ **rates beside the main toggle only when connected**; correct units/zero state.
**Acceptance:** real supported test configs connect; Windows system proxy correctly follows client state; failed connects report an error; traffic values derive from measured counters instead of mock data.

## Phase 4 — Real-delay Ping + sorting
- Toolbar **Ping** next to Update tests all servers, default **3 separate through-proxy HTTP real-delay probes per server**, displaying the successful-sample average. Setting changes toolbar behavior to 1 attempt.
- Right-click on one node exposes explicit **Ping ×1** and **Ping ×3 (Average)** independently.
- Bounded concurrency; timeouts and partial failures labeled truthfully; cancel support as practical.
- Numeric text-only latency colors, no badges/boxes; sort with missing/failed entries last, both directions; distinguish HTTP real-delay from ICMP RTT.
**Acceptance:** compare captured test results with displayed average; x1 setting persists; Ping All doesn't hang UI; latency sort is numeric and correct.

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
