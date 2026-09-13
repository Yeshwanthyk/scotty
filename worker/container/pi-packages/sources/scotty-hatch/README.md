# scotty-hatch

First-party Pi and Codex tool for one bounded application Hatch inside a warm Scotty session.

It registers only `scotty_hatch`, with explicit `ensure`, `status`, and `close` operations. The
tool owns only its scoped child process group. Authoritative Hatch state and exposure remain
in the source Sandbox Durable Object behind Scotty's credential-free internal container route.

Tool calls should include `displayText`, a plain, single-line phrase of at most 180 characters
describing the intended task, such as `Starting the invoice preview`. Pi and Codex show it as the
conversation tool label. It is optional for compatibility and removed before execution requests;
older calls retain their default labels. Native shell/edit tools do not expose this parameter.

## Repository configuration

Set up Hatch by committing `hatch.toml` at the repository root:

```toml
[hatch]
service = "web"
argv = ["pnpm", "exec", "vite", "dev", "--host", "0.0.0.0", "--port", "4173"]
cwd = "."
port = 4173
health_path = "/"
ready_timeout_seconds = 60

# Optional: installation, build, and local migrations run before server startup.
[hatch.prepare]
argv = ["bash", "scripts/hatch-prepare.sh"]
timeout_seconds = 600
```

Review the file from the repository root, then call `scotty_hatch` with only
`{ "operation": "ensure" }`. That invocation is the configuration check: the extension rejects a
missing file, malformed TOML, unknown fields, or unsafe values before starting a process or posting
the normalized existing ensure request. A complete inline ensure input remains the manual override.
The Session Durable Object remains authoritative for active Hatch state.

Preparation has a separate deadline (1–1800 seconds) from server readiness (1–300 seconds,
30 by default). Its process group is cleaned up on success, failure, timeout, or cancellation.
It runs before starting a new service, not when ensuring an already owned matching service or
restoring the prepared workspace on resume. Keep the server command in the foreground and use
`exec` in shell wrappers. Check repository runtime and package-manager requirements against the
sandbox image; installation and build failures are not readiness failures.

Failed starts return a classified error with bounded sanitized output where available. Session
status retains the startup failure code under the current runtime/attempt fence, so a failed start
can be distinguished from no configured service. Inspect status after an unconfirmed registration
before deciding to retry.

This package does not add `scotty hatch init` or `scotty hatch check`; those CLI
helpers are deferred to a later PR.

`hatch.toml` is non-secret repository configuration and does not require mode 0600.

Contributor check:

```sh
npm test --prefix worker/container/pi-packages/sources/scotty-hatch
npm run check --prefix worker/container/pi-packages/sources/scotty-hatch
```
