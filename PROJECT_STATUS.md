# SimpleRay — current status

**Updated** 2026-11-19  
**Version** 0.5.0-beta.4, Windows x64  
**Repository** `AmirrezaShafiei/SimpleRay` (private)  
**Build commit** `640e4eba0cebde9735007ff7c0c77382cb8289c8`

The six-phase beta is available as a Windows x64 setup with the official Xray-core v26.11.9 and its geo databases included. The installer is unsigned.

- [Windows setup](https://github.com/AmirrezaShafiei/SimpleRay/releases/download/v0.5.0-beta.4/SimpleRay_0.5.0-beta.4_x64-setup.exe)
- [Private beta release and SHA-256 checksums](https://github.com/AmirrezaShafiei/SimpleRay/releases/tag/v0.5.0-beta.4)
- [Windows build and installation run](https://github.com/AmirrezaShafiei/SimpleRay/actions/runs/44434435318)

## Beta.4 changes verified

- Native background monitoring updates the active latency every 10 seconds and shows how many of the latest 10 probes answered. This continues in the tray. A manual probe remains available.
- Settings offers Off (default), Suggest and Automatic. A comparison round uses up to four candidates in saved order from Favorites or one subscription. A healthy connection is eligible for a change after two qualifying rounds, a reduction of at least 150 ms and 40%, and an 80% candidate success rate with at least two samples. A 90-second cooldown applies to latency-driven switching.
- Two scheduled failures trigger recovery in Suggest or Automatic. Recovery prioritizes a responsive candidate and backs off to 30, 60 and at most 120 seconds if a usable switch is unavailable. Proxy state is displayed separately. Automatic switches can be undone for 20 seconds.
- Kept the layout and theme palette. The desktop toolbar, search and dialog controls use flatter surfaces, smaller corners and an underlined search field.
- Windows CI passed 54 JavaScript checks, native tests including the switch policy and WinINet round trip, and the NSIS install/start/single-instance smoke check. The UI flows were also exercised with mocked native responses. Real-profile network transitions still need hands-on verification.

## Beta.3 changes verified

- Removed the outer app frame. The theme-colored titlebar provides minimize, maximize, restore and close. The initial window opens at 960 × 620 logical pixels and shows the installed app version.
- WinINet applies and verifies the Windows user proxy by default on connection. If it is switched off during a session, the footer offers **Restore proxy**. Windows CI passed an actual set, read-back and restore test.
- The small button beside Live latency sends a fresh HTTPS probe through the running Xray proxy. The frontend displays a result or **No reply** and ignores results from a previous connection.
- The 54 JavaScript checks passed. Windows CI installed the new setup, opened the app and passed the single-instance check.

## Initial six-phase review

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

## Update — 2026-11-19, 0.5.0-beta.5 candidate
User requested (1) nonintrusive Suggest popup while in Tray, with manual quick server switch, (2) Ocean/Forest/Violet + Custom color palettes independent of Light/Dark/System brightness, and (3) default Ping All x2 average. Source implemented on feature/tray-suggest-palettes-ping2; tests/quick-palette-ping.test.mjs added. Windows CI and manual Suggest/Quick Switch QA are still required. The previous 0.5.0-beta.4 Windows CI had a successful run; do not confuse earlier failed beta.1 run with current status. Keep existing switch modes Off/Suggest/Automatic. The new popup **does not** automatically change server in Suggest mode.
