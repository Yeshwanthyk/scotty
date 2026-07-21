# Chunk 2 guarded confirmation gate

Chunk 2 stops before `alchemy.run.ts`. Wrangler remains the sole production owner. Do not run an
Alchemy apply or write production Alchemy state until every check below passes against a seeded,
non-production clone.

## Read-only inventory

Using an authenticated local operator session, read and record metadata only:

- Worker `scotty-worker`, its compatibility/assets/routes/bindings, and secret binding names/types;
- `SANDBOX` class `ScottySandbox`, its current namespace ID and host script;
- the Container application ID/name and its associated Durable Object namespace ID;
- the `SESSIONS` KV namespace ID and exact live title (never derive the title);
- the `scotty-backups` R2 storage, lifecycle, CORS, domain, and location settings.

Never read or record secret plaintext. Codex, GitHub, and Scotty HTTP auth must each have an
independently approved Chunk 1B write-only source and identifier-only runtime binding.

## Executable plan review

Pass the complete runtime-shaped Alchemy plan and an exactly resource-FQN-keyed transcript through
`normalizeChunk2Plan`. The Plan must contain exactly `resources`, `actions`, `deletions`,
`actionDeletions`, `output`, and `cycleMembers`. The four node collections are keyed records, not
arrays. Actions recognize only `run` and `noop`; every action, deletion, action deletion, and cycle
member blocks adoption. `cycleMembers` may be a `Set<string>` or strict serialized string array.
Resource FQN remains separate from `resource.LogicalId`; type, removal policy, action, and binding
reviews come from `resource.Type`, `resource.RemovalPolicy`, `node.action`, and
`node.bindings[].sid/action`. Transcript keys must exactly match resource FQNs and supply only review
facts unavailable from Plan, including identities, changed inputs, topology, and migrations.

The protected CRUD set is exactly the adopted Worker, Container, KV namespace, and R2 bucket plus
three fresh `Scotty.WriteOnlySecret` resources. The external Durable Object namespace is not an
Alchemy-owned fake CRUD resource. Prove it only through the exact `SANDBOX` Worker binding and
empty new/deleted/renamed/transferred migration arrays.

On pinned beta.63, adopted resources must be `noop`. Each fresh secret may be `create` or `noop` on
the reviewed plan and must be `noop` on the second plan. A create has no before identity; a noop has
equal before/desired identities. Secret props contain exactly
`sourceId`, `accountId`, `storeId`, `secretName`, `bindingName`, `providerVersion`, and
`keyedDigest`, with provider version exactly `1`. Active evidence also records the physical ID.
Reviewed and second plans correlate these fields by binding name, independent of array order.

The accepted beta.63 adoption plan is a Worker noop, so it preserves the exact Wrangler binding set,
including the three current `secret_text` binding types. Fresh write-only secret resources may be
created separately, but a noop Worker cannot bind them. Secrets Store conversion remains a future
Worker update and requires executable provider transcript plus deny-by-default request-firewall
evidence before any request may leave the process; that transition remains blocked here. Plan-node
bindings are exactly `SandboxContainer` on `MonolithWorker` and `Sandbox` on `SandboxContainer`, all
with `noop` actions. KV, R2, and the three secret resource nodes have no bindings. Native Worker
bindings exist only in `desiredTopology.worker.bindings`.

## Clone-only adoption proof

1. Clone the exact Wrangler topology and seed a DO session record, operation lease, credential
   bundle, hard-cap schedule, KV projection, and R2 backup.
2. Record before/after physical IDs for the Worker, external SQLite Durable Object namespace,
   Container application, KV namespace, and R2 bucket.
3. Require adopted resources to be exact no-ops. Record every resolved identity, changed input key,
   nested binding action, deletion, and action deletion instead of accepting a summary count.
4. Capture the outgoing Worker migration metadata and require no new, deleted, renamed, or
   transferred Durable Object class. The existing `v1` `new_sqlite_classes` migration must not be
   re-emitted.
5. Omit `lifecycleRules` from the R2 adoption declaration; do not pass `[]`.
6. Apply only to the clone. Compare full before, plan-desired, and observed-after topology: Worker
   identity/config/assets/output/bindings, DO identity and migration state, Container identity and
   association, KV UUID/title, and complete R2 policy/settings. Evidence uses only observed
   `{before,after}` values; desired values exist only in plan snapshots.
7. Record the three exact active identifier-only secret references, including approved source IDs,
   store IDs, and secret names. Capture and validate a second all-noop plan.
8. Read Alchemy state after the no-op apply and require exact persisted `retain` rows for the four
   adopted resources and three write-only secrets. Exercise destroy only on a disposable clone and
   independently record that the Worker, DO namespace, Container, KV, and R2 identities survive.
9. Scan the reviewed-plan, second-plan, state, log, output, and bundle artifacts with exactly two
   labeled, unique, nonblank, sufficiently long synthetic markers (`plaintext` and `ownerKey`).
   Require exact unique artifact IDs/kinds, an explicit clean result per artifact, an empty match
   list, and `sha256:` plus 64 lowercase hex digits for every artifact and provider
   transcript/request digest. Plan scanning includes resources, actions, and output.

This executable gate is deliberately conservative and cannot approve cold adoption on pinned
Alchemy `2.0.0-beta.63`: cold adoption initializes old bindings as empty, so the existing
Container-to-DO association can plan as a replacement. `assertChunk2Ready` therefore always emits
`B4_CONTAINER_IDENTITY_UNPROVEN` on this pin even when every supplied artifact is otherwise exact.
Upgrade only in a separate pinned compatibility change or use an approved public upstream fix. A
future pin that permits adopted-resource updates must first add provider transcript capture and a
request firewall that proves the reviewed plan's API requests are the only Cloudflare mutations
that can be sent. Do not seed state, omit the association, guess identities, or add a second
reconciler.
