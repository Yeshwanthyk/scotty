import { assert, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import {
  credentialCryptoLayer,
  installationWrappingKeyLayer,
} from "../../worker/src/credentials/crypto";
import {
  CredentialStore,
  credentialStoreLayer,
  type CredentialRegistryStorage,
  type CredentialRegistryFailure,
} from "../../worker/src/credentials/store";
import {
  CredentialRegistryAuthoritySchema,
  CredentialRegistryUpsertInputSchema,
  type CredentialRegistryMaterial,
} from "../../worker/src/credentials/contracts";
import { synchronizeCredentialRegistry } from "../src/sandbox-sync";
import { HttpTransport } from "../src/services";

const token = "synthetic-github-token-not-a-real-secret";
const scoped = {
  name: "github",
  kind: "github-cli",
  scope: "repository",
  repositories: ["owner/old"],
  token,
} as const;
const global = { name: "github", kind: "github-cli", scope: "global", token } as const;
const handle = "scotty-managed://github/github/git-https";
const oldSession = "old-session";
const newSession = "new-session";
const decodeAuthority = Schema.decodeUnknownEffect(CredentialRegistryAuthoritySchema);
const decodeUpsert = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CredentialRegistryUpsertInputSchema),
);

function fixture() {
  let persisted: unknown;
  const storage: CredentialRegistryStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => structuredClone(persisted),
        put: async (value) => {
          persisted = structuredClone(value);
        },
      }),
  };
  const crypto = credentialCryptoLayer.pipe(
    Layer.provide(
      installationWrappingKeyLayer(() =>
        Effect.succeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
      ),
    ),
  );
  // A fresh layer each time: policy/grants survive reconstructed store instances.
  const use = <A>(
    action: (store: CredentialStore["Service"]) => Effect.Effect<A, CredentialRegistryFailure>,
  ) =>
    Effect.flatMap(CredentialStore, action).pipe(
      Effect.provide(credentialStoreLayer(storage, "scope-proof").pipe(Layer.provide(crypto))),
    );
  const upsert = (credential: CredentialRegistryMaterial, expectedVersionRef?: string) =>
    use((store) =>
      store.upsert({
        credential,
        ...(expectedVersionRef === undefined ? {} : { expectedVersionRef }),
      }),
    );
  const promote = (expectedVersionRef: string) =>
    use((store) =>
      store.useTokenPermissions({
        name: scoped.name,
        scope: scoped.scope,
        repositories: scoped.repositories,
        expectedVersionRef,
      }),
    );
  return { use, upsert, promote, snapshot: () => decodeAuthority(persisted) };
}

it.effect(
  "promotion permits new repository selection without changing ciphertext or existing grants",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const initial = yield* f.upsert(scoped);
      const before = yield* f
        .use((store) => store.resolveGithubCliCredential({ repository: "owner/new" }))
        .pipe(Effect.flip);
      assert.equal(before.reason, "credential_missing");
      const oldGrant = yield* f.use((store) =>
        store.issueGrants({ sessionId: oldSession, repository: "owner/old" }),
      );
      const oldAuthority = yield* f.snapshot();
      const updated = yield* f.promote(initial.versionRef);
      assert.equal(updated.scope, "global");
      assert.equal(updated.versionRef, initial.versionRef);
      const migratedAuthority = yield* f.snapshot();
      assert.deepEqual(migratedAuthority.versions, oldAuthority.versions);
      assert.deepEqual(migratedAuthority.grants, oldAuthority.grants);
      assert.notInclude(JSON.stringify(migratedAuthority), token);
      const resolved = yield* f.use((store) =>
        store.resolveGithubCliCredential({ repository: "owner/new" }),
      );
      assert.equal(Redacted.value(resolved), token);
      Redacted.wipeUnsafe(resolved);
      const replay = yield* f.use((store) =>
        store.issueGrants({ sessionId: oldSession, repository: "owner/old" }),
      );
      assert.deepEqual(replay, oldGrant);
      const newGrant = yield* f.use((store) =>
        store.issueGrants({ sessionId: newSession, repository: "owner/new" }),
      );
      assert.equal(newGrant.grants[0]?.versionRef, initial.versionRef);
      const oldResolved = yield* f.use((store) =>
        store.resolve({
          sessionId: oldSession,
          name: "github",
          kind: "github-cli",
          versionRef: initial.versionRef,
          handle,
        }),
      );
      assert.equal(Redacted.value(oldResolved), token);
      Redacted.wipeUnsafe(oldResolved);
    }),
);

