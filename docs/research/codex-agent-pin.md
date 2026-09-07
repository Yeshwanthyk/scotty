# Codex Slice 1 protocol pin

## Current packaging and model admission (supersedes standalone-binary instructions below)

The image uses the **complete primary package**, not the old single executable and
not the app-server-only package. `/usr/local/bin/codex` is a symlink to
`/opt/codex/bin/codex`; invocation remains `codex app-server --listen stdio://`.
The full upstream manifest, bin/helper, path and resource trees remain intact.
Bundled `codex-resources/bwrap` is package integrity, **not sandbox activation**.
There is no system bubblewrap dependency, setuid/setgid bit, added Docker privilege,
capability or seccomp setting. Exact YOLO readback remains mandatory.

Independently rechecked the official release API digests against archive bytes and
the annotated tag against commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` before
extraction. This is official HTTPS/digest verification, not a reproducible-build or
signature claim. Evidence: `/tmp/scotty-codex-packaging-proof/`.

| Complete package, rust-v0.153.4                                                                                                       | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Linux amd64 primary](https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-x86_64-unknown-linux-musl.tar.gz) | `a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821` |
| [macOS arm64 primary](https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-aarch64-apple-darwin.tar.gz)      | `35438da1fbf7a6db7ddb3bcec84448fa6015ba188461472a97d9d1da7d9c4353` |

Linux archive entries, including directories: `bin/`, `bin/codex`,
`bin/codex-code-mode-host`, `codex-package.json`, `codex-path/`, `codex-path/rg`,
`codex-resources/`, `codex-resources/bwrap`, `codex-resources/zsh/`,
`codex-resources/zsh/bin/`, `codex-resources/zsh/bin/zsh`.
The Docker build checks the entire manifest object: layoutVersion 1, version
0.153.4, target x86_64-unknown-linux-musl, variant codex, entrypoint bin/codex,
resourcesDir codex-resources, pathDir codex-path. SHA verification precedes extraction.

### Narrow capability owner and startup proof

New path: `protocol/codex-model-capabilities.ts`. It contains a schema-owned minimal
projection of all 11 entries from the exact release
[models.json](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/models-manager/models.json):
slug, supported reasoning efforts, and tool mode. Source SHA-256:
`d7136a413cfac1b5b1686d9e0dcc5c80ca05bebed5e9fc3911376561d0ef6ee8`.
To regenerate/compare, project `models.map(m => ({ slug: m.slug,
efforts: m.supported_reasoning_levels.map(p => p.effort), toolMode: m.tool_mode ?? null }))`.
Review the schema and startup requirements when updating the pin; never accept a
new tool mode, unknown model, or unsupported effort by fallback.

`CodexLaunch` accepts a bounded identifier (128 ASCII letters/digits/dots/underscores/
hyphens, lowercase, starting with a letter/digit), then requires an exact catalog
model/effort pair. No network discovery, generic provider layer, default selection,
or change to Pi model selection. Catalog support is not account availability.
`gpt-6-astra` admits low/medium/high/xhigh/max/ultra and requires code mode.
The wire protocol already accepts these strings; `protocol/codex-app-server.ts`
needs no changes.

For code-mode-required selections, `process.ts` canonicalizes the executable and
checks its adjacent packaged helper (resource directory preferred, then bin).
Before app-server spawn it starts that helper with `--listen stdio`, sends the
upstream four-byte little-endian length-prefixed v1 `connection/hello`, closes
stdin, and requires exactly one bounded `connection/ready`, selectedVersion 1,
and clean exit. The preflight inherits no environment or sentinel; HOME/TMPDIR
use the isolated runtime home. Output is bounded to 4096 bytes, the existing
request deadline applies, and its Effect scope closes/reaps the child on failure
or interruption. Missing, malformed, oversized, wrong-version, timed-out or failed
helpers yield the existing bounded `spawn_failed` before any work is accepted.
Native Codex still owns the working helper: no Scotty helper service, session
protocol, sandbox framework, or durable state is added. A preflight is not a promise
that a later process cannot fail; existing native failure/stop supervision remains.

Sources at the same commit:

- [InstallContext](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/install-context/src/lib.rs), `current`, `CodexPackageLayout::from_exe`, `code_mode_host_program`, and package/symlink tests: canonical executable resolution preserves package lookup through the installed symlink.
- [Remote provider](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/remote_session.rs): `availability()` only checks file presence. Model readback and this check alone cannot establish helper readiness.
- [Connection startup](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode/src/remote_session/connection.rs), `spawn`/`establish`, and [framing](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/code-mode-protocol/src/host/codec.rs) with `codec_tests.rs`: argv, v1 hello/ready, EOF, partial/malformed and oversized frames.
- [Native code-mode tests](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/tests/suite/code_mode.rs): custom `exec` calls and `text(...)` output, missing-host fail-closed behavior.

**Ultra has upstream-defined semantics, not a Scotty fallback.** The native
thread still reads back `ultra`; Astra's catalog specifies
`multi_agent_reasoning_effort: "xhigh"`, and
[client.rs `reasoning_effort_for_request`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs)
maps its Responses requests to `xhigh` (tested in `client_tests.rs`). Scotty sends
the requested `ultra` unchanged and does not substitute another model/effort.
This pin also sets `use_responses_lite: true`: tool definitions are in an
`additional_tools` input item, not a top-level `tools` array. Proof must inspect
both the native selection and the actual request, not mistake their intentional
representation difference for arbitrary effort support.

### Packaging/model verification result

- Owned-file format, deny-warning lint, skill lint, worker and contracts typechecks:
  pass. New protocol data is covered by the existing `protocol/**/*.ts` strict
  override; no lint/config/dependency changes were needed.
- Focused launch/session/protocol/managed-egress Vitest: **41 passed**.
  Owned image tests plus unchanged Pi supervisor regressions: **8 passed**.
- Complete native macOS matrix: **75 passed, zero skipped**. Complete native
  emulated Linux matrix: **75 passed, zero skipped**. Both retain the prior 58
  cases, including the three accepted P2 regression families. Added proof covers
  Astra's six efforts; actual `exec`/`text` arithmetic with output returned to the
  synthetic upstream; framed v1 readiness/failure/timeout and exact fixture PID
  absence; real native missing-helper rejection; unknown/incompatible selections
  rejected before spawn. No upstream request precedes readiness/prompt.
- Rebuilt twice through `node scripts/check-container-image.mjs` using the real
  prepared context and configured Docker context **colima**. Final image:
  `sha256:02208724345b86e2d5f91c59f0294ce6cfaafd390cf52d3462761e2175b23404`.
  Existing `docker image inspect Size` metric: **1,153,699,938 bytes** against the
  unchanged **1,310,720,000-byte** limit. Version, complete layout, absence of a
  system bubblewrap dependency/setuid bits, native host bundle and Pi gates pass.
  No fallback to the app-server-only package was needed.
- Linux used that image's installed symlink/package and host bundle, not an old
  image with a replacement host. Host SHA-256
  `9b709ff7cd019745f23d759d7beba2553021a2ae75e5b74a6399acfe106591b8`
  matches the current-source bundle. Only test harness staging differs from the
  repository test; `staging.diff` records it. The exact owned container was removed
  and both matrix temporary directories ended empty. No mounts or Docker security
  changes; Linux networking disabled except its isolated loopback.

Retained failures: the first native run incorrectly expected wire `ultra`; later
fixture attempts assumed top-level tool definitions and a `console` global rather
than upstream's namespace-wrapped Responses Lite input and `text` function. Source
and actual captured output corrected the tests, not production behavior. Initial
unit invocation named a nonexistent worker Vitest config; the repository-default
invocation passes. Initial lint caught a decoder compiled inside a test; hoisted it.

**Out-of-scope blocker:** `scripts/prepare-container-context.test.mjs:474` invokes
the native entry with four old positional arguments. Unchanged `main.ts:24-26`
requires one JSON launch argument and rejects that input before consulting the
model schema. The broader packaging run therefore reports 16 passed / 2 failed
(one failing subtest and its parent). Its owner must update that fixture to the
existing managed launch contract and its loopback-only test composition; this
packaging/model change does not edit CLI packaging or that test.

This tranche changes no main/session/runtime/server/bridge source or bridge tests,
Session actor, auth, egress, CLI packaging, credentials, invocation grammar or Pi
selection. `main.ts`, `session.ts` and the wire protocol match the pre-task bytes.
The parallel bridge owner changed `runtime.ts` during the run; that is not part
of this diff or this component acceptance. No `session.ts` handoff is required.
Source/digest, schema/unit, packaged-native, image and size proofs are distinct;
none proves provider-account availability, deployed egress, Session lifecycle,
arbitrary descendant containment or production acceptance. No real credentials,
provider call, deployment, remote resources or commits; no full-suite claim.

## Current contract: user-approved YOLO only

The user selected “we will have yolo mode only” and “so no need approvals etc”.
The host now sends `thread/start` with `approvalPolicy: "never"` and
`sandbox: "danger-full-access"`, retaining the explicit model/provider/cwd and
`ephemeral: true`. Readiness requires `approvalPolicy: "never"`,
`approvalsReviewer: "user"` (upstream routing metadata, not an interactive feature),
and exactly `sandbox: { type: "dangerFullAccess" }`, plus the existing home,
runtime, model/provider/cwd and effort checks. Missing, unknown or other modes fail
before any prompt. There is no approval UI, approval state machine or fallback mode.

Exact release commit: `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` / `0.153.4`:

- [ThreadStartParams schema](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/schema/json/v2/ThreadStartParams.json): `SandboxMode` is only `read-only`, `workspace-write`, `danger-full-access`; approval `never` is supported without experimental API.
- [ThreadStartResponse schema](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/schema/json/v2/ThreadStartResponse.json) and [v2 policy source](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs#L536-L566): response spelling is camelCase `dangerFullAccess`, with no network field.
- [Core policy source](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/protocol.rs#L1004-L1006): `Never` returns command failures to the model, never escalates them to the user. [Sandbox policy](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/protocol.rs#L1065-L1092) distinguishes unrestricted `DangerFullAccess` from `ExternalSandbox`, which describes external enforcement with a network setting. They are not interchangeable, and `external-sandbox` is not a thread-start mode.
- [Permission-profile round-trip test](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/models.rs#L2851-L2868) proves `DangerFullAccess` maps to disabled inner enforcement, unrestricted filesystem and enabled network. [Sandbox selection tests](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/sandboxing/src/manager_tests.rs#L28-L51) prove no platform sandbox without managed-network requirements, but retain platform enforcement when such requirements exist; [selection implementation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/sandboxing/src/policy_transforms.rs#L715-L735) is explicit about that distinction.

This removes Codex's inner read-only fixture policy, not Scotty/container isolation.
No Docker privileges, capabilities, seccomp or setuid changes; no credential,
managed-egress, fencing or resource-bound changes. The added bubblewrap install and
smoke requirement were consequences of that wrong fixture and are removed.
No containment claim follows from YOLO, proxy environment variables or fixture cleanup.
Managed production egress still needs its own integration proof.

All unexpected server requests, including command/file approvals, still receive a
bounded `-32601` / `Unsupported server request` response preserving only validated
ID. Invalid envelopes fail locally. No implicit approval, invented decision payload
or unbounded pending approval is introduced. Cleanup remains `ambiguous`, with
`descendants: "unverified"`; interruption is not process cleanup.

The current host is `worker/src/agent/codex/main.ts` → the scoped Effect session and
process modules, bundled as `scotty-codex-host.mjs` and loaded by the tiny native
`scotty-codex-session` entry. The sections below preserve the earlier protocol-only
pin and audit history; their pending-host/image statements are historical, not the
current implementation status. Current repair evidence is appended below.

## Historical protocol-only verdict and scope

**READY: repaired bounded protocol API and isolated nonsecret native-settings handoff. BLOCKED: host/lifecycle implementation and complete Slice 1 acceptance.**

Verified on 2026-09-06, on `codex-agent` at `0f3f6aaa`. The checkout was already the fresh Slice 0 branch; no branch reset, commit, lane import, or unrelated edit was needed. This change adds only `protocol/codex-app-server.ts`, `worker/test/protocol/codex-app-server.test.ts`, and this report. `protocol/**/*.ts` already belongs to the strict Effect lint override.

No Session/config/Runner/host/image/packaging changes by this protocol owner, deployment, remote resource creation, or real credential reads. Original pin artifacts live in `/tmp/scotty-codex-pin`. The bounded repair also replayed the independent audit's native records and ran its verified macOS binary against synthetic loopback upstreams with isolated HOME/CODEX_HOME. These are component probes, not production host or real-provider proof. A concurrent writer owns packaging; its status is not certified here.

## Official release verification

Selected **Codex CLI 0.153.4**, invoked later as `codex app-server` (not the separately distributed standalone app-server package).

Primary sources:

- [Official release](https://github.com/openai/codex/releases/tag/rust-v0.153.4).
- [Release API, including asset SHA-256 digests](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4), published `2026-09-04T23:25:48Z`.
- [Tag ref](https://api.github.com/repos/openai/codex/git/ref/tags/rust-v0.153.4): annotated tag object `042fb41b7c813ac7999105e886b2b7aa715b5081`.
- [Tag object](https://api.github.com/repos/openai/codex/git/tags/042fb41b7c813ac7999105e886b2b7aa715b5081): release commit **`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`**. GitHub reports this tag unsigned. This is HTTPS/official-asset digest verification, not a verified signature or independent reproducible binary build.

| Use                          | Official archive                                                                                                                                 | SHA-256 (published digest and downloaded bytes agree)              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Future Linux amd64 image     | [codex-x86_64-unknown-linux-musl.tar.gz](https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-x86_64-unknown-linux-musl.tar.gz) | `f479424eca092484dc40d87ae28c44f4cc40234a60045d6131e493800d814a30` |
| Local Apple Silicon evidence | [codex-aarch64-apple-darwin.tar.gz](https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-aarch64-apple-darwin.tar.gz)           | `8cf911ea676523bfb2121ec561848d2aba564890ad536db4d8a3353f2b9850b1` |

`tar -tvzf` found exactly one root-level regular executable in each archive, no containing directory:

```text
0755 258659424 bytes codex-x86_64-unknown-linux-musl
0755 220584000 bytes codex-aarch64-apple-darwin
```

Thus the future image extraction must install the root member `codex-x86_64-unknown-linux-musl` as `/usr/local/bin/codex`; do not assume `codex/codex`, an npm vendor layout, or strip a path component. Linux bytes/layout were verified but the Linux executable was not run. The macOS executable returned exactly `codex-cli 0.153.4`.

Reproduce in a new disposable directory, not the user's Codex home:

```sh
set -eu
work=$(mktemp -d /tmp/scotty-codex-pin.XXXXXX)
cd "$work"
base=https://github.com/openai/codex/releases/download/rust-v0.153.4
for target in x86_64-unknown-linux-musl aarch64-apple-darwin; do
  curl -fLsS "$base/codex-$target.tar.gz" -o "codex-$target.tar.gz"
  tar -tvzf "codex-$target.tar.gz"
