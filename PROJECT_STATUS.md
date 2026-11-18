# SimpleRay — Current Project Status / Handoff

**Last updated:** 2026-11-18  
**Repository:** `AmirrezaShafiei/SimpleRay` (private), branch `main`.

## Status snapshot
- **Phase 1:** Minimal Tauri2 desktop source, dark/light single-window UI, header sorting, search, favorites, visual reference. Code delivered; 10 tests passed in Phase1. Native Windows and actual browser visual QA still pending.
- **Phase 2:** Config import, named subscription CRUD/refresh/persistence, `Source`, local saved configurations and native Rust clipboard/HTTP commands. **Source committed** as `77e7cea4621aec8808c37bf0f64ac4efc8feb12a`. **29/29 Node tests passing**; source syntax check passed. Windows native compilation and real online subscription fetch remain unverified.
- **Phases 3–6 have NOT started.** There is no working proxy connection, real Ping, tray/startup handling or Windows installer yet.

## Next action
Wait for an **explicit user request for Phase 3**. Before implementation, read [SPEC.md](SPEC.md), [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [PHASE2_REPORT.md](PHASE2_REPORT.md). Do not assume Phase 3 is already implemented because source includes UI labels or native fetch IPC.

## Authoritative design decisions
- Reference screenshot in [design/reference.jpg](design/reference.jpg), subject to written deviations in [SPEC.md](SPEC.md).
- One window, no left sidebar, Dark/Light/System themes, one **balanced** ON/OFF connection toggle (no extra Disconnect button).
- Real downstream ↓ and upstream ↑ traffic rates appear beside connection toggle **only when connected** (Phase 3). Do not display fake traffic.
- Table columns: Favorite, Name, Type, **numeric text-only colored latency** (never boxed), **Source**. Source is user-chosen subscription name; manual entry shows `—`.
- Click each meaningful header to sort asc/desc; numeric latency, failed/unmeasured last; star, search, right-click actions.
- Toolbar has **Ping directly after Update**. Phase 4 Ping All: **3 real HTTP-through-proxy probes averaged by default**, Settings allows 1. Single-node Ping from right-click.
- Named subscription from Clipboard, update, rename, preserve last-good content on error, local CRUD and persistence. Start with Windows/Tray Phase 5. TUN beyond v0.1 scope.

## Phase table

| Phase | Scope | State |
|---|---|---|
| 1 | Desktop scaffold and approved single-window UI | Code delivered; native/browser QA pending |
| 2 | Config URI import, named subscription CRUD/refresh, local persistence | Code committed; 29 Node tests pass; native Windows and real HTTP QA pending |
| 3 | Xray-core, System Proxy, real connect/traffic | Not started — needs user request |
| 4 | Real latency x1/x3 average, Ping All, numeric sort | Not started |
| 5 | Tray, Start at Startup, settings polish | Not started |
| 6 | Full QA, Windows installer, beta release | Not started |

## Important current limits and risks
- Local WebView storage is **plaintext** including configuration credentials and subscription tokens; consider encrypted OS-scoped persistence prior to public release. Never commit private configs/tokens.
- VMess/VLESS/Trojan/Shadowsocks common share URIs and base64/plain subscription lists parsed; Clash YAML and sing-box JSON not supported.
- Browser automation blocked by administrator policy (`ERR_BLOCKED_BY_ADMINISTRATOR`); Cargo/Rust unavailable here; do not claim native app built or tested.
- No external third-party subscription end-to-end download verified.
- V2Fly/V2Ray MIT and Xray-core MPL-2.0 were consulted as architectural references, no upstream code copied.

## Confirmed work
- [PHASE1_REPORT.md](PHASE1_REPORT.md)
- [PHASE2_REPORT.md](PHASE2_REPORT.md)
- Phase2 implementation commit: [77e7cea](https://github.com/AmirrezaShafiei/SimpleRay/commit/77e7cea4621aec8808c37bf0f64ac4efc8feb12a)

After any new phase, update this file with implemented features, actual tests, known bugs, commit link and next phase gate.
