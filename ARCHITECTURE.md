# Architecture and upstream references

## Phase 1
Frontend: vanilla HTML, CSS and native JavaScript modules with a standalone Node static development server; no third-party UI dependency. Host: Tauri 2 Rust shell for Windows desktop. Tests: Node built-in test runner and Chromium browser automation. The preview works on localhost without Tauri for visual and interaction verification.

## Future phases
- Phase 2: configuration/subscription parsing with redaction, local data persistence and stable subscription IDs.
- Phase 3: process management, core configuration generation, real state machine, local listening endpoint and System Proxy integration.
- Phase 4: real HTTP delay checks routed through each proxy, bounded concurrency, 3-sample average default, single sample option.
- Phase 5: tray, startup and OS cleanup.

## Open-source reference policy
- Xray-core: https://github.com/XTLS/Xray-core (MPL-2.0), intended runtime for production. Keep its license and required notices, and comply with MPL 2.0 if copying/modifying covered files.
- V2Fly/V2Ray core: https://github.com/v2fly/v2ray-core (MIT), useful reference for architecture and proxy behavior where compatible; do not paste code without appropriate attribution/license handling.
- Tauri: https://v2.tauri.app/ — native shell and window integration.
- These are upstream references: **Phase 1 includes no Xray or V2Ray core code/binaries and performs no proxy operations**.
- Before redistributing, recheck the license for every binary/dependency and any third-party assets.

## Limitations
This environment has Node/Chromium but no Rust/Cargo nor Windows build tools. Frontend tests and browser UI checks are possible here; a native Windows build has not been verified. This project does not package a real core or Windows executable in Phase 1.
