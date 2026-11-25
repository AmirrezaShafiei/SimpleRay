# SimpleRay — minimal Windows Xray client

Single-window, no-sidebar V2Ray/Xray client with three theme palettes, a Custom palette, and a separate Light/Dark/System setting, compact connect switch, named subscriptions, stars, real-delay Ping and System Proxy mode.

Download the Windows x64 installer and its SHA-256 checksum from the [SimpleRAY 1.2 release](https://github.com/AmirrezaShafiei/SimpleRay/releases/tag/v1.2.0).

## Features in source
- Clipboard import of VMess, VLESS, Trojan, Shadowsocks, WireGuard, Hysteria2, SOCKS5, and HTTP(S) proxy links. WireGuard configuration text and named HTTP(S) subscriptions are supported.
- Click any table header to sort. Up to three pinned servers stay at the top. Flags come from the country code, name, or flag in the profile label.
- Context-menu Ping and Ping All offer 1, 2 or 3 HTTP-through-proxy probes, with two by default for new settings. Ping All checks up to four servers at a time and finishes the initial pass before starting the final probe. Multi-probe requests show the first result and then the average of successful probes.
- One switch for real connect/disconnect using official Xray-core and Windows System Proxy. The connected panel shows live rates and the total bytes of the current session.
- **Test download** under the live rates measures the active tunnel with a transfer of up to 3 MB. Click the result to run the test again.
- **Route by website** accepts domains, pasted web URLs, and suffixes such as `.ir`. Use **Check route** to preview which website rule matches. App rules take priority in TUN mode.
- System Tray Show / Connect-Disconnect / Exit; closing window hides to tray by default; explicit Exit attempts System Proxy restoration before exit.
- Start with Windows under HKCU user registry; separate Auto-connect option (OFF by default).
- Ocean, Jade, Violet and Custom each work with Light, Dark or System appearance. Custom saves primary and accent colors in Settings.
- In Suggest mode, a short optional switch prompt appears above the taskbar when the main window is hidden or minimized.
- **From phone** opens a temporary one-use QR on a private local network. Paste a share link into the phone browser. SimpleRay reuses an existing equivalent profile, tests it from the PC, and offers to connect after a successful test. WireGuard configuration text can be pasted into the same form. Use a trusted Wi-Fi network or personal hotspot because the transfer uses local HTTP.

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
**Sensitive share URIs and subscription URLs are currently stored as plaintext local WebView data. Use only on a trusted Windows user profile. Encrypted OS-backed storage is required before wide public distribution.** TUN mode requires administrator access. The NSIS installer is not digitally signed.

## Project handoff
Read [PROJECT_STATUS.md](PROJECT_STATUS.md), [SPEC.md](SPEC.md), [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), then [PHASE5_REPORT.md](PHASE5_REPORT.md) and [PHASE6_REPORT.md](PHASE6_REPORT.md). Screenshot: [design/reference.jpg](design/reference.jpg).

Core reference: [XTLS/Xray-core](https://github.com/XTLS/Xray-core) (MPL-2.0). V2Fly/V2Ray (MIT) consulted as conceptual reference, not directly copied.
