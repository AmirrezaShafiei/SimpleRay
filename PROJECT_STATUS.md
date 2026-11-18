# SimpleRay — Current Project Status / Handoff

**Last updated:** 2026-11-18  
**Repository:** `AmirrezaShafiei/SimpleRay` (private), branch `main`.  
**Authoritative requirements:** [SPEC.md](SPEC.md). **Gated plan:** [ROADMAP.md](ROADMAP.md).

## Latest completed coding milestone

**User explicitly requested both Phase 3 and Phase 4 in one turn.** Their source changes are recorded in commit [`d5df477`](https://github.com/AmirrezaShafiei/SimpleRay/commit/d5df47788a0b37c4726251efde72403eb8dba9c2); read [PHASE3_REPORT.md](PHASE3_REPORT.md), [PHASE4_REPORT.md](PHASE4_REPORT.md), and [ARCHITECTURE.md](ARCHITECTURE.md).

**43 / 43 Node unit and source-level static tests pass.** `npm run build` is *only* a JS/source checker and **does not produce a Windows executable**. Chromium browser smoke blocked by policy, Cargo/Rust toolchain unavailable in this environment. **Neither Xray connection nor the Windows System Proxy nor real-server Ping has been exercised end-to-end.** Never describe them as proven working in an installed app.

## Phase accounting

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Tauri2 skeleton, reference-based UI, light/dark, sorting | Source committed; Windows visual/native QA pending |
| 2 | Clipboard parser, named subscriptions, refresh, local storage | Source committed; live native/HTTP QA pending |
| 3 | Xray-core connection, WinINet System Proxy, stats traffic rates | **Source committed d5df477; runtime validation PENDING** |
| 4 | HTTP-through-Xray real-delay Ping All (3 avg default / 1 optional), per-node Ping, sorting | **Source committed d5df477; runtime validation PENDING** |
| 5 | Tray, Windows Start at Startup, settings polish | **Not started. Requires user instruction.** |
| 6 | End-to-end QA, secure storage, Windows installer and beta | Not started |

## What's implemented in the code, not yet live-tested
- `frontend/xray-config.js`: converts common VMess/VLESS/Trojan/Shadowsocks share URIs to a validated Xray outbound; TLS and REALITY plus supported transport variants, rejects unsupported modes.
- `src-tauri/src/engine.rs`: runtime-managed Xray process, HTTPS 204 readiness test through proxy BEFORE setting WinINet, switching selected node, disconnect, Xray StatsService traffic-rate polling, independent Xray HTTP latency samples.
- `src-tauri/src/system_proxy.rs`: per-user WinINet proxy snapshot, switch, restore and crash recovery.
- `frontend/runtime.js`: latency averaging, status formatting, bounded/concurrent Ping All scheduler, cancel pending jobs. Main window native bridge uses those commands and does not report browser-preview fake connected state or latency.
- `scripts/stage-xray.ps1`: requires independently downloaded official Xray archive + trusted SHA256; **no Xray executable bundled in the repository**.

## UI decisions to preserve
- Screenshot: [design/reference.jpg](design/reference.jpg). Single window, **no left sidebar**, Dark/Light/System.
- One compact connect/disconnect toggle; real ↓ download and ↑ upload **rates beside toggle only when connected**. No separate Disconnect button.
- Main columns: star, Name, Type, numeric **unboxed** colored Latency, **Source** (subscription user-chosen name; manual = —).
- Every meaningful table header clickable for ascending/descending sort, search, favorites, right-click menu.
- Ping All toolbar control **directly after Update**; 3 separate proxy HTTP requests averaged by default, optional 1 in settings. Single-server ping ×1 / ×3 in right-click.
- Clipboard share links, subscription naming, update, rename, delete, persistent selection and favorites; System Proxy (not TUN).

## Critical outstanding risks and acceptance work
1. **Compile the native Rust/Tauri app on Windows** and fix any compiler errors or API version mismatches; this has not been performed.
2. Obtain verified, current official `xray.exe`; stage with `scripts/stage-xray.ps1`; verify Xray CLI configuration, API StatsService behavior, real server connect/switch/disconnect and actual throughput in a Windows environment. Check HTTP 204 probe reachability.
3. Verify WinINet registry changes, proxy snapshot/restore/crash recovery and interactions with external proxy settings. System Proxy affects only proxy-aware traffic; TUN is deferred.
4. Test actual real-delay ×1/×3, partial failures, Ping All concurrency and latency persistence with live, non-sensitive test servers.
5. **Security blocker before public beta:** Phase 2 profile URI/password/subscription tokens remain plaintext in WebView localStorage; move to secure OS-level storage/encryption prior to distribution.
6. Phase 5 tray and startup behaviors are **not implemented**. Phase 6 Windows installer is **not built**. No beta or release artifact exists.

## Next user action / continuation in new chat
Wait for an explicit user instruction, e.g. **"فاز ۵ رو انجام بده"**. The user authorized only Phases 3 and 4 this turn; stop here. Before moving on, read [SPEC.md](SPEC.md), [ROADMAP.md](ROADMAP.md), both phase reports and current code, and note that Windows native QA from previous phases still needs resolution. Never present unverified live connectivity as tested.

## Links
- [Phase 3 report](PHASE3_REPORT.md)
- [Phase 4 report](PHASE4_REPORT.md)
- [Current architecture](ARCHITECTURE.md)
- [Implementation commit](https://github.com/AmirrezaShafiei/SimpleRay/commit/d5df47788a0b37c4726251efde72403eb8dba9c2)
- [Phase 2 report](PHASE2_REPORT.md)

