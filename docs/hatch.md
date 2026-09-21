# Hatch and browser evidence

[README](../README.md) · [Features](features.md) · [CLI](cli.md)

Hatch is the live application running in a session. Showcase contains retained before/after browser
evidence. They use separate servers and serve different purposes.

## Open the live app

The sandbox agent starts Hatch with the `scotty_hatch` tool and keeps the app process running.
Open it with **Open Hatch** in the paired session shell, or append `/hatch/open` to the session URL.

Do not share the wildcard preview URL, handoff token, route nonce, or Hatch cookie. Access goes
through the authenticated session.

## Configure Hatch

Place a non-secret `hatch.toml` at the repository root:

```toml
[hatch]
service = "web"
argv = ["pnpm", "exec", "vite", "dev", "--host", "0.0.0.0", "--port", "4173"]
cwd = "."
port = 4173
health_path = "/"
```

Adjust the command and health check for your app. Review the file, then invoke `scotty_hatch` with:

```json
{ "operation": "ensure" }
```

Ensure rejects missing, malformed, unknown, or unsafe configuration before starting the process or
posting authority. Complete inline ensure input remains a manual override. `hatch.toml` does not
need mode 0600 because it contains no secrets. Do not use `scotty hatch init` or `scotty hatch check`;
those convenience commands are not available.

## Capture before and after

1. Start a temporary evidence server on a different port from Hatch.
2. Define one bounded flow with at most three observable checks.
3. Run it before the change with video disabled.
4. Make the change, then run the same viewport, actions, and assertions with video enabled.
5. Stop the temporary server. Leave Hatch running.

The fixed evidence runner uses headed Chromium on an isolated X display in the sandbox. It captures
PNG frames and, when requested, records those live pixels as WebM with ffmpeg. Video is not a
slideshow or an rrweb replay.

Do not blindly retry a failed evidence run. Change the failure cause or session state first.

## Publish the result

The agent's latest update must include the exact `scotty-hatch:<hatchId>` reference and both
`scotty-evidence:<jobId>` references from the same conversation. Summary then shows the live Hatch
control and a private Showcase link with matched screenshots, assertions, and the after-run video.

Assistant Markdown can display the first published screenshot:

```text
![Description](scotty-evidence:<jobId>)
```

Use the exact returned reference. This counts as its one inclusion in the update. The UI resolves
it against the session's evidence with registered-browser authentication. Tool evidence cards retain
all frames; missing or expired images show an unavailable message.

Filesystem paths, external URLs, and raw HTML cannot supply assistant images. Capture and publish
through the browser evidence tool first.

## Sources and tests

- [Hatch gateway and contracts](../worker/src/hatch/)
- [Pi Hatch tool](../worker/container/pi-packages/sources/scotty-hatch/)
- [Codex first-party tools](../worker/src/agent/codex/first-party-tools.ts)
- [Evidence workflow and recorder](../worker/src/evidence/)
- [Hatch tests](../worker/test/hatch/) and [evidence tests](../worker/test/evidence/)
