# SimpleRay

Minimal, single-window Windows desktop proxy client built on Tauri and Xray-core.

> **Status:** Phase 1/2 interface and configuration logic, Phase 3/4 Xray integration and HTTP real-delay source are implemented. **No verified native Windows build or installer yet. Do not treat the existing source as an installed production client.**

## Features implemented in source
- Single-window Dark/Light themes; no sidebar
- Clipboard import, named subscriptions and refresh, Source column, favorites, search, sort, editing/duplication/removal
- One balanced connection switch for on/off and double-click server switching
- Xray-core subprocess validation + real proxied 204 preflight before WinINet System Proxy takeover; clean disconnect and recovery logic
- Measured traffic upload/download bytes/s via Xray StatsService (not sample data)
- Main Ping button next to Update, default 3 real-delay HTTPS samples/average or 1 sample in Settings, per-node right-click ×1/×3, text-only latency colors

## Local Windows setup (development, requires validation)
1. Install Windows Rust toolchain, MSVC Build Tools, Node.js, and Tauri prerequisites/WebView2.
2. Download the Xray-core Windows release from the official https://github.com/XTLS/Xray-core/releases and independently verify its SHA256.
3. Stage the verified archive with `powershell -ExecutionPolicy Bypass -File scripts/stage-xray.ps1 -Archive C:\\Downloads\\Xray-windows-64.zip -Sha256 <your-verified-hash>`; `xray.exe` is intentionally gitignored.
4. Run `npm install`, then `npm run desktop:dev` from the repository root.
5. Run `npm test` (43 JS/static tests) and `npm run build` (syntax/source checker only). `npm run desktop:build` is a native build and requires a working Windows toolchain and a properly bundled Xray binary before distributing.

## Limitations
- Windows System Proxy is WinINet HTTP/HTTPS only, not transparent TUN.
- LocalStorage currently holds plaintext profile secrets from Phase 2; encrypted storage is not yet implemented.
- Not every Xray share-link option is supported. Unknown options may be rejected to avoid false connectivity.
- Live Windows Tauri/Xray process and registry integration cannot be claimed tested in the current build environment.
- Tray, Windows startup, final settings and packaging are reserved for Phases 5 and 6.

## Handoff
Read [PROJECT_STATUS.md](PROJECT_STATUS.md), [ROADMAP.md](ROADMAP.md), [SPEC.md](SPEC.md), [ARCHITECTURE.md](ARCHITECTURE.md), [PHASE3_REPORT.md](PHASE3_REPORT.md), and [PHASE4_REPORT.md](PHASE4_REPORT.md). Continue only when the user explicitly requests another phase.

## References
Xray-core (MPL 2.0): https://github.com/XTLS/Xray-core  
V2Fly (MIT): https://github.com/v2fly/v2ray-core
