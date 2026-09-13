# scotty-hatch

First-party Pi extension for one bounded application Hatch inside a warm Scotty session.

It registers only `scotty_hatch`, with explicit `ensure`, `status`, and `close` operations. The
extension owns only its scoped child process group. Authoritative Hatch state and exposure remain
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
```

Review the file from the repository root, then call `scotty_hatch` with only
`{ "operation": "ensure" }`. That invocation is the configuration check: the extension rejects a
missing file, malformed TOML, unknown fields, or unsafe values before starting a process or posting
the normalized existing ensure request. A complete inline ensure input remains the manual override.
The Session Durable Object remains authoritative for active Hatch state.

This focused package change does not add `scotty hatch init` or `scotty hatch check`; those CLI
helpers are deferred to a later PR.

`hatch.toml` is non-secret repository configuration and does not require mode 0600.

Contributor check:

```sh
npm test --prefix worker/container/pi-packages/sources/scotty-hatch
npm run check --prefix worker/container/pi-packages/sources/scotty-hatch
```
