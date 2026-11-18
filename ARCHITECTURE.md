# SimpleRay architecture — phases 1–6 candidate

## Windows desktop
- Tauri 2 native shell + static ES-module HTML/CSS/JS frontend; one window, Dark/Light/System themes, no sidebar.
- `frontend/config.js`: VMess/VLESS/Trojan/Shadowsocks import parsing; `frontend/store.js`: local server/subscription metadata and selected server; `frontend/xray-config.js`: restricted Xray outbound mapping.
- `frontend/main.js`: UI, state transitions, alerts, CRUD, update, Ping All and native desktop setting toggles.
- `frontend/runtime.js`: bounded-concurrency HTTP latency aggregation and speed formatting.

## Native Rust
- `src-tauri/src/lib.rs`: native clipboard/fetch, connection, ping, shell settings/IPC, startup recovery.
- `src-tauri/src/engine.rs`: Xray binary/resource lookup, outbound verification, local Xray subprocess, HTTPS 204 verification, loopback gRPC StatsService and real-delay measurements; rate counter resets.
- `src-tauri/src/system_proxy.rs`: Windows HKCU WinINet proxy snapshot, switch, guarded restore and crash-recovery file. Changes apply to System Proxy aware apps, not TUN.
- `src-tauri/src/tray.rs`: Tauri tray Show / Connect-Disconnect / Exit, close-to-tray, focus, guarded cleanup-before-exit. Tray toggle dispatches an event to the existing WebView.
- `src-tauri/src/preferences.rs`: desktop settings saved under local app data; Windows Run HKCU autostart entry using `--minimized`; independent opt-in Auto-connect default OFF.

## Xray and distribution
- Runtime: independently licensed official Xray-core MPL-2.0. No reimplemented cryptography. The official executable is not committed; Windows CI downloads a **pinned v26.11.9 Windows x64** archive with SHA256 verification.
- Bundled as Tauri `binaries/xray.exe`, `geoip.dat`, `geosite.dat`, and upstream license; Rust resolves Tauri resource_dir, or user-provided absolute `SIMPLERAY_XRAY_PATH`.
- `.github/workflows/windows-beta.yml`: Windows runner, Node tests, Rust tests, Xray config validation, NSIS installer, artifact upload, guarded prerelease.
- Unverified: Rust Windows native build/runtime in this environment. See [PHASE6_REPORT.md](PHASE6_REPORT.md).

## Limitations and security
- Server credentials/subscription tokens remain plaintext in WebView localStorage pending Windows DPAPI or equivalent; do not promote to general-purpose secure client until fixed.
- Do not commit tokens or user profiles to source. The Xray process config temp dir is removed when child exits.
- Installation is unsigned; code signing and operational Windows E2E smoke tests are pending.
- See [SPEC.md](SPEC.md) for UI and behavioral decisions; [PROJECT_STATUS.md](PROJECT_STATUS.md) for the latest state and GitHub run.
