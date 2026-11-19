# SimpleRay — current status

**Updated** 2026-11-19  
**Version** 0.5.0-beta.2, Windows x64  
**Repository** `AmirrezaShafiei/SimpleRay` (private)  
**Build commit** `e942cbbb527a34290c5bbb1f0da67236ce1fb27d`

The six-phase beta is available as a Windows x64 setup with the official Xray-core v26.11.9 and its geo databases included. The installer is unsigned.

- [Windows setup](https://github.com/AmirrezaShafiei/SimpleRay/releases/download/v0.5.0-beta.2/SimpleRay_0.5.0-beta.2_x64-setup.exe)
- [Private beta release and SHA-256 checksums](https://github.com/AmirrezaShafiei/SimpleRay/releases/tag/v0.5.0-beta.2)
- [Windows build and installation run](https://github.com/AmirrezaShafiei/SimpleRay/actions/runs/44426856247)

## Review by phase

| Phase | Changes and checks |
|---|---|
| 1 | Kept the single-window layout and both themes. Row selection now retains focus and the target of a double-click. Mocked UI smoke tests exercised selection, activation and theme persistence. |
| 2 | Import errors are shown inside their dialogs. Deleting an active subscription's nodes disconnects its active profile. Manual import, named subscriptions, Source and persistence passed automated checks. |
| 3 | System Proxy recovery records are now written atomically. The native monitor reaps failed Xray sessions even when the window is hidden, and externally changed proxy settings appear in the client status. Four isolated loopback protocol fixtures passed traffic and counter checks against Xray-core. |
| 4 | Failed and timed-out latency probes are distinguished, only the Ping toolbar button cancels an active batch, and results from an edited profile are discarded. Loopback probes and automated partial-success and cancellation checks passed. |
| 5 | Added single-instance startup, eliminated the login startup window flash, and made desktop preferences atomic. A Windows startup lookup error no longer blocks independent auto-connect settings. |
| 6 | Locked npm and Rust dependencies. Windows CI ran the JavaScript and Rust suites, built NSIS, installed the bundle, validated the installed Xray, opened SimpleRay and confirmed that a second launch exited while the first stayed running. The setup and checksum went directly to the private GitHub Release, avoiding the Actions artifact storage limit. |

## Manual verification

Real remote subscriptions and server profiles, interactive tray behavior, Windows sign-in and registry recovery after a forced crash still require hands-on verification. Imported share links and subscription URLs are currently stored in the Windows WebView profile without encryption. See [SPEC.md](SPEC.md) and [ROADMAP.md](ROADMAP.md) for the documented product scope.
