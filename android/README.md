# SimpleRAY Android

The Android app is based on the Windows v1.2.5 import rules and the Ocean, Jade,
Violet and Custom palettes. Its mobile UI packages the shared parser, profile
store, sorting rules and color wheel from `frontend/` at build time. Android
uses its own VPN lifecycle, native QR scanner, share target, notification and
Quick Settings tile.

The first version of this branch is `0.2.0-beta.1`, for Android 10 and newer on
64-bit ARM or x86 devices. It uses application ID
`io.github.amirrezashafiei.simpleray.mobile` so it installs alongside the
earlier APK. Share a config or subscription URL to import it into this app.

Use **Settings → Android connection** to adjust connection behavior or open
Android's Always-on VPN controls. Routing rules apply to apps that use the VPN.
A website rule can select Direct or Tunnel, and Check route previews the saved
rule matching. The rules use domain information available to Xray.

## Build locally

Install a JDK (17 or later), Android SDK Platform 35 and Build Tools 35.0.0.
Set `ANDROID_HOME` or `sdk.dir` in `local.properties`. From this folder, run:

```sh
./stage-native.sh
./gradlew :app:assembleDebug :app:lintDebug
```

The staging script verifies the two pinned native libraries before installing
them into the local build folder. The debug APK is written to
`app/build/outputs/apk/debug/app-debug.apk`. Both 64-bit ABIs are included.

Each app install encrypts its data with a key in Android Keystore. Native
downloads and probes run off the UI thread. The active tunnel uses Xray-core
and HEV to forward packets from Android's VPN interface. Server probes run in
a separate process, so they can be used while the tunnel is active. The APK
includes the native dependencies' license texts and source links.

The Windows package and its release process are independent of this folder.