done
printf '%s\n' \
  'f479424eca092484dc40d87ae28c44f4cc40234a60045d6131e493800d814a30  codex-x86_64-unknown-linux-musl.tar.gz' \
  '8cf911ea676523bfb2121ec561848d2aba564890ad536db4d8a3353f2b9850b1  codex-aarch64-apple-darwin.tar.gz' \
  | shasum -a 256 -c -
tar -xzf codex-aarch64-apple-darwin.tar.gz
mkdir home codex-home schema
env -i HOME="$work/home" CODEX_HOME="$work/codex-home" PATH=/usr/bin:/bin \
  ./codex-aarch64-apple-darwin --version
env -i HOME="$work/home" CODEX_HOME="$work/codex-home" PATH=/usr/bin:/bin \
  ./codex-aarch64-apple-darwin app-server generate-json-schema --out "$work/schema"
```

## Version-specific schema evidence

The verified macOS release executable generated stable schemas without `--experimental`. Each of the 15 files below was fetched from the **release commit**, then compared byte-for-byte with the generated file using `cmp`; all comparisons passed.

Source base URL (append the table path):

`https://raw.githubusercontent.com/openai/codex/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/schema/json/`

| Path                                    | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `JSONRPCRequest.json`                   | `31bd6f360b2dd8a7ceaf682708105d40d38cb0b9d0821357a04da67028438f73` |
| `JSONRPCResponse.json`                  | `4796738c04c74288213a08fb8d820c7b4df19e0977cdcd35b65ffcb43cfc93ab` |
| `JSONRPCError.json`                     | `d7ea353d4875ae204625da5a00a1ecb5afc69101d5778b9acc253a49f8932992` |
| `RequestId.json`                        | `9c72d59a306d827113020c6d31a14c326d55210d9bd6954f825196a52009f1c7` |
| `v1/InitializeParams.json`              | `6f0094be9a65242ec779a40794cbd4fdfa32fca1e45084a16adfb50501d33ea2` |
| `v1/InitializeResponse.json`            | `62ad689c2cb6379913c1d72749cfd8de5089d35760214123518eb92eef11acc9` |
| `v2/ThreadStartParams.json`             | `792e2f32e37cece971bd616664ea2053741acbed4e9c92e9d1766427718f2ecd` |
| `v2/ThreadStartResponse.json`           | `656f8fd0fe91f533126cbfdb9369cfab550927a229e48dd46460f6f015d2b186` |
| `v2/TurnStartParams.json`               | `a3835e8c1e942e4b358e1a670939b89918b16c4d13105a579899892b7ade6dea` |
| `v2/TurnStartResponse.json`             | `6fc49c3e5d0ce11a3a109ae194619b04d6e3ff98fa29bac683fdb754608958be` |
| `v2/TurnStartedNotification.json`       | `d4b59fd396cadfc2377f60c9f9f4c9367dca95362baadf7817c74e1b9c910c4d` |
| `v2/TurnCompletedNotification.json`     | `78af2a37391e8e669a4020cb58593e4d3e378756ced79d5fec72374fa69fb94b` |
| `v2/AgentMessageDeltaNotification.json` | `996e6c0ea65e57bed5a00f410b94381fe5ebf804333e5d00c2b6e6d47e5c55f6` |
| `v2/TurnInterruptParams.json`           | `6dff382dae73d1dbc58406ed045605f647e7a49660e2540fbd2c6c24d60c5f2b` |
| `v2/TurnInterruptResponse.json`         | `531de6be06fe979b5963f249bab82498a175e614bf65ac12fb2e849dfe60bcf1` |

