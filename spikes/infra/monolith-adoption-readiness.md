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

## Clone-only adoption proof

1. Clone the exact Wrangler topology and seed a DO session record, operation lease, credential
   bundle, hard-cap schedule, KV projection, and R2 backup.
2. Confirm a supported Alchemy version can cold-adopt the named Worker, external SQLite Durable
   Object namespace, Container application, KV namespace, and R2 bucket.
3. Require no persistent-resource create, delete, or replace. Review every update because a
   provider update can still recreate a Container or rewrite Worker bindings.
4. Capture the outgoing Worker migration metadata and require no new, deleted, renamed, or
   transferred Durable Object class. The existing `v1` `new_sqlite_classes` migration must not be
   re-emitted.
5. Omit `lifecycleRules` from the R2 adoption declaration; do not pass `[]`.
6. Apply only to the clone. Require unchanged physical IDs, all seeded data, the Container/DO
   association, secret behavior, and a second all-noop plan.
7. Read Alchemy state after a no-op apply and prove `retain` persisted for Worker/DO, Container,
   KV, and R2. Exercise destroy only on a disposable clone and independently verify those resources
   remain.

Pinned Alchemy `2.0.0-beta.63` currently fails this gate: cold adoption initializes old bindings as
empty, so the existing Container-to-DO association can plan as a replacement. Upgrade only in a
separate pinned compatibility change or use an approved public upstream fix; do not seed state,
omit the association, guess identities, or add a second reconciler.
