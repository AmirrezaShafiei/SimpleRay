# SimpleRay architecture (Phases 1–4 source)

## UI
- Static ES modules served by Tauri WebView, with Dark/Light theme, single window, sortable server table, context actions, and no sidebar.
- `frontend/config.js` parses canonical URIs, `frontend/store.js` manages subscription/node persistence in localStorage.
- `frontend/xray-config.js` maps canonical share URLs to restricted Xray outbound JSON. `frontend/runtime.js` provides pure latency pooling/aggregation and rate formatting.
- `frontend/main.js` uses native Tauri commands (via `window.__TAURI_INTERNALS__.invoke`) for connection, status and real latency; browser preview does not fake results.

## Native Rust
- `src-tauri/src/lib.rs`: Tauri command handlers and startup recovery / exit cleanup.
- `src-tauri/src/engine.rs`: Xray binary resolution, temporary config building, validation, child process lifecycle, proxy-through-core HTTPS 204 probe, StatsService readings, separate per-node latency probes.
- `src-tauri/src/system_proxy.rs`: Windows WinINet per-user System Proxy snapshot/override/recovery. On other OSes active proxy mode returns an error; product target is Windows.
- Subscription fetch and system clipboard remain in Rust.

## Engine binary
- Xray-core is Mozilla Public License 2.0. The Xray executable is NOT included in the repo and needs to be staged from an official, independently verified release.
- To run on Windows (with Rust, WebView2, Visual Studio build tools, Node installed): verify an official Windows archive SHA256 and run `scripts/stage-xray.ps1`, then `npm install` and `npm run desktop:dev`. For local development an absolute `SIMPLERAY_XRAY_PATH` env path is also accepted.
- Do not commit binaries, personal configs, access tokens, subscription URLs or third-party secrets to GitHub.

## Safety and honest states
- Native connection reports connected only after `Xray run -test`, local HTTP readiness, and successful proxied HTTPS 204 preflight, followed by system proxy takeover.
- A failing switch does not intentionally terminate the previous active connection.
- Live bytes/s are derived from Xray StatsService; unavailable stats show `—`.
- Browser mode is a preview, not a real VPN, and has no native proxy integration.
- LocalStorage secrets remain plaintext at rest: protect them with an OS-backed encrypted store before release.

## Upstream open source documentation
- https://github.com/XTLS/Xray-core — MPL-2.0
- https://github.com/v2fly/v2ray-core — MIT; architectural reference only
- https://xtls.github.io/en/config/api.html
- https://xtls.github.io/en/config/stats.html
- https://xtls.github.io/en/config/transport.html
- https://tauri.app/develop/sidecar/ (reference; app uses native Rust process ownership instead)
