#!/bin/sh
set -eu

# Run inside the Scotty image. Fresh homes prove package downloads through
# the image's ordinary OS trust store, without ambient credentials or TLS overrides.
probe_dir=$(mktemp -d /tmp/scotty-language-downloads.XXXXXX)
trap 'rm -rf "$probe_dir"' EXIT
mkdir -p "$probe_dir/home" "$probe_dir/cargo-home" "$probe_dir/src"
cd "$probe_dir"

if env -i \
  HOME="$probe_dir/home" \
  PATH=/usr/local/bin:/usr/bin:/bin \
  GOPATH="$probe_dir/go" \
  GOPROXY=https://proxy.golang.org \
  GOSUMDB=sum.golang.org \
  GOTOOLCHAIN=local \
  timeout 90s go mod download -json github.com/google/uuid@v1.6.0 \
  >"$probe_dir/go.json" 2>"$probe_dir/go.err"; then
  jq -e '.Path == "github.com/google/uuid" and .Version == "v1.6.0" and (.Error == null)' \
    "$probe_dir/go.json" >/dev/null
  test -s "$probe_dir/go/pkg/mod/cache/download/github.com/google/uuid/@v/v1.6.0.zip"
  printf 'GO_DOWNLOAD=ok MODULE=github.com/google/uuid VERSION=v1.6.0 TLS=strict\n'
else
  status=$?
  printf 'GO_DOWNLOAD=failed EXIT=%s\n' "$status" >&2
  head -c 700 "$probe_dir/go.err" >&2
  exit "$status"
fi

cat >"$probe_dir/Cargo.toml" <<'EOF'
[package]
name = "scotty_tls_probe"
version = "0.1.0"
edition = "2024"

[dependencies]
itoa = "=1.0.15"
EOF
printf 'fn main() {}\n' >"$probe_dir/src/main.rs"

if env -i \
  HOME="$probe_dir/home" \
  PATH=/usr/local/bin:/usr/bin:/bin \
  CARGO_HOME="$probe_dir/cargo-home" \
  CARGO_NET_RETRY=0 \
  CARGO_HTTP_TIMEOUT=30 \
  CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
  timeout 90s cargo fetch --manifest-path "$probe_dir/Cargo.toml" \
  >"$probe_dir/cargo.log" 2>&1; then
  test -d "$probe_dir/cargo-home/registry/cache"
  test -n "$(find "$probe_dir/cargo-home/registry/cache" -name itoa-1.0.15.crate -print -quit)"
  printf 'CARGO_DOWNLOAD=ok CRATE=itoa VERSION=1.0.15 TLS=strict\n'
else
  status=$?
  printf 'CARGO_DOWNLOAD=failed EXIT=%s\n' "$status" >&2
  head -c 700 "$probe_dir/cargo.log" >&2
  exit "$status"
fi
