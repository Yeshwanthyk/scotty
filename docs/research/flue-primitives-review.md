# Flue primitive review for Scotty external runners

Research snapshot: 2026-07-26. Upstream Flue was inspected at
[`b814b82b2ce45dc941c77bb010140070e1bd48d5`](https://github.com/withastro/flue/tree/b814b82b2ce45dc941c77bb010140070e1bd48d5).
Scotty was inspected at committed HEAD
`bbda2839ff7ec5972e7d8836f5c7de97189555dd` plus the current worktree. This is
an architecture review, not approval to change Scotty's public contracts.

## Verdict

Passing explicit values to a `noEnv` Box is the right primitive only when those
values are revocable session capabilities or sentinels. Passing the real Codex,
ChatGPT, GitHub, Box, or Cloudflare credential is not safe.

The proposed external-runner design is not safe yet if a Box can reach an
ordinary public Scotty gateway with only a bearer sentinel. Repository code can
copy that sentinel and call the gateway from elsewhere, and a root-capable Box
workload can bypass an in-guest proxy unless network enforcement sits outside
the workload's privilege boundary. The safe target is:

1. The session Durable Object keeps the real credentials and authoritative
   lifecycle record.
2. The Box receives only a per-session, per-generation capability plus sentinel
   Codex/GitHub material.
3. A root-owned host bridge authenticates outward to the owning Durable Object.
4. The untrusted workload runs below that bridge, without host root, Docker
   socket, firewall control, or direct Internet egress.
5. All credential-bearing traffic is forced through the bridge/broker, and the
   capability is revoked on vaporize and rotated on a new runtime generation.

Flue supports the architectural split, but it does not provide this security
boundary. Its sandbox contract accepts per-command environment values and leaves
provider creation, reuse, deletion, and secret policy to the application
([sandbox factory contract](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/apps/docs/src/content/docs/reference/sandbox-api.md#L20-L46)).

## What Flue actually makes primitive

Flue's portable execution seam is deliberately small:

- `SandboxFactory.createSessionEnv({ id })` resolves an environment once per
  initialized harness. The `id` is stable enough for an adapter to reconnect to
  a durable provider workspace
  ([factory type](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/types.ts#L950-L970)).
- `SessionEnv` owns buffered command execution plus a complete portable
  filesystem: text/binary reads, writes, metadata, listing, existence, mkdir,
  removal, `cwd`, and path resolution
  ([environment type](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/types.ts#L232-L287)).
- The runtime normalizes relative paths, centralizes parent creation for
  writes, and performs pre/post abort checks around signal-blind providers
  ([adapter wrapper](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/sandbox.ts#L237-L310)).
- Provider adapters translate that contract and own provider-specific liveness
  behavior. Flue's Cloudflare adapter, for example, polls `getState()` so an RPC
  does not hang forever after container death, while admitting that local abort
  cannot kill the remote command
  ([Cloudflare death detector](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/cloudflare/cf-sandbox.ts#L101-L185),
  [exec translation](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/cloudflare/cf-sandbox.ts#L286-L322)).
- The harness, not the provider adapter, owns agent sessions, abort scope,
  environment sharing/swaps, and the public session facade
  ([harness ownership](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/harness.ts#L99-L183),
  [session facade](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/harness.ts#L228-L253)).
- Environment values belong to the adapter or one command invocation. Flue
  redacts their values from shell events, but it has no vault, redemption, or
  egress-enforcement primitive
  ([shell event redaction](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/shell.ts#L43-L69)).
  Its Node adapter starts from a narrow shell-essential allowlist and requires
  explicit opt-in for other environment values
  ([local environment](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/runtime/src/node/local-env.ts#L150-L230)).

Equally important are the omissions. Flue has no generic provider lifecycle,
snapshot, Git, secret-vault, egress-broker, PTY, resize, or terminal-replay
primitive. `exec` returns one buffered `ShellResult`; it is not an interactive
transport. Its reconnect/replay system is for the durable conversation stream,
using opaque offsets and at-least-once delivery
([stream checkpoint](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/sdk/src/public/stream.ts#L25-L42),
[observation rehydrate and dedupe](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/packages/sdk/src/public/observe.ts#L109-L177)).
Flue explicitly keeps conversation durability separate from workspace
durability
([durability boundary](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/apps/docs/src/content/docs/guide/durability.md#L142-L160)).
Its accepted-work state is reconstructed from the durable canonical
conversation stream and submission bookkeeping, not from the sandbox process
([recovery model](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/apps/docs/src/content/docs/guide/durability.md#L21-L41)).

That means Flue is a good reference for Scotty's command/filesystem seam, but
not a complete `Runner` design. A Codex TUI with independent browser attachments
needs primitives Flue intentionally does not model.

## Scotty's boundaries

### Keep

Scotty is right to keep session authority in the Durable Object. The current
record and operation lease gate create, resume, snapshot, stop, and destruction;
KV remains a projection and R2 backup selection is committed through the record
([session orchestration](../../worker/src/session.ts#L335-L451),
[resume](../../worker/src/session.ts#L460-L520)). This is stronger than letting a
provider workspace or host heartbeat become authoritative.

`CredentialVault` and `egress.ts` are also the right control-plane split. The
container-visible auth file and environment contain only sentinels
([container auth](../../worker/src/container-auth.ts#L41-L73)); egress validates
the presented sentinel, loads the real bundle through the owning Durable
Object, substitutes it only on the allowed upstream request, and strips
credential-bearing pass-through requests
([OpenAI proxy](../../worker/src/egress.ts#L225-L239),
[GitHub and pass-through policy](../../worker/src/egress.ts#L342-L403)).
OAuth rotation remains transactional in the vault rather than becoming Box
state.

`Workspace` and `Agent` are correctly Scotty-owned domain services. Repository
selection, branch naming, credential-helper setup, Sheppard, Codex launch, and
Codex thread resume express Scotty product behavior, not Box, Cloudflare, or
SSH behavior
([workspace](../../worker/src/workspace.ts#L20-L72),
[agent launch](../../worker/src/agent.ts#L23-L53)). A provider should supply
execution capabilities, not decide how Scotty clones Git or launches Codex.

### Narrow or split

`SandboxRuntime` is not yet a portable runner primitive. It imports Cloudflare
`ExecOptions`, `ExecResult`, and `SessionOptions`; exposes only `mkdir` and
string `writeFile` from the filesystem; omits binary reads, stat, listing,
exists, removal, and a real cancellation contract; and mixes buffered commands,
global environment mutation, and named execution-session lifecycle in one
service
([current shape](../../worker/src/sandbox-runtime.ts#L1-L52)). It is both too
narrow for provider-independent workspace/archive code and too broad in the
unrelated responsibilities it combines.

Split it into:

- `ExecutionEnv`: `exec(command, { cwd, env, timeout, signal })` plus complete
  filesystem and normalized path semantics. A completed non-zero command is a
  result; transport, provider death, timeout, and caller cancellation remain
  distinct typed failures.
- `TerminalTransport`: attach to an existing Sheppard-owned PTY; input, output,
  resize, detach, and close one client attachment. It must expose whether
  output replay is supported and use an opaque resume cursor if it is.
- `RuntimeControl`: provision/reconnect one fixed provider resource, query
  health, stop, resume, and destroy it. These are coordinator operations, not
  model-facing environment verbs.
- `CheckpointTransport`: export and restore Scotty's workspace checkpoint
  stream. Provider-native snapshots may accelerate recovery but must not become
  Scotty's recovery authority.

`BackupStore` also leaks Cloudflare SDK shapes through `BackupOptions`,
`RestoreBackupResult`, and `DirectoryBackup`
([current backup contract](../../worker/src/backup-store.ts#L1-L35)). Keep the
current/previous generation policy, deletion-after-commit rule, and R2
ownership in Scotty, but give each execution adapter a provider-neutral
checkpoint import/export contract.

Do not create one giant `Runner` with every verb. Use `Runner` as the selected,
fixed execution location and composition root for the four capabilities above.
This follows Flue's useful rule—portable core capabilities are explicit—without
copying Flue's deliberate lack of lifecycle and PTY support.

## What remains provider-owned

The provider adapter should own only facts it can actually guarantee:

- Resource provisioning and identity translation: Box ID, Cloudflare Sandbox
  ID, Slumbers container ID, readiness, stop/resume/destroy calls.
- Command/file transport details, provider timeout units, provider-death
  detection, and truthful unsupported-capability errors.
- Native PTY/WebSocket/SSH mechanics where available. For Box and Slumbers, the
  Scotty host bridge supplies the common protocol; the adapter only reaches that
  bridge.
- Provider snapshot mechanics and retention observations, never the
  authoritative current/previous checkpoint decision.
- Host-level enforcement needed to make workload egress non-bypassable.

The provider must not own Scotty status, operation leases, hard-cap policy,
terminal attachment leases, Codex thread identity, branch policy, credential
rotation, or which backup generation is recoverable.

## Required proof before real credentials

Treat `noEnv + explicit sentinel env` as safe only after these gates pass:

1. Scan Box environment, files, process arguments, logs, snapshots, archives,
   and command responses and find no real Codex/GitHub credential.
2. Prove a copied sentinel cannot be used outside its authenticated session
   bridge and cannot address another session or generation.
3. Prove the workload cannot bypass the broker over DNS, IPv4, IPv6, raw TCP,
   redirects, alternate proxies, or host/container escape surfaces.
4. Prove disconnect/reconnect, PTY resize, cancellation, Box stop/resume, and
   host reboot preserve the same logical Sheppard/Codex session or fail
   explicitly.
5. Prove vaporize revokes the capability, destroys the provider resource,
   deletes credential authority and owned checkpoints, and leaves only the
   Durable Object tombstone.

Until those pass with a fake credential first, personal `codex login` inside a
no-env Box is the only simple path, but it deliberately places that user's
credential in the Box filesystem and snapshots. It is a different trust mode,
not Scotty's credential-isolated mode.
