# MCP OAuth and tool policy

Requires an owner-authorized test-stage deployment and an image containing the updated scripted
agent. Do not deploy or run this recipe on `main`. The normal Worker has no test-server routes.

## Setup

The test stage's Scotty config must explicitly include the fixture host:

```json
"mcpOAuthTest": {
  "host": "mcp-oauth-test.scotty-agent.com"
}
```

Use the existing account, zone and stage fields. The deployer uploads the release's separate
`mcp-oauth-test` bundle, its test DO and custom domain only when this field is present. The fixture
is public, auto-approves test clients and issues disposable tokens; never point a real service at
it. Its redirect is restricted to the configured Scotty host. The Worker name is always
`scotty-<stage>-mcp-test`; teardown removes only that fixture name and skips it on `main`.
Keep this config until teardown if retiring the test Worker.

## Drive

1. Set `SCOTTY_URL` to the configured test stage. Run `npm run --silent e2e -- mcp-oauth
--agent codex`, then repeat with `--agent claude`. It needs Access sign-in, but no model or
   GitHub credentials. It creates and removes only its own connection and scripted session.
2. The e2e registers a public client, follows the fixture's approval redirect, and reaches the
   callback with the Access token. Unknown and reused state must return 400. Metadata shows
   `signed-in`, never tokens, registration secrets or discovery documents.
3. The session lists tools as JSON and fragmented SSE: only `read` appears. A read succeeds;
   a write returns a JSON-RPC error and the fixture's write count stays zero. Two concurrent
   reads after the 70-second token expiry use the same refreshed generation. All policy allows
   a write; named policy lists and allows only the named tool. An invalidated refresh grant
   makes the proxy return 401 and metadata report `needs-sign-in`. A token-endpoint 503 leaves
   metadata signed in and the next request refreshes successfully. A non-rotating provider omits
   the refresh token and a later refresh still succeeds. An upstream 401 refreshes and retries
   once. Incorrectly cased tools methods return a JSON-RPC error, including under all policy.
4. The e2e reads container env/configs, the raw conversation and event log. None may contain
   either test token prefix. Save a failing session's log under `e2e/logs/` before fixing a
   deployed failure; never save Access headers, authorization codes or token endpoint replies.
5. In Settings → Connections, add a real MCP endpoint with its token field blank, then press
   Connect in the owner's Access-signed-in browser. On `track`, the owner signs in to Linear
   (`https://mcp.linear.app/mcp`). Check signed-in status and the read-only default. Change its
   policy to named tools and save, then reload to verify persistence. The seed API includes
   disconnected, signed-in and needs-sign-in rows for local UI review.
6. The CLI equivalents are `scotty connect mcp linear --endpoint https://mcp.linear.app/mcp
--oauth --json`, `scotty mcp signin linear --json` (open the returned URL),
   `scotty mcp policy linear named --tools list_issues,get_issue --json` and
   `scotty connections --json`. Pasted tokens still arrive on stdin without `--oauth`.

## Diagnose

- Connect returning 502 means discovery, registration or authorization initiation failed.
  Confirm the HTTPS MCP URL and its published protected-resource/authorization-server metadata.
  OAuth errors are deliberately generic to keep upstream credential-bearing text out of logs.
- Callback 400 means malformed query, unknown, reused or expired state. Start Connect again;
  state expires after ten minutes. A code is redeemed once, including after a lost reply.
- Proxy 401 with `needs-sign-in` means the token endpoint rejected the grant (`invalid_grant`
  or HTTP 400/401). Reconnect. Other refresh failures preserve the grant and the next request
  tries again. If a rotating provider consumed the grant before a lost reply, that retry can
  reject it and require sign-in.
- Proxy 502 means the server's tools could not be verified. Read-only uses explicit
  `readOnlyHint: true`; missing hints are denied. Read-only calls fetch the current server list,
  including pagination, using the caller's MCP session headers. Named/all policy is explicit.
- The Worker needs `global_fetch_strictly_public` and `enable_request_signal`. SSE event IDs,
  comments, MCP protocol/session headers and cancellation are preserved. An incomplete event
  is dropped; an invalid tool list is refused. All policy keeps the transport untouched.

Local compilation and bundle checks do not prove the deployment, container interception, Access
callback or Linear sign-in. Record those separately when the owner authorizes the live run.
