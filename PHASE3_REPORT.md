# SimpleRay — Phase 3 implementation report

Date: 2026-11-18
**Status: Connection engine source implemented; real Windows end-to-end validation PENDING.**

## Delivered in source
- Added `src-tauri/src/engine.rs`: a managed Xray-core subprocess, restricted JSON outbound input, unique localhost HTTP proxy port, Xray `run -test` validation, process/readiness probe, and HTTPS `204` preflight through the selected server BEFORE changing Windows System Proxy.
- Connection state is returned from the native backend (`connected`, `disconnected`, and error), never simulated in the browser preview. Same compact switch connects/disconnects, and double-click selects/switches to a server.
- Tries to switch to a newly validated server before terminating the old one. On a failed preflight, keeps the previous connection and System Proxy if already active.
- Added `src-tauri/src/system_proxy.rs`: Windows per-user WinINet HTTP/HTTPS proxy takeover, snapshot of prior proxy setting, restore on disconnect/exit, and recovery file for an interrupted/crashed session. Protects externally changed settings from being overwritten. This is **not** TUN, not an all-process transparent proxy, and cannot control programs that ignore WinINet settings.
- Real traffic rates: Xray StatsService (via `xray api statsquery --reset=true`) queried from the local API, mapping inbound uplink/downlink byte counters into upload/download rates. When stats cannot be queried, UI shows `—` instead of invented zeroes.
- Added browser-facing `frontend/xray-config.js` with common share-link to Xray outbound transformations for VMess, VLESS, Trojan and Shadowsocks; TLS, REALITY (`password` field), raw, WS, gRPC, XHTTP and HTTPUpgrade options. Unsupported modes produce an explicit error instead of silent fallback. Core validates the resulting config.
- Supports only explicitly provided/staged Xray executable. No third-party executable was copied or silently downloaded into GitHub. `scripts/stage-xray.ps1` requires a SHA256 of an independently obtained official Xray archive.

## Actually executed verification
- `npm test`: 43 passed / 0 failed across all phases, including new profile conversion, traffic format, latency aggregation, concurrency, and static source checks. These are JS/unit/static checks, NOT real proxy/network tests.
- `npm run build`: passed the project's own source existence and Node JS syntax checker. **Not a Rust/native binary build.**
- Browser Playwright smoke attempt: blocked by environment policy (`net::ERR_BLOCKED_BY_ADMINISTRATOR`), as in prior phases.
- Native Tauri/Rust build: **NOT EXECUTED** (Cargo/Rust toolchain absent in available environment).
- Windows WinINet changes, actual Xray process spawn, real connected server, StatsService output, crash recovery: **NOT END-TO-END TESTED**.

## Known limitations and risks
- **Actual verified connectivity is not established.** The code describes a design intended for native Windows execution, and runtime bugs/incompatibilities may remain until testing on Windows.
- Core executable still needs to be staged from a trusted Xray release (and later included in installer Phase 6). Native binary has not been packaged.
- WinINet settings apply to proxy-aware applications only, not all Windows traffic (no TUN). Existing PAC/AutoDetect and multi-instance behavior require manual Windows validation. Multi-instance enforcement is deferred to Phase 5.
- Existing Phase 2 subscription URLs and configuration credentials remain unencrypted in localStorage; encryption-at-rest remains a release blocker.
- Some vendor/protocol variations not mapped (e.g., Shadowsocks plugins, nonstandard networking modes) are rejected rather than falsely marked working.
- Current readiness preflight requires the HTTPS 204 endpoint to be reachable over the selected server; some firewalled networks may require user-configurable probe targets later.
- `System Proxy` recovery covers normal exit and next-launch recovery but catastrophic process termination may temporarily leave system proxy set to a dead port until restart or manual correction.

## Next phase gate
Phase 5 adds tray/startup/lifecycle quality-of-life; Windows build and integration tests should be performed as soon as a Windows environment is available, before calling any end-to-end connection feature verified.
