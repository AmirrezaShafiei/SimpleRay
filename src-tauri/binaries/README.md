# Xray runtime binary

No executable is committed to Git. Windows builds stage a pinned official
Xray-core release into this directory, then package it as a Tauri resource.
For local development use `scripts/stage-xray.ps1` with a trusted SHA256.
Never commit credentials, subscription links or user-specific server files.
