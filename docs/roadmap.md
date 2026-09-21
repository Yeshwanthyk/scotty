# Roadmap

[README](../README.md) · [Features](features.md) · [Architecture](architecture.md)

Status through v0.3.22 and [PR #263](https://github.com/Yeshwanthyk/scotty/pull/263).
Implementation, release, and deployed verification are separate milestones. Historical plans below
are pinned to Git history so their evidence survives documentation cleanup.

## Shipped

Pi and Codex sessions on Cloudflare, browser and CLI controls, checkpoint/resume, Hatch, browser
evidence, sandbox resource publication, browser pairing, and runner registration are in the
v0.3.22 baseline. The [feature map](features.md) links to code and tests. Runner registration does
not enable runner-backed sessions.

- **Runtime image publication:** completed in v0.3.19, with a publication and provenance
  [receipt](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/s1-image-publication-handoff.md).
- **Conversation repair and image attachments:** included in v0.3.22. See the historical
  [conversation plan](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/plans/conversation-contract-repair.md)
  and [attachment plan](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/plans/image-attachments.md).
- **Codex runtime recovery:** implemented; see the
  [recovery notes](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/codex-runtime-recovery.md).

## Merged after v0.3.22

**Individual resource commands** landed in [PR #263](https://github.com/Yeshwanthyk/scotty/pull/263).
They update one skill, extension, tool, or package without replacing the catalog. Check your
installed release for availability. See [CLI resources](cli.md#individual-resource-commands).

## Pending verification

| Work                                                  | Remaining proof                                                                                           | Source                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker-free Cloudflare installation and custom images | The combined live gate is still open; custom-image proof is deferred. Keep Docker in setup prerequisites. | [Provider plan](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/plans/multi-provider-session-plan.md), [image selection](../cli/src/container-image.ts) |
| Side-loaded sandbox CLI                               | Local integration exists; the plan does not record a completed deployed gate.                             | [Provider plan](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/plans/multi-provider-session-plan.md), [runtime CLI](../worker/src/runtime-cli/)        |
| Cloud-managed settings                                | Implementation and code-level verification are recorded; deployment verification remains pending.         | [Settings tracker](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/cloud-settings-plan.md), [Config object](../worker/src/sandbox/config-object.ts)     |
| Cross-session internal control                        | The reserved-origin interceptor needs deployed proof, beyond local admission tests.                       | [Container egress tests](../worker/test/egress/container-session-egress.test.ts), [E2E guide](../e2e/README.md)                                                 |

## Next

The [provider plan](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/plans/multi-provider-session-plan.md)
sets this order after the image and runtime CLI gates:

1. **MCP settings** — configuration and runtime wiring.
2. **Native Linux runner sessions** — transport before enabling creation.
3. **Linux resume, Hatch, and canary** — lifecycle and preview verification.
4. **Approved cutover** — only after the preceding gates and explicit approval.

The [session object](../worker/src/session/object.ts) still rejects runner-backed creation.

Repository `hatch.toml` configuration works today. `scotty hatch init` and `scotty hatch check`
are not available; use [Hatch ensure](hatch.md).

## Deployment proof

A release tag, reachable Worker, or successful `doctor` does not prove the session lifecycle.
Production verification requires guarded deployment and the [stage-isolated canary](../e2e/README.md):
create, agent work, checkpoint, resume, and cleanup. This documentation pass did not run a deployment
or canary.