it.effect("rejects stale real CLI sync without undoing a same-token scope promotion", () =>
  Effect.gen(function* () {
    const f = fixture();
    const initial = yield* f.upsert(scoped);
    let writes = 0;
    const transport = Layer.succeed(HttpTransport)({
      fetch: (input, init) =>
        Effect.gen(function* () {
          const request = new Request(input, init);
          if (request.method === "GET") {
            const staleStatuses = yield* f.use((store) => store.statuses);
            // An owner changes scope after sync reads it but before sync sends its PUT.
            yield* f.promote(initial.versionRef);
            return Response.json(staleStatuses);
          }
          assert.equal(new URL(request.url).pathname, "/api/credentials/github");
          assert.equal(request.method, "PUT");
          const requestBody = yield* Effect.promise(() => request.text());
          const decoded = yield* decodeUpsert(requestBody);
          writes++;
          const result = yield* f.use((store) => store.upsert(decoded)).pipe(Effect.result);
          return Result.isSuccess(result)
            ? Response.json(result.success)
            : Response.json(
                { error: { code: "conflict", message: result.failure.message } },
                { status: 409 },
              );
        }).pipe(Effect.orDie),
    });
    const result = yield* synchronizeCredentialRegistry({
      target: { host: "https://proof.invalid", token: "synthetic-root" },
      credentials: [global],
    }).pipe(Effect.provide(transport), Effect.flip);
    assert.equal(writes, 1);
    assert.equal(result.code, "credential_registry_sync_conflict");
    assert.equal((yield* f.use((store) => store.statuses))[0]?.scope, "global");
  }),
);

it.effect("rejects promotion that would collide with another global credential", () =>
  Effect.gen(function* () {
    const f = fixture();
    const initial = yield* f.upsert(scoped);
    yield* f.upsert({ ...global, name: "other-github", token: "another-synthetic-token" });
    const before = yield* f.snapshot();
    const denied = yield* f.promote(initial.versionRef).pipe(Effect.flip);
    assert.equal(denied.reason, "credential_conflict");
    assert.deepEqual(yield* f.snapshot(), before);
  }),
);

it.effect("promotion checks version and policy, and retries are idempotent", () =>
  Effect.gen(function* () {
    const f = fixture();
    const initial = yield* f.upsert(scoped);
    const before = yield* f.snapshot();
    const stale = yield* f.promote("b".repeat(64)).pipe(Effect.flip);
    assert.equal(stale.reason, "credential_conflict");
    const changed = yield* f
      .use((store) =>
        store.useTokenPermissions({
          name: "github",
          scope: "repository",
          repositories: ["owner/wrong"],
          expectedVersionRef: initial.versionRef,
        }),
      )
      .pipe(Effect.flip);
    assert.equal(changed.reason, "credential_conflict");
    assert.deepEqual(yield* f.snapshot(), before);
    yield* f.promote(initial.versionRef);
    const after = yield* f.snapshot();
    assert.deepEqual(after.issuedSessions, before.issuedSessions);
    yield* f.promote(initial.versionRef);
    assert.deepEqual(yield* f.snapshot(), after);
    const refreshed = yield* f.upsert(
      { ...global, token: "new-synthetic-token" },
      initial.versionRef,
    );
    assert.equal(refreshed.scope, "global");
    const staleRetry = yield* f.promote(initial.versionRef).pipe(Effect.flip);
    assert.equal(staleRetry.reason, "credential_conflict");
  }),
);

it.effect(
  "fresh GitHub setup covers new repositories and same-policy refresh remains supported",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const first = yield* f.upsert(global);
      const refreshed = yield* f.upsert(
        { ...global, token: "refreshed-synthetic-token" },
        first.versionRef,
      );
      const grants = yield* f.use((store) =>
        store.issueGrants({ sessionId: newSession, repository: "owner/new" }),
      );
      assert.equal(grants.grants[0]?.versionRef, refreshed.versionRef);
    }),
);
