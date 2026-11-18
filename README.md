# SimpleRay — minimal Windows Xray client

Single-window, no-sidebar V2Ray/Xray client with Dark/Light/System themes, compact connect switch, named subscriptions, stars, real-delay Ping and System Proxy mode.

> **Status:** Version `0.5.0-beta.1` **source candidate** for Phases 1–6. **51/51 local Node tests passed.** Native Windows integration, real-server connections and installer are only verified after GitHub Actions/Windows tests succeed. Do not assume a completed installer from this README alone.

## Features in source
- Clipboard import of VMess, VLESS, Trojan, Shadowsocks, plus manually named subscriptions and update/rename/delete.
- Table Source column is subscription name or `—`; numeric colored latency text without boxed badges; sort by clicking any header.
- Context-menu single-node Ping x1/x3; toolbar Ping All next to Update, default 3 HTTP-through-proxy tests averaged (Settings may select 1).
- One switch for real connect/disconnect using official Xray-core; live traffic arrows appear only when connected; System Proxy on Windows.
- System Tray Show / Connect-Disconnect / Exit; closing window hides to tray by default; explicit Exit attempts System Proxy restoration before exit.
- Start with Windows under HKCU user registry; separate Auto-connect option (OFF by default).
- Consistent Dark/Light/System themes and a small gear Settings panel.

## Test source locally
- `npm install` — fetch Tauri CLI build dependencies
- `npm test` — Node unit/static tests (51/51 in current runner).
- `npm run build` — checks source/JS syntax **ONLY**, not native code.
- `npm run dev` — browser UI preview **without native connections**.
- `npm run desktop:dev` — requires Windows, Rust/Cargo, MSVC, WebView2, verified official Xray binary staged in `src-tauri/binaries/`.
- `npm run desktop:build` — Windows NSIS installer (requires those native build dependencies and staged core assets).

For manual Xray staging, use `scripts/stage-xray.ps1` with a separately trusted 64-character SHA256. CI pins official Xray-core v26.11.9.

## Windows beta pipeline
- [.github/workflows/windows-beta.yml](.github/workflows/windows-beta.yml) builds on Windows 2022 and verifies official Xray ZIP SHA256, Xray API fixture, Node/Rust tests, NSIS package, and then uploads the installer; only successful CI publishes an **unsigned** GitHub prerelease.
- [GitHub Actions run](https://github.com/AmirrezaShafiei/SimpleRay/actions/runs/44382246461) and [Releases](https://github.com/AmirrezaShafiei/SimpleRay/releases) are the sources of truth about installer availability.

## Security and limits
**Sensitive share URIs and subscription URLs are currently stored as plaintext local WebView data. Use only on a trusted Windows user profile. Encrypted OS-backed storage is required before wide public distribution.** This beta has no TUN, split tunnel or browser extension. The NSIS installer is not digitally signed.

## Project handoff
Read [PROJECT_STATUS.md](PROJECT_STATUS.md), [SPEC.md](SPEC.md), [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), then [PHASE5_REPORT.md](PHASE5_REPORT.md) and [PHASE6_REPORT.md](PHASE6_REPORT.md). Screenshot: [design/reference.jpg](design/reference.jpg).

Core reference: [XTLS/Xray-core](https://github.com/XTLS/Xray-core) (MPL-2.0). V2Fly/V2Ray (MIT) consulted as conceptual reference, not directly copied.
