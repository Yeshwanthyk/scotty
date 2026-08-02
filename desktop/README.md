# Scotty Desktop

A native GPUI viewport for remote Scotty sessions. It changes only the selected
view; the Sandbox Durable Object and existing Pi supervisor retain lifecycle,
transcript, command, and credential authority.

## Vertical slices

1. **Sidecar boundary** — compiled Bun child loads the paired-client config and
   emits bounded, redacted fleet/selected projections over NDJSON stdio.
2. **Fleet shell** — native window lists every projected session and selects
   only warm Cloudflare sessions.
3. **Live session** — selection hydrates the passive snapshot, follows SSE, and
   renders messages, tools, waiting input, reconnect, and unavailable states.
4. **Controls** — composer routes prompt/steer/follow-up/abort and blocking UI
   answers through the existing revision- and epoch-fenced controller.
5. **Bundle** — package the Rust viewport and compiled sidecar together without
   a local Pi, Codex, Comet engine, or credential manager.

Every slice is independently demoable with the existing fake transport tests.

## Development

```sh
node scripts/build-scotty-desktop-sidecar.mjs
SCOTTY_DESKTOP_SIDECAR="$PWD/dist/scotty-console-sidecar" \
  cargo run --manifest-path desktop/Cargo.toml -p scotty-desktop
```

Use `SCOTTY_DESKTOP_CONFIG` to point at a non-default paired-client config. It
is a path, not a credential. The sidecar reads and renews the credential itself;
the Rust process never receives it.

Run the native shell without a Scotty deployment using the credential-free fixture:

```sh
SCOTTY_DESKTOP_SIDECAR="$PWD/desktop/fixtures/fake-sidecar.mjs" \
  cargo run --manifest-path desktop/Cargo.toml -p scotty-desktop
```

## Verification

```sh
npm run test:pi-scotty
npm run typecheck:pi-scotty
cargo fmt --manifest-path desktop/Cargo.toml --all -- --check
cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path desktop/Cargo.toml
```

`npm run build:desktop` produces an ad-hoc-signed development bundle. It is not a distribution artifact: Developer ID signing, the complete Cargo dependency license closure, hardened-runtime entitlement proof, notarization, and stapling remain release gates.

See [`COMET_UPSTREAM.md`](COMET_UPSTREAM.md) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for provenance.
