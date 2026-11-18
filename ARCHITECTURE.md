# SimpleRay architecture

## Phase 2 — live code structure
- `frontend/index.html`, `styles.css`: single-window approved UI; theme selector, server list, dialogs and contexts.
- `frontend/main.js`: UI controller and event handlers; no real Xray runtime yet.
- `frontend/model.js`: pure search/sort/latency-color functions.
- `frontend/config.js`: pure VMess/VLESS/Trojan/Shadowsocks share-link parser and subscription payload decoder. No network I/O or DOM dependencies.
- `frontend/store.js`: repository with transactional localStorage persistence, stable subscription IDs, update/rename/hidden-node preservation, CRUD and favorites.
- `src-tauri/src/lib.rs`: two Rust IPC commands: clipboard reader and HTTP(S) subscription fetch (limits, no logging of URL secrets).
- `tests/`: 29 passing Node built-in `node:test` cases. Browser smoke script is optional (environment blocked).

## Data flow
Clipboard -> `parseImport()` -> manual records OR subscription naming modal -> `addSubscription()` -> `fetch_subscription_text` native IPC -> `parseSubscriptionPayload()` -> `refreshSubscription()` -> localStorage -> list view.

Stored record fields include `uri` (the share link, including credentials), protocol type, host, port, display name, favorite, signature, stable ID, subscriptionId and latency placeholder; subscription records include user-display name, private URL, last update/error, hidden signatures and ID. `Source` is derived via subscriptionId rather than copied into each record.

## Security assumptions
Stored URIs and subscription URLs are plaintext in WebView localStorage. Never log or commit real tokens. During public beta preparation, consider per-user OS encryption (DPAPI) and validation of download TLS policies. User input is rendered with `textContent`, not inserted as `innerHTML`.

## Phase boundaries
Phase 2 cannot connect to proxy servers or measure real latency. Phase 3 will integrate Xray-core as an external packaged runtime; Phase 4 implements HTTP real-delay probes; Phase 5 tray/startup; Phase 6 Windows packaging and release.

## Reference licenses
Xray-core MPL-2.0: https://github.com/XTLS/Xray-core/blob/main/LICENSE
V2Fly/V2Ray MIT: https://github.com/v2fly/v2ray-core/blob/master/LICENSE
Only patterns and public documentation have been consulted: no upstream implementation code has been copied.
