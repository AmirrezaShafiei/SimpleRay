# SimpleRay — Changes

## v0.5.0-beta.5 (2026-11-19)

- Tray: compact quick server switch on tray icon left-click; native Suggest-mode notification when minimized, de-duplicated and dismissible; accepting candidate uses existing validated suggestion API rather than silently switching.
- Appearance: Ocean/Forest/Violet palettes and Custom primary/accent colors. Independent Light/Dark/System brightness, persisted with existing local preferences.
- Ping: new two-sample default, 1/2/3 settings options, two-sample per-server context action, Rust and JS validators updated.
- Storage: keep previously saved profiles and subscription data; cross-window selection synchronization.
- QA: new regression tests for palette and Quick Switch. Native Windows GUI behavior remains subject to manual acceptance.

### Known outstanding concerns
- No encryption-at-rest for profile tokens; OS-protected persistence is needed before broad use.
- Manual confirmation with live servers, window focus behavior on multi-monitor setups, and installer smoke testing remain necessary.

### Build and release confirmation
Windows GitHub Actions [44448631002](https://github.com/AmirrezaShafiei/SimpleRay/actions/runs/44448631002) passed JavaScript & Rust tests, Windows System Proxy checks, NSIS installer build and installation/startup smoke test. Published [unsigned v0.5.0-beta.5](https://github.com/AmirrezaShafiei/SimpleRay/releases/tag/v0.5.0-beta.5). Live VPN traffic, user-interface positioning/focus, and real suggestion switching still need interactive validation.
