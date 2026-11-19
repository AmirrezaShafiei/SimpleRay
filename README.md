# SimpleRay — minimal Windows Xray client

Single-window, no-sidebar V2Ray/Xray client with Dark/Light/System themes, compact connect switch, named subscriptions, stars, real-delay Ping and System Proxy mode.

> **Status:** Version `0.5.0-beta.3` covers Phases 1–6. The Windows x64 installer and its SHA-256 checksum are attached to the private beta release after the Windows build and installation smoke test pass.

## Features in source
- Clipboard import of VMess, VLESS, Trojan, Shadowsocks, plus manually named subscriptions and update/rename/delete.
- Table Source column is subscription name or `—`; numeric colored latency text without boxed badges; sort by clicking any header.
- Context-menu single-node Ping x1/x3; toolbar Ping All next to Update, default 3 HTTP-through-proxy tests averaged (Settings may select 1).
- One switch for real connect/disconnect using official Xray-core; live traffic arrows appear only when connected; System Proxy on Windows.
- System Tray Show / Connect-Disconnect / Exit; closing window hides to tray by default; explicit Exit attempts System Proxy restoration before exit.
- Start with Windows under HKCU user registry; separate Auto-connect option (OFF by default).
- Consistent Dark/Light/System themes and a small gear Settings panel.

## Test source locally
- `npm ci` — install locked Tauri CLI build dependencies
- `npm test` — run Node unit and static checks.
- `npm run build` — checks source/JS syntax **ONLY**, not native code.
- `npm run dev` — browser UI preview **without native connections**.
- `npm run desktop:dev` — requires Windows, Rust/Cargo, MSVC, WebView2, verified official Xray binary staged in `src-tauri/binaries/`.
- `npm run desktop:build` — Windows NSIS installer (requires those native build dependencies and staged core assets).

For manual Xray staging, use `scripts/stage-xray.ps1` with a separately trusted 64-character SHA256. CI pins official Xray-core v26.11.9.

## Windows beta pipeline
- [.github/workflows/windows-beta.yml](.github/workflows/windows-beta.yml) checks the official Xray ZIP SHA-256, validates the Xray fixture, runs JS and Rust tests, builds NSIS, and smoke-tests installation and single-instance startup.
- The workflow publishes the unsigned setup and checksum directly to [Releases](https://github.com/AmirrezaShafiei/SimpleRay/releases). The preceding beta build produced an installer but could not upload it to Actions artifact storage because its quota was exhausted.

## Security and limits
**Sensitive share URIs and subscription URLs are currently stored as plaintext local WebView data. Use only on a trusted Windows user profile. Encrypted OS-backed storage is required before wide public distribution.** This beta has no TUN, split tunnel or browser extension. The NSIS installer is not digitally signed.

## Project handoff
Read [PROJECT_STATUS.md](PROJECT_STATUS.md), [SPEC.md](SPEC.md), [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), then [PHASE5_REPORT.md](PHASE5_REPORT.md) and [PHASE6_REPORT.md](PHASE6_REPORT.md). Screenshot: [design/reference.jpg](design/reference.jpg).

Core reference: [XTLS/Xray-core](https://github.com/XTLS/Xray-core) (MPL-2.0). V2Fly/V2Ray (MIT) consulted as conceptual reference, not directly copied.
