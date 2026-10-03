# Reach through internal connections

Pasted token and MCP credentials stay in the Creds DO. Agents call a plain HTTP internal URL;
Scotty adds the credential and streams the HTTPS request and response.

## Drive

1. Pipe a disposable token into `scotty connect token metrics --host api.example.com --header
"X-Api-Key" --json`. Pipe an MCP token into `scotty connect mcp tools --endpoint
https://example.com/mcp --json`. Creation and `scotty connections --json` show metadata and
   internal URLs, with no pasted secret. Settings → Connections supports the same fields; its
   secret input is a password field and clears on success.
2. Start a session or stop and resume an owned session. Token calls use
   `http://metrics.internal/api/<path>`; MCP uses `http://tools.internal/api/mcp`, mapped to the
   configured HTTPS endpoint. Codex's `mcp_servers` tables and Claude's SDK `mcpServers` contain
   only names and internal URLs.
3. Run `npm run --silent e2e -- reach --agent codex`, then repeat with `--agent claude`. It creates
   disposable connections and scripted sessions, checks token auth, MCP GET/POST/DELETE, path,
   query, body and MCP headers, then stops and resumes to check interceptor reinstallation.
   It reads the environment/config files, conversation and event log and rejects either sentinel
   appearing there. Cleanup stops only its own session and deletes only its own connections.
4. Save `scotty log <id>` for any failing session before fixing a deployed failure. Inspect the
   failing turn with `scotty read <id>` and the metadata with `scotty connections`; keep secrets
   out of evidence. Remove manual test connections with `scotty rm connection <name>`.

## Proof limits and diagnosis

- The automated target is `https://httpbingo.org/anything/reach`, a public echo service. It uses
  disposable sentinels. The stand-in hashes echoed header values before tool output or transcript
  writes, so neither credential appears in the log. This avoids adding a production test route.
  An unavailable public echo service can fail this test independently of Scotty.
- This recipe proves the token path and HTTP transport, not a real MCP server handshake, OAuth,
  or model tool use. The streaming and abort spike is recorded in `docs/design.md`; the new proxy
  preserves both body streams and the incoming request signal. Deployment must include
  `enable_request_signal`.
- A 404 means the connection was removed, the path lacks `/api/`, or the request lacked trusted
  loopback props. A 502 means the HTTPS upstream failed. A new connection needs a cold start;
  stop and resume a session that was already running. Redirects are returned to the caller so a
  custom credential header never follows to another host.
