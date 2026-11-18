#!/usr/bin/env bash
# Build the app and start it on your own Scotty.
# An ad-hoc signed build is a new app to the Keychain each time, so macOS asks again before it reads
# the saved sign-in. Signing with your Apple Development identity keeps "Always Allow" across builds.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
cargo build --release --quiet
exe=target/release/scotty-mac
identity="$(security find-identity -v -p codesigning | awk '/"Apple Development: /{print $2; exit}')"
if [ -n "$identity" ]; then
  codesign --force --identifier dev.scotty.mac --sign "$identity" "$exe"
else
  echo "No Apple Development identity: macOS will ask for Keychain access after each build." >&2
fi
exec "$exe" "$@"
