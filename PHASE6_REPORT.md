# Phase 6 — QA and unsigned Windows beta build

**Date:** 2026-11-18

## Implementation / delivery mechanism
- Version set to `0.5.0-beta.1` in npm, Tauri and Cargo manifests.
- GitHub Actions Windows 2022 workflow `.github/workflows/windows-beta.yml`:
  1. Node 22 test and JS syntax/source checks.
  2. Fetch official **XTLS/Xray-core v26.11.9** Windows x64 ZIP from its pinned release, verify official `.dgst` and expected SHA-256 (`1262522266337b824f07beb8e1375786b437683b3890105469088f8e17e0a69d`).
  3. Stage the official `xray.exe`, `geoip.dat`, `geosite.dat`, and license in Tauri resources; verify core version and a credential-free sample API configuration via `xray run -test`.
  4. Run Rust unit tests, compile the Windows NSIS installer, upload artifacts, then publish a **GitHub prerelease ONLY after all the preceding stages succeed**.
- Added Tauri resource-dir discovery for official Xray-core binary and asset location (works for packaged installs rather than only developer folders).
- Corrected Xray gRPC stats wiring to use a loopback-only API inbound and routing rule, with StatsService enabled.
- Continued using System Proxy crash-recovery snapshot to avoid overriding externally changed proxy configuration.

## Checks performed in this environment
- **51/51 Node tests passed**, includes Phase 5 tray/startup contract checks and Phase 6 packaging/static checks.
- `npm run build` passed (JS syntax/source/manifest assertions only).
- Browser smoke attempted; blocked (`ERR_BLOCKED_BY_ADMINISTRATOR`). No successful graphical smoke test claimed.
- Rust compilation, NSIS build, Xray validation and real-server end-to-end connection **cannot run in this environment**. The Windows CI workflow is intended to execute them after commit.

## Release readiness / known limitations
- Installer and GitHub prerelease are **conditional on a successful Windows Actions run**. Do not claim a downloadable `.exe` exists unless an actual Actions artifact or Release asset has been verified.
- Unsigned binary, so Windows SmartScreen may warn. No security or trust promise is implied by tests alone.
- Imported configs and subscription secrets are **still in plaintext local WebView storage**. Use only in a trusted local profile; OS-scoped encrypted persistence is an important follow-up before broad distribution.
- No end-to-end user credentials or live remote VLESS/VMess/Trojan/Shadowsocks servers were available for testing; profile compatibility / system proxy restoration / live traffic and Ping remain manual Windows QA requirements.
- Tested network path uses System Proxy and does not provide TUN or a global VPN tunnel.
- No support for full Clash YAML/sing-box JSON subscription formats; only share-link formats described in SPEC.md.

## Windows QA checklist (must perform before calling the beta production-ready)
- [ ] CI Windows Rust build and NSIS installer pass.
- [ ] Fresh installation, start/exit, theme change and persisted settings.
- [ ] Import each of 4 protocol types, subscription naming/update/error recovery.
- [ ] Connect/switch/disconnect, verify system proxy restore on quit/crash.
- [ ] Ping x1, x3, timeout/partial success, sort & favorites after refresh.
- [ ] Tray show/hide, start at login and auto-connect toggle.
- [ ] Confirm Xray stats reports actual down/up during web traffic.
- [ ] Test protected user-profile storage before public release.

## References and licenses
- Xray-core official release: https://github.com/XTLS/Xray-core/releases/tag/v26.11.9
- Xray MPL-2.0: https://github.com/XTLS/Xray-core/blob/main/LICENSE
- Tauri official Windows installer and tray docs: https://v2.tauri.app/distribute/windows-installer/ and https://v2.tauri.app/learn/system-tray/