For each table entry, reproduce:

```sh
commit=3d2ee51ca2d5db578f328aa75e20aa22c0197c9a
name=v2/TurnCompletedNotification.json
mkdir -p "source-schema/$(dirname "$name")"
curl -fLsS "https://raw.githubusercontent.com/openai/codex/$commit/codex-rs/app-server-protocol/schema/json/$name" \
  -o "source-schema/$name"
cmp "source-schema/$name" "schema/$name"
shasum -a 256 "schema/$name"
```

The generated aggregate `codex_app_server_protocol.v2.schemas.json` hashes to `d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a` (not separately compared to source). The [release-commit app-server README](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/README.md) was also fetched and compared with the tag README, SHA-256 `1142bff07746d3b54dccf39fd84b58798ae609cd73fa26c82fa07743abc0395a`.

Important facts from these schemas and that README:

- stdio uses one JSON object per line, **without** `jsonrpc: "2.0"`. Initialize once, await its response, then notify `initialized`.
- Initialize response requires `userAgent`, `codexHome`, `platformFamily`, and `platformOs`; modeling only `userAgent` would miss this version's home/runtime readback.
- Thread-start response exposes effective `model`, `modelProvider`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, and optional nullable `reasoningEffort`.
- `ReasoningEffort` is a nonempty **string**, not the old fixed enum. This decoder does not claim arbitrary strings are supported by a model; later discovery/readback must establish that before a real prompt.
- Turn-start input uses `type: "text"` and `text`; `text_elements` defaults to `[]` and may be omitted. Turn-start response is `{ turn }`, not a completion.
- `item/agentMessage/delta` requires `threadId`, `turnId`, `itemId`, and `delta`.
- `turn/started` has no items. `turn/completed` carries the final agent-message summary, not the whole history. Terminal states are `completed`, `interrupted`, or `failed`; `failed` carries an error. The schema allows optional error fields; Scotty additionally enforces the documented status/error relationship.
- `turn/interrupt` uses camelCase `threadId`/`turnId`; response `{}` only acknowledges cancellation. Wait for terminal `interrupted`. The README explicitly says interrupt does **not** stop background terminals.
- Request IDs are strings or int64. Scotty narrows strings to nonempty bounded values and numbers to safe JS integers, retaining number/string identity without coercion.

