# SimpleRAY

SimpleRAY is a Windows desktop client for Xray. It brings server profiles, subscriptions, latency testing, and quick server switching into one window. You can connect through Windows System Proxy or use TUN to route traffic by app. The Android beta uses the same profile formats with a native Android VPN.

## Download for Windows

**Stable 1.2.5 · Windows x64**

[Download the Windows installer](https://github.com/AmirrezaShafiei/SimpleRay/releases/download/v1.2.5/SimpleRay_1.2.5_x64-setup.exe) · [Release notes](https://github.com/AmirrezaShafiei/SimpleRay/releases/tag/v1.2.5) · [SHA-256 checksums](https://github.com/AmirrezaShafiei/SimpleRay/releases/download/v1.2.5/SHA256SUMS.txt)

The unsigned installer bundles Xray-core and Wintun. To check the download, run `Get-FileHash .\SimpleRay_1.2.5_x64-setup.exe -Algorithm SHA256` in PowerShell and compare the result with `SHA256SUMS.txt`.

## Download for Android

**0.2.0-beta.2 · Android 10+ · ARM64 or x86-64**

[Standard APK](https://github.com/AmirrezaShafiei/SimpleRay/releases/download/android-v0.2.0-beta.2/SimpleRAY-Android-0.2.0-beta.2.apk) · [Side-by-side APK](https://github.com/AmirrezaShafiei/SimpleRay/releases/download/android-v0.2.0-beta.2/SimpleRAY-Android-0.2.0-beta.2-Side-by-side.apk) · [Release notes and checksums](https://github.com/AmirrezaShafiei/SimpleRay/releases/tag/android-v0.2.0-beta.2)

Use the standard APK for a fresh installation. If an earlier beta is installed, the side-by-side APK opens as **SimpleRAY Preview** and keeps the previous app and its profiles available. See the [Android build and backup guide](https://github.com/AmirrezaShafiei/SimpleRay/tree/android-v0.2.0-beta.2/android).

## Get connected

1. Install and open SimpleRAY. Have a server configuration or subscription URL ready.
2. Import your connection details.
   - **Single server** — Copy its share link and click **Paste**.
   - **Subscription** — Open **Paste ▾ → Add subscription**, enter a name and URL, then click **Save & Update**.
   - **From a phone** — Open **From phone** and scan the QR code on the same trusted Wi-Fi or a personal hotspot. Open the page on your phone, paste the link and tap **Send**. A subscription URL opens **Add subscription** with the URL already filled in.
3. Select a server and click **Connect**. Use **Ping All** to compare latency before choosing.

Supported imports include VLESS, VMess, Trojan, Shadowsocks, Hysteria2, WireGuard, SOCKS5 and HTTP(S) proxy links. SimpleRAY also accepts WireGuard configuration text.

## Everyday controls

- **Subscriptions** — In **Manage subscriptions**, edit a URL, refresh manually, or set an optional refresh every 6 or 24 hours while SimpleRAY is running. Click a subscription name to filter the server list. Refreshes keep Favorites for servers that still match, and a failed refresh preserves the last successful list.
- **Latency and switching** — **Ping All** supports one, two or three probes, with two by default. With multiple probes, the first result appears immediately, followed by the average of successful probes. **Suggest** asks before switching. **Automatic** can switch on its own. Either mode can test up to six alternatives from Favorites or a chosen subscription.
- **System tray** — Right-click the tray icon to search for or switch servers, open SimpleRAY, or exit. Closing the main window keeps it running in the tray by default. **Start with Windows** starts the app at sign-in by default. **Auto-connect** is a separate setting and starts off.
- **Connection status** — The app monitors the active tunnel and can reconnect after sleep or a network change. Use the globe icon beside the connection status to see the server’s exit IP history.
- **Appearance** — Choose Ocean, Jade, Violet, or a custom palette. Light, Dark, and System appearance work independently of the palette.

## Connection modes

Open **Settings → Routing → Manage rules** to change modes.

| Mode | Traffic it handles | Routing options |
| --- | --- | --- |
| **System Proxy** (default) | Apps that use the Windows proxy settings. | Route selected domains directly or through the tunnel. |
| **TUN (Route by app)** | Traffic at the Windows network level. Launch SimpleRAY as administrator to use it. | Route by app or domain. Optional **Tunnel lock** for apps routed through the tunnel requires Windows Firewall. |

## Troubleshooting

Use **Help → Error report** in the app to preview and copy a diagnostic report. When reporting a problem, include your SimpleRAY version, connection mode, and steps to reproduce it. Keep subscription URLs, share links and credentials out of reports you post. [GitHub Issues](https://github.com/AmirrezaShafiei/SimpleRay/issues)

Configuration and subscription credentials are stored locally without encryption. Use a trusted Windows profile. The QR transfer uses temporary local HTTP, so use it on a trusted network.

## Build from source

Check out [`v1.2.5`](https://github.com/AmirrezaShafiei/SimpleRay/tree/v1.2.5) to build the current Windows release.

- `npm ci` installs dependencies. `npm test` runs the JavaScript test suite. `npm run dev` opens a browser preview of the UI.
- For the native desktop app, use Windows x64 with Node.js 22, Rust, the MSVC C++ build tools and WebView2. Stage the verified Xray-core and Wintun assets using the steps in the [Windows build workflow](https://github.com/AmirrezaShafiei/SimpleRay/blob/v1.2.5/.github/workflows/windows-beta.yml).
- `npm run desktop:dev` runs the native app. `npm run desktop:build` builds the NSIS installer.

The bundled Xray-core is distributed under MPL-2.0. [XTLS/Xray-core](https://github.com/XTLS/Xray-core)
