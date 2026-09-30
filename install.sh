#!/bin/sh
# Installs the latest scotty binary:
#   curl -fsSL https://github.com/Yeshwanthyk/scotty/releases/latest/download/install.sh | sh
# SCOTTY_INSTALL_DIR picks the folder (default ~/.local/bin). Scotty also needs cloudflared.
set -eu

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) echo "scotty has no binary for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

base=https://github.com/Yeshwanthyk/scotty/releases/latest/download
dir=${SCOTTY_INSTALL_DIR:-$HOME/.local/bin}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/scotty.tar.gz" "$base/scotty-$platform.tar.gz"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
want=$(awk -v f="scotty-$platform.tar.gz" '$2 == f { print $1 }' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/scotty.tar.gz" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp/scotty.tar.gz" | cut -d' ' -f1); fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  echo "scotty-$platform.tar.gz does not match checksums.txt" >&2
  exit 1
fi

tar -xzf "$tmp/scotty.tar.gz" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/scotty" "$dir/scotty"
chmod 755 "$dir/scotty"
echo "Installed scotty to $dir/scotty"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH." ;; esac
command -v cloudflared >/dev/null || echo "Scotty needs cloudflared: brew install cloudflared"
echo "Then run: scotty init"