### Transport envelope correction

Generated parameter schemas alone missed the native envelope. The independent audit at `/tmp/scotty-slice1-audit/REPORT.md` demonstrated all five supported notifications failing in each high/low probe. Removing only `emittedAtMs` made them pass.

Exact release implementation, not a speculative extension:

- [common.rs:1965–1982](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/common.rs#L1965-L1982): flattened `ServerNotificationEnvelope`, optional `emittedAtMs: i64`; omission supports older servers.
- [outgoing_message.rs:734–738](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/outgoing_message.rs#L734-L738): current emission always populates the timestamp.
- [serialization test:775–803](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/outgoing_message.rs#L775-L803): timestamp is top-level, not inside params.

The decoder now retains optional `emittedAtMs` on all three supported notification methods, narrowed from signed i64 to `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER`. Omission remains accepted; null, strings, fractions, overflow and nonfinite values fail. Negative safe integers follow the signed wire type, not a claim that current emission produces negative time. No coercion or timestamp-based ordering/freshness authority is introduced. All unrelated envelope keys remain strict; params remain bounded projections. Tests embed five native records with no field removal or value substitution from the audit's original high transcript (JSON whitespace compacted only).

## Implemented contract

`protocol/codex-app-server.ts` is the sole runtime schema owner. It is pure parsing, not a new Effect runtime/service. Public message types derive from schemas; decoder result types are inferred. No persistent state, credential authority, process, HTTP route, Pi emulation, or registration is introduced.

| API                                                     | Accepted purpose                                                                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeCodexClientMessage` / `CodexClientMessageSchema` | Initialize with experimental API disabled; initialized notification; explicit ephemeral YOLO thread start (`danger-full-access`, approval `never`); one nonempty text input and explicit effort; turn interrupt |
| `decodeCodexInitializeResponse`                         | Required initialization readback, or RPC error                                                                                                                                                                  |
| `decodeCodexThreadStartResponse`                        | Bounded effective settings and thread ID projection, or RPC error                                                                                                                                               |
| `decodeCodexTurnStartResponse`                          | `inProgress` turn with empty items and no error, or RPC error                                                                                                                                                   |
| `decodeCodexInterruptResponse`                          | Exactly empty result object, or RPC error; never terminal evidence                                                                                                                                              |
| `decodeCodexNotification`                               | Agent-text delta, turn-started, turn-completed only                                                                                                                                                             |
| `rejectCodexServerRequest`                              | Any bounded request envelope becomes `{ id, error: { code: -32601, message: "Unsupported server request" } }`                                                                                                   |

Thread start uses **Scotty's user-approved YOLO-only contract**. The former read-only component fixture is not a supported mode. No resume, steering, approvals UX, client-side tools, skills, model discovery, authentication, config maps, history parity, or output schemas are modeled. Native Codex command execution is exercised through synthetic upstream tool calls. Unsupported server requests (including approval/tool/auth refresh) receive no success or invented approval payload. Request params and trace are discarded; only the validated ID is reflected. Malformed requests or invalid IDs produce a local failure, not a guessed response.

Decoders consume a single already-framed string and return Effect `Result`: success contains the validated projection; failure is only `invalid_message` or `message_too_large`. Schema errors and their raw input do not escape. Remote error **messages and model text remain untrusted bounded content**, not log-safe or credential-sanitized output. Do not log whole successes or propagate remote errors to public envelopes.

Bounds are Scotty admission limits, not upstream limits: 256 KiB UTF-8 per record, 64 KiB per text, 256 bytes per identifier, 4096 bytes per POSIX absolute path/error/readback string, exactly one text input, zero started items, at most one terminal agent-message summary. The whole-record bound also covers discarded/opaque fields. Excess client/envelope keys are errors; unowned incoming payload fields are dropped. Unknown notification methods and non-summary terminal items fail closed rather than being treated as valid modeled events.

Decoding is **not correlation or lifecycle acceptance**. The next host must correlate a response to its pending method and exact ID, compare settings/home to its explicit launch selection, and fence notifications by current thread/turn/process generation. A schema-valid stale event is still stale. Tests prove ID preservation, not a process state machine.

## Exact native host/image handoff

The final native helper cannot assume a local `effect` dependency. `worker/container/scotty-jsonl.mjs` buffers without a record limit; do not reuse it unchanged for this boundary. Packaging/image work is concurrently owned elsewhere; the following is its required handoff, not a report of that writer's completion. Existing Pi behavior is untouched by this repair.

Selected seam:

```text
protocol/codex-app-server.ts + locked Effect rc.112
  -> existing Bun bundler (target=node, format=esm)
  -> one self-contained codex-app-server.mjs
  -> future native .mjs process host imports sibling bundle
  -> bounded JSONL -> method-specific decoder -> host correlation/state handling
```

Rejected alternatives: native Node importing repository `.ts` (unsupported assumption for the image/runtime), hand-maintained `.mjs` validators (duplicate contract), installing Effect in the final image (extra runtime dependency). The chosen bundle needs **no new dependency**, but **does need an explicit image build/COPY change**, which was not made in this protocol-only tranche.

Reproduced with Bun **1.3.13** and native Node **v22.22.2**, from repository root:

```sh
bun build protocol/codex-app-server.ts --target=node --format=esm \
  --outfile=/tmp/scotty-codex-pin/codex-app-server.mjs
node --input-type=module <<'JS'
import { strict as assert } from "node:assert";
import {
  decodeCodexInterruptResponse,
  rejectCodexServerRequest,
} from "/tmp/scotty-codex-pin/codex-app-server.mjs";
assert.equal(decodeCodexInterruptResponse('{"id":3,"result":{}}')._tag, "Success");
assert.equal(decodeCodexInterruptResponse('invalid')._tag, "Failure");
assert.deepEqual(
  rejectCodexServerRequest('{"id":0,"method":"approval"}').success,
  { id: 0, error: { code: -32601, message: "Unsupported server request" } },
);
JS
```

This produced a roughly 0.52 MB bundle from 99 modules and passed with the artifact outside repository dependency resolution. No TS loader, runtime npm install, or duplicate schema was used. Generated output is not checked in.

Future image work, explicitly pending:

1. Include this protocol source/dependency graph in the actual prepared container context, not only the checkout. The audit found `codexProtocolIncluded:false` in the normal packaging projection. Then, in the existing `scotty-cli-build` stage, after `COPY protocol protocol`, run `bun build protocol/codex-app-server.ts --target=node --format=esm --outfile=/out/codex-app-server.mjs` against the existing lockfile. Prove the prepared-context build and staged host/sibling together; a full-checkout build alone misses this boundary. Packaging owner must preserve context budgets and credential/dependency exclusions.
2. Copy `/out/codex-app-server.mjs` into `/usr/local/bin/codex-app-server.mjs`. The future `/usr/local/bin/scotty-codex-session` native host imports `./codex-app-server.mjs`; its repository source should **not** import `.ts` at native runtime. A local host test must likewise stage host and generated sibling together.
3. Download the pinned Linux archive, enforce the exact digest above before extraction, require the one expected regular member, and `install -m 0755` that member to `/usr/local/bin/codex`. Assert `codex --version` equals `codex-cli 0.153.4`. Replace the current Codex-absence assertion only with explicit image-scope approval.
4. Launch `/usr/local/bin/codex` with argv `app-server --listen stdio://` only from a separately implemented, supervised host with explicit isolated HOME/CODEX_HOME/cwd and an environment allowlist. No ambient auth/config import. Use the nonsecret settings mechanism below for component tests; managed egress/auth still needs separate proof.
5. That host owns pre-allocation byte framing, aggregate output/event budgets, response-method/ID correlation, harmless-notification disposition without masking malformed supported events, settings verification, terminal waits, interruption, deadlines, process-group cleanup and honest ambiguous outcomes. None of these follows from a successful decoder.

The Session remains the later durable authority; this protocol component owns no Session state. Full Slice 1 is blocked pending that bounded host and its deterministic synthetic-upstream/exit/timeout/cleanup tests. Native binary conversation is now proved only through the audit's synthetic macOS harness. Image compatibility/startup and production operation remain unproved. The audit observed a command in its own descendant process group surviving interruption and forced app-server group death; graceful EOF removed it. A missing app-server PGID is not sufficient cleanup evidence. Host tests must cover owned descendants and report ambiguous cleanup honestly, including Linux-specific proof.

### Ready host API and config sequence

Native host imports the exported decoders from the generated sibling `./codex-app-server.mjs`. Each takes one framed string and returns `{ _tag: "Success", success }` or `{ _tag: "Failure", failure: "invalid_message" | "message_too_large" }`. No Effect runtime is needed at this native seam. Use the pending method to select the response decoder; RPC errors are successful envelope decodes containing `error`, not operation success. Serialize only validated outbound messages and append one newline. Metadata is not an ID or lifecycle fence.

The claim that effort cannot be established before prompting was incorrect. Write an isolated, host-owned, **nonsecret** `CODEX_HOME/config.toml` before spawning the child. The audit's exact component configuration is below; substitute its dynamically allocated loopback port and one validated requested effort (`high` or `low` in the demonstrated probes), not arbitrary TOML interpolation:

```toml
model = "gpt-5.2"
model_provider = "synthetic"
model_reasoning_effort = "high"
[analytics]
enabled = false
[model_providers.synthetic]
name = "Audit loopback synthetic"
base_url = "http://127.0.0.1:<allocated-port>/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
```

No auth.json, token, ambient config copy, or thread/start `config` extension is required. Release test [thread_start.rs:323–375](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/tests/suite/v2/thread_start.rs#L323-L375) independently uses isolated `model_reasoning_effort = "high"` and checks native model/effort.

Exact sequence supported by the current API:

1. Resolve canonical isolated HOME, CODEX_HOME and cwd (macOS `/tmp` may read back as `/private/tmp`); create config before launch. Audit argv is `app-server --listen stdio://`. Its child environment is allowlisted HOME, CODEX_HOME, PATH=`/usr/bin:/bin`, TMPDIR pointing at isolated home, upper/lower HTTP_PROXY/HTTPS_PROXY/ALL_PROXY pointing at loopback, and upper/lower NO_PROXY=`127.0.0.1,localhost`. Do not spread ambient env. This synthetic proxy setup is not managed production egress.
2. Send `{id:1,method:"initialize",params:{clientInfo:{name:"scotty-audit",version:"slice-1"},capabilities:{experimentalApi:false}}}`. Decode with `decodeCodexInitializeResponse`, correlate exact ID, reject RPC error, compare codexHome and expected runtime/version evidence. Then send `{method:"initialized"}`.
3. Send `{id:"thread",method:"thread/start",params:{model:"gpt-5.2",modelProvider:"synthetic",cwd:<canonical-cwd>,approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:true}}`. Decode with `decodeCodexThreadStartResponse`. Compare model, modelProvider, cwd, approvalPolicy=`never`, approvalsReviewer=`user`, sandbox=`{type:"dangerFullAccess"}`, and **reasoningEffort equal to the requested config value**, before any prompt. Null/missing/mismatch is not readiness. Retain validated thread ID in the host's generation. Discovery/support rejection is still required; high/low synthetic readback does not prove every model or string supported.
4. Send `{id:2,method:"turn/start",params:{threadId:<validated-id>,input:[{type:"text",text:<bounded-prompt>}],effort:<same-requested-effort>}}`. Decode with `decodeCodexTurnStartResponse`; acceptance is not completion. Correlate/fence `decodeCodexNotification` results by thread, turn and process generation; delta streams text, terminal completed/failed/interrupted ends the turn. Do not use `emittedAtMs` as a monotonic clock or authority.
5. Send `{id:3,method:"turn/interrupt",params:{threadId:<validated-id>,turnId:<current-turn>}}`; `decodeCodexInterruptResponse` validates acknowledgement only. Await the matching terminal interrupted event. Unsupported server requests use `rejectCodexServerRequest`; malformed/unknown events need explicit bounded host disposition, not blanket ignoring decoder failures. Stop/EOF and owned descendant cleanup are separate obligations.

The audit asserts thread/start high/low readback with **zero upstream requests**, then observes the same effort in both answer and interrupted-turn request bodies, selected gpt-5.2/custom provider, and no Authorization header. This is a ready mechanism/API handoff, not an implemented host, discovery API, or authorization design.

## Grounding and checks

Read project AGENTS, the configuring-Codex, boundary-decoding, schema-type, TypeScript-safety and testing skills; Effect's `.agents/AGENTS.md`, `.patterns/effect.md`, `.patterns/testing.md`; searched `ai-docs/src` and migration material; inspected `migration/schema.md`, actual `Schema.ts`, `test/schema/Schema.test.ts`, and the established session-terminal contract/tests. Effect pin remains `2600f62f4532026928454dcea8d1c48557b3f942` / rc.112. No nontrivial async Effect, Promise-client, Alchemy or lifecycle pattern was added.

During implementation, checks caught the rc.112 object-argument form of `Schema.isBetween`, typed assertion fixture widening, and the fact that `Schema.Struct({})` is not an exact empty-object validator. Corrected these; the interrupt result uses `Schema.Record(Schema.String, Schema.Never)`, with tests rejecting arrays/scalars/null/nonempty objects. Schema compiler calls were hoisted to module scope after focused lint caught the factory form.

Original pre-audit checks (local schema component tier; these missed the native envelope):

- Owned-file oxfmt, before lint: passed.
- `npx vitest run worker/test/protocol/codex-app-server.test.ts`: **12 passed**.
- `npm run lint:skills`: passed.
- `npx oxlint --disable-nested-config --deny-warnings protocol/codex-app-server.ts worker/test/protocol/codex-app-server.test.ts`: passed.
- `npm run typecheck:worker`: passed, including the imported protocol and tests.
- `npm run typecheck:contracts`: passed.
- Official archive SHA checks, layout inspection, isolated version/schema generation, 15 source comparisons: passed as described above.
- Existing-Bun bundle and native Node consumption: passed.

### Bounded repair verification

The unchanged audit `repro-envelope.mjs` was run first against its original bundle: native=`Failure`, withoutTimestamp=`Success`, assertion exit 1. After rebuilding from the repaired source, the same script exits 0 with both=`Success`. Audit scripts were inspected and not modified. Original bundle/scripts/high/low transcripts were preserved in `/tmp/scotty-protocol-repair/before/` before replacing the audit bundle and rerunning its probes.

Exact checks, all passed after repair:

```sh
npx oxfmt protocol/codex-app-server.ts worker/test/protocol/codex-app-server.test.ts docs/research/codex-agent-pin.md
npx oxlint --disable-nested-config --deny-warnings protocol/codex-app-server.ts worker/test/protocol/codex-app-server.test.ts
npm run lint:skills
npx vitest run worker/test/protocol/codex-app-server.test.ts
npm run typecheck:worker
npm run typecheck:contracts
bun build protocol/codex-app-server.ts --target=node --format=esm --outfile=/tmp/scotty-slice1-audit/codex-app-server.mjs
node /tmp/scotty-slice1-audit/repro-envelope.mjs
node /tmp/scotty-protocol-repair/replay.mjs
node /tmp/scotty-slice1-audit/probe.mjs high
node /tmp/scotty-slice1-audit/probe.mjs low
git diff --check
```

- **14 protocol tests passed**, including five embedded native records and malformed metadata for each supported method, exact safe-integer endpoints, omitted metadata, unrelated envelope rejection, and whole-record limits with metadata.
- Replay accepted **all ten original high/low native notifications** without removing fields. A separate object-equality check confirmed all five embedded fixtures equal the original high transcript records.
- Both fresh native probes returned **PASS**, no decoder failures, synthetic answer/delta/completion, empty interrupt acknowledgement and matching interrupted terminal, high/low pre-prompt settings readback and request-body effort. Logs: `/tmp/scotty-protocol-repair/high.log` and `low.log`; refreshed transcripts: `/tmp/scotty-slice1-audit/run-{high,low}/transcript.json`. Both children exited code 0 and their app-server groups were absent after harness cleanup. This does not prove detached descendant cleanup.
- Bundle: 99 modules, approximately 0.52 MB; native Node consumed it outside repository dependency resolution. Effect remains pinned at `2600f62f4532026928454dcea8d1c48557b3f942`; Effect/Alchemy reference worktrees remain clean.

No full suite, host fake-child fault matrix, Linux/image execution, real-provider request, deployment, resource creation, or credential-leak canary was run. Probes ignore a known set of unmodeled notification methods; they are not a production disposition policy. No syscall-level credential-read trace is claimed. Packaging acceptance belongs to the concurrent writer. Slice 0's earlier baseline is recorded separately in `docs/plans/codex-agent-progress.md`; it is not substituted for missing host, Linux cleanup, or deployed proof.

## YOLO repair verification

Evidence: `/tmp/scotty-yolo/REPORT.md`, `checks.sh`, `checks-final.log`,
`image.log`, `linux-final.log`, and fetched release source under `source/`.
No commit or independent audit was run; the parent owns the integrated audit.

- Fresh isolated native schema generation matched the pinned release's
  `ThreadStartParams.json` and `ThreadStartResponse.json` byte-for-byte, retaining
  the digests above. macOS binary digest remains
  `b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3`.
- Focused format/check and lint, `lint:skills`, worker/contracts/CLI typechecks,
  Node syntax checks and `git diff --check`: passed. No broad formatting.
- Effect/protocol: **26 passed**. Packaging/image checks: **15 passed**.
  Native macOS: **49 passed, zero skipped**. Pi regression: **3 passed**.
- Rebuilt prepared-context image through the configured Docker context using
  the existing image checker: passed version/package/host and size gates.
  Image `scotty-container:ci`, ID
  `sha256:91d5cc22fe074ed38feb401fa545e2f65ade4c5b0ab01e0494ed5711dc434141`,
  `docker image inspect Size` **1,124,138,566 bytes** (limit 1,310,720,000).
  No `bwrap` executable found. Linux binary digest remains
  `56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da`.
  Installed host bundle matches the freshly built source bundle, SHA-256
  `2e6a0ff7157f9fd7f7734b608e2f0702d7b383a2c6d3e7a5f3559cc29c960ddf`.
- Linux native matrix: **49 passed, zero skipped** in disposable
  `--init --platform linux/amd64 --network none` containers, no home mounts or
  security-setting changes. The installed executable and bundle perform a real
  `printf SCOTTY_YOLO_WRITE_OK > yolo-proof.txt && /bin/cat yolo-proof.txt` command;
  the fixture checks both upstream command output and the exact workspace file,
  interrupted terminal and graceful EOF receipt. High/low conversations read back
  YOLO and effort with zero upstream requests before prompting.
- The formerly failing exact command
  `echo SCOTTY_OWNED_PID=$$; exec /bin/sleep 60` now executes on Linux. It survives
  turn interruption; graceful EOF removes the exact observed PID. After app-server
  group SIGKILL, that ordinary sleep dies on Linux but survives on macOS. This is
  consistent with pinned [pipe spawn](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/utils/pty/src/pipe.rs#L155-L165)
  and [Linux parent-death signal](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/utils/pty/src/process_group.rs#L22-L44).
  A second native command, prefixed with `trap '' TERM;`, survives forced parent
  death on both platforms. The fixture then kills only that exact owned PID and
  waits for absence. All production receipts still say descendants unverified.

The initial packaging run caught two stale bubblewrap-flag assertions; removed.
The initial Linux YOLO run passed command execution but caught the prior
macOS-only survival expectation; corrected against release source and strengthened
with the TERM-resistant case. Focused lint caught conditional fixture assertions;
selection assertions now run unconditionally over captured outbound messages.
Intermediate failures remain in the evidence directory; final runs above pass.

Proof tiers: schema/source, Effect component, actual prepared packaging/image,
synthetic native macOS and emulated Linux. All real-binary tests use fresh isolated
runtime homes and synthetic loopback upstreams, no ambient credentials or real
provider. This does not prove production credential/managed-egress integration,
deployment, full Slice 1 admission, arbitrary models or descendant containment.
The prior inner-sandbox Linux command blocker is resolved; parent integrated audit
and later production integration/proof remain outstanding.
