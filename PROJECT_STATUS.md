# SimpleRay — Project handoff / current status

**Updated:** 2026-11-18
**Repository:** `AmirrezaShafiei/SimpleRay` (private), branch `main`.
**Product spec:** [SPEC.md](SPEC.md); **Visual reference:** [design/reference.jpg](design/reference.jpg); **Plan:** [ROADMAP.md](ROADMAP.md).

## Current implementation
User explicitly requested Phases 5 and 6 together. All six phases have source-level implementation in GitHub. **This does NOT mean an installed Windows client or real proxy connectivity has passed QA.**

| Phase | Scope | State |
|---|---|---|
| 1 | Tauri shell, one-window Dark/Light UI, sort, context menu | Source; Windows visual QA pending |
| 2 | Share links, named subscriptions, refresh, saved entries | Source; live subscription and secure-storage QA pending |
| 3 | Xray-core connect/disconnect, System Proxy, live traffic | Source; Windows & live-server verification pending |
| 4 | HTTP-through-proxy Ping x1/x3, average, cancel, sort | Source; real-server verification pending |
| 5 | System Tray, Start with Windows, separate Auto-connect and settings | **Source committed; native Windows QA pending** |
| 6 | Tests, official Xray staging, unsigned NSIS beta pipeline | **51/51 local Node tests passed; Windows CI build pending** |

## Windows CI / beta candidate
- Workflow: [.github/workflows/windows-beta.yml](.github/workflows/windows-beta.yml)
- Initial Windows build: [GitHub Actions run 44382246461](https://github.com/AmirrezaShafiei/SimpleRay/actions/runs/44382246461)
- Candidate version: **0.5.0-beta.1**.
- Core: official Xray-core **v26.11.9**, bundled as an independent MPL-2.0 component. Official release archive SHA-256 and matching official digest manifest must pass.
- CI tests JavaScript + Rust, validates Xray config, builds NSIS, uploads installer and creates a **prerelease only upon successful verification**. **Do not say the installer exists until the run and Release assets actually show success.**
- Local Linux environment: **51/51 Node tests passed** and static source checks passed; no Rust/Cargo toolchain. Interactive browser smoke blocked by `net::ERR_BLOCKED_BY_ADMINISTRATOR`; native Windows build and real remote profile tests are unverified.
- See [PHASE5_REPORT.md](PHASE5_REPORT.md) and [PHASE6_REPORT.md](PHASE6_REPORT.md).

## Key design requirements
- Single window, no sidebar; same compact ON/OFF toggle does connect and disconnect; speeds appear next to it only when connected.
- Source column = named subscription or `—` for manual; no Remarks column.
- Favorites, clickable sorted column headers, unboxed colored latency text.
- Toolbar Ping after Update: three proxy HTTP probes averaged by default, 1 probe selectable in Settings; node Ping from right-click.
- Default close-to-tray, explicit Tray Exit restores user proxy; Start with Windows and Auto-connect are independent toggles.
- System Proxy only; TUN and split-tunneling not included.

## Important issues / remaining manual gates
1. **Plaintext secret storage:** share URIs and subscription tokens are in WebView localStorage. This is a security caveat for private testing and must be replaced by OS-backed encrypted persistence before broad distribution.
2. Windows native Rust compile and Windows NSIS artifact must be observed, not inferred from source checks.
3. Need real Xray test profiles to validate supported transports/protocols, actual Ping, down/up statistics, system proxy switching and restore, crash handling.
4. Signing is not configured; Windows SmartScreen may warn about the unsigned installer.
5. Browser automation in this environment cannot access localhost due to admin policy.
6. Verify login startup, closing to Tray, explicit Exit, and error behavior on a real Windows system.

## Continuing in a different chat
Read this file **first**, then [SPEC.md](SPEC.md), [ROADMAP.md](ROADMAP.md), and reports PHASE1–PHASE6. Check GitHub Actions and GitHub Releases before claiming a Windows installer. Do not assume the native application works from passing static tests. The user expects a visually minimalist client matching the checked-in screenshot, with user-approved changes.
