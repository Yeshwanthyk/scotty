# Architecture

[README](../README.md) · [Features](features.md) · [Development](development.md)

Scotty separates session state from the processes that run an agent. Cloudflare Durable Objects
own state and authority; containers run the workspace. Cloudflare is the enabled session provider.
Runner registration exists, but runner-backed session creation is disabled.

## System map

```text
Browser / scotty CLI        Preview domain
          |                      |
          +-----------+----------+
                      |
               Main Worker
             API / UI / auth
                      |
    +-----------------+-----------------------------+
    |                 |                             |
    |          Durable Objects                      |
    |          +-- Auth: browser identity            |
    |          +-- Config: settings and repos        |
    |          +-- Credentials: encrypted vault      |
    |          +-- Session: lifecycle and authority  |
    |          |     +--> Container: Pi or Codex     |
    |          |     +--> R2: immutable backups      |
    |          |     +--> KV: list projections       |
    |          +-- Runner registry and control      |
    |                +--> Runner Worker             |
    |                                               |
    +--> R2: evidence artifacts and resource bundles |
    +-----------------------------------------------+
```

The Worker publishes resources; the Config object references the active configuration. The browser
does not connect directly to an agent process or receive its credentials.

## Who owns what

| Component              | Responsibility                                                                                           | Source                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main Worker            | Hono routes, API errors, browser admission, UI assets, terminal and console proxying                     | [Routes](../worker/src/index.ts)                                                                                                                   |
| Session Sandbox DO     | Session record, operation lease, hard cap, credential grants, backup references, recovery, and schedules | [Session object](../worker/src/session/object.ts), [actor](../worker/src/session-actor/)                                                           |
| Auth DO                | One browser owner, standard clients, pairing, transfer, recovery, and revocation                         | [Auth object](../worker/src/auth/object.ts), [registry](../worker/src/auth/registry.ts)                                                            |
| Config DO              | Agent settings, runtime CLI selection, and repository registry                                           | [Config object](../worker/src/sandbox/config-object.ts)                                                                                            |
| Credential Registry DO | Encrypted credentials, managed-handle resolution, and session grants                                     | [Credential object](../worker/src/credentials/object.ts)                                                                                           |
| Runner control plane   | Named runner registration, credentials, connection state, and control                                    | [Runner modules](../worker/src/runner/), [Runner Worker](../worker/src/runner-worker.ts)                                                           |
| Container              | Workspace files and agent processes; not authoritative session state                                     | [Image](../worker/container/Dockerfile), [runtime adapter](../worker/src/sandbox/runtime.ts)                                                       |
| KV                     | Non-secret session, repository, and statistics projections                                               | [Session projection](../worker/src/session/projection.ts), [repository projection](../worker/src/repos/projection.ts)                              |
| R2                     | Immutable backups, evidence artifacts, and published sandbox bundles                                     | [Backups](../worker/src/backups/store.ts), [artifacts](../worker/src/evidence/artifact-store.ts), [bundles](../worker/src/sandbox/bundle-store.ts) |

Alchemy declares infrastructure in [the stack](../infra/cloudflare-stack.ts): Workers, Durable
Objects, Containers, KV, R2, assets, bindings, and migrations. It does not replace the official
Sandbox SDK class. Wrangler remains a local development and dry-run tool, not the production
reconciler.

Resource names derive from the user-chosen installation name. Account IDs, deployed hostnames,
Container IDs, and real credentials do not belong in repository configuration.

## Session lifecycle

A session has one workspace, repository branch, and execution provider. One operation lease may
mutate it at a time.

- Create arms the hard cap before committing the session.
- Checkpoint and sleep stop agent work before workspace sync and backup.
- Resume requires the current confirmed backup.
- Vaporize retries until owned state is gone.
- Interrupted operations retain retry state or expose a typed failure. Ambiguous provider state
  must not be reported as success.

The [transition modules](../worker/src/session-actor/transitions/) implement these rules.
[Checkpoint/sleep/resume tests](../worker/test/session-actor/checkpoint-sleep-resume.test.ts),
[recovery tests](../worker/test/session-actor/recovery-sandbox.test.ts), and
[vaporize tests](../worker/test/session-actor/vaporize.test.ts) cover their contracts.

## Agent runtimes

[Agent selection](../protocol/agent-selection.ts) chooses Pi or Codex. Pi runs through the
[container supervisor](../worker/container/scotty-pi-session.mjs); Codex uses the
[app-server runtime](../worker/src/agent/codex/). The image pins their versions.

The Worker proxies console traffic to the container. Session controls use snapshots and revision
checks rather than trusting a browser's cached state. See [passive control](../worker/src/session/passive.ts)
and the [conversation protocol](../protocol/conversation.ts).

## Credential isolation

Repository code is untrusted. Real provider and GitHub credentials remain in the Credential
Registry. Containers receive session-bound sentinels and managed handles, not the underlying
secrets. The registry-backed egress proxy resolves credentials at the request boundary and sanitizes
OAuth refresh responses before returning them to the container.

The [container proxy](../worker/src/egress/session.ts) handles the reserved `scotty.internal`
origin. Other outbound traffic is constrained by the [egress allowlist](../worker/src/egress/worker.ts).
Keep that allowlist small: an allowed package registry can still be an exfiltration channel for
source code or prompts.

Cross-session control derives the source identity from Cloudflare's container context, not
caller-supplied credentials. The source must be warm; target sessions must have the same repository
identity. Coordination is request-scoped, with no mailbox or persisted coordination state.
See [CLI coordination](cli.md#agent-to-agent-coordination).

## Browser authority

`SCOTTY_TOKEN` is a CLI bearer and recovery credential, never a browser cookie or URL parameter.
The Auth object stores credential digests, not raw client, pairing, transfer, or recovery secrets.

There is one owner and an ownership epoch. Pairing grants standard access. Transfer targets an
existing browser. Root recovery revokes every browser credential before creating a new owner.
Device records include identity, label, scopes, timestamps, optional user agent, and revocation state;
default labels do not expose hostnames.

The Worker authenticates terminal WebSockets and checks their origin before attaching them to the
Sandbox PTY. Browser worklog, Hatch, and evidence routes use browser authentication rather than
container credentials.

## Code and tests

- [Route contracts](../worker/test/integration/routes.test.ts)
- [Auth registry](../worker/test/auth/auth-registry.test.ts) and [ownership](../worker/test/auth/auth-ownership-machine.test.ts)
- [Credential store](../worker/test/credentials/credential-store.test.ts)
- [Container authentication](../worker/test/sandbox/container-auth.test.ts)
- [Container session egress](../worker/test/egress/container-session-egress.test.ts)
- [Runner registry](../worker/test/runner/runner-registry.test.ts)
- [E2E proof requirements](../e2e/README.md)

Local tests do not replace the deployed canary.
