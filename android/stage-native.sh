#!/usr/bin/env bash
set -euo pipefail

android_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT
cd "$stage_dir"

curl --fail --location --retry 2 -o libxray.zip \
    https://github.com/XTLS/libXray/releases/download/v26.11.9/libxray-android.zip
curl --fail --location --retry 2 -o hev-socks5-tunnel.aar \
    https://github.com/heiher/hev-socks5-tunnel/releases/download/2.20.0/hev-socks5-tunnel.aar
sha256sum --check <<'HASHES'
1b1aa12124a7112af983a6cea74c77f27aadc6b650acf3c5a57019619ba9fa48  libxray.zip
ae8a2e96b80b4eccccd037805a4bb4a278090c89dbcae8bc6fcb7634e9a255b9  hev-socks5-tunnel.aar
HASHES

unzip -p libxray.zip libxray-android/libXray.aar > libXray.aar
install -Dm644 libXray.aar "$android_dir/app/libs/libXray.aar"
install -Dm644 hev-socks5-tunnel.aar "$android_dir/app/libs/hev-socks5-tunnel.aar"
