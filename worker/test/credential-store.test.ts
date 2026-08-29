import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  credentialCryptoLayer,
  installationWrappingKeyLayer,
  CREDENTIAL_WRAPPING_KEY_BYTES,
} from "../src/credential-crypto";
import {
  CredentialStore,
  credentialStoreLayer,
  type CredentialRegistryFailure,
  selectGithubCliCredential,
  selectPiAuthCredential,
  type CredentialRegistryStorage,
} from "../src/credential-store";
import {
  decodeCredentialRegistryAuthorityResult,
  type CredentialRegistryCredential,
  type CredentialRegistrySyncMaterial,
} from "../src/credential-contracts";
import { formatManagedHandle } from "../../protocol/credentials";

const INSTALLATION = "test-installation";
const SESSION = "a0b1c2d3e4f5";
const KEY = Uint8Array.from({ length: CREDENTIAL_WRAPPING_KEY_BYTES }, (_, index) => index + 1);
const PI_HANDLE = formatManagedHandle({ name: "openai", provider: "openai-codex", slot: "access" });
const BASE = "scotty-managed-test-secret";

type TestCredentialStorage = CredentialRegistryStorage & {
  readonly snapshot: () => unknown;
  readonly failNextPut: () => void;
  readonly loseNextCommitResponse: () => void;
};

const memoryStorage = (initial?: unknown): TestCredentialStorage => {
  let value = structuredClone(initial);
  let failNextPut = false;
  let loseNextCommitResponse = false;
  return {
    transaction: async (operation) => {
      let committed = false;
      const result = await operation({
        get: async () => structuredClone(value),
        put: async (next) => {
          if (failNextPut) {
            failNextPut = false;
            return Promise.reject(new Error("injected pre-commit persistence failure"));
          }
          value = structuredClone(next);
          committed = true;
        },
      });
      if (committed && loseNextCommitResponse) {
        loseNextCommitResponse = false;
        return Promise.reject(new Error("injected committed persistence response loss"));
      }
      return result;
    },
    snapshot: () => structuredClone(value),
    failNextPut: () => {
      failNextPut = true;
    },
    loseNextCommitResponse: () => {
      loseNextCommitResponse = true;
    },
  };
};

const cryptoLayer = credentialCryptoLayer.pipe(
  Layer.provide(installationWrappingKeyLayer(() => Effect.succeed(Uint8Array.from(KEY)))),
);
const storeLayer = (storage: CredentialRegistryStorage) =>
  credentialStoreLayer(storage, INSTALLATION).pipe(Layer.provide(cryptoLayer));
const useStore = <A>(
  storage: CredentialRegistryStorage,
  use: (store: CredentialStore["Service"]) => Effect.Effect<A, CredentialRegistryFailure>,
) => Effect.provide(Effect.flatMap(CredentialStore, use), storeLayer(storage));

const desiredPiInput = (provider: unknown) => ({
  version: 1 as const,
  credentials: [
    {
      name: "openai",
      kind: "pi-auth" as const,
      scope: "global" as const,
      providers: provider,
    },
  ],
});

const grantInput = { version: 1 as const, sessionId: SESSION };

const success = <A>(result: Result.Result<A, unknown>): A =>
  Result.match(result, {
    onFailure: () => assert.fail("unexpected registry authority failure"),
    onSuccess: (value) => value,
  });
const failure = <A>(result: Result.Result<A, unknown>): unknown =>
  Result.match(result, {
    onFailure: (error) => error,
    onSuccess: () => assert.fail("expected registry failure"),
  });
const requireOAuthVersion = (storage: TestCredentialStorage): string => {
  const versionRef = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()))
    .credentials[0]?.currentVersionRef;
  assert.isString(versionRef);
  return versionRef;
};

const prepareOAuth = (storage: TestCredentialStorage) =>
  Effect.gen(function* () {
    yield* useStore(storage, (store) =>
      store.sync(
        desiredPiInput({
          "openai-codex": {
            type: "oauth",
            access: `${BASE}-access`,
            refresh: `${BASE}-refresh`,
            expires: 1,
          },
        }),
      ),
    );
    const versionRef = requireOAuthVersion(storage);
    yield* useStore(storage, (store) => store.issueGrants(grantInput));
    return versionRef;
  });
const refreshInput = (versionRef: string, nonce: string) => ({
  version: 1 as const,
  sessionId: SESSION,
  name: "openai" as const,
  versionRef,
  nonce,
});

const persistInput = (versionRef: string, nonce: string, accessToken: string) => ({
  ...refreshInput(versionRef, nonce),
  patch: { accessToken },
});

describe("CredentialStore", () => {
  it("selects one exact GitHub declaration before globals and fails closed on ambiguity", () => {
    const credential = (
      name: string,
      scope: CredentialRegistryCredential["scope"],
      repositories?: CredentialRegistryCredential["repositories"],
    ): CredentialRegistryCredential => ({
      name,
      kind: "github-cli",
      scope,
      ...(repositories === undefined ? {} : { repositories }),
      currentVersionRef: "version-a",
    });
    const exact = credential("exact", "repository", ["Owner/Repo"]);
    const global = credential("global", "global");

    const preferred = selectGithubCliCredential([global, exact], "owner/repo");
    assert.strictEqual(
      Result.match(preferred, {
        onFailure: () => "selection-failed",
        onSuccess: ({ name }) => name,
      }),
      "exact",
    );
    assert.strictEqual(
      Result.match(selectGithubCliCredential([global], "other/repo"), {
        onFailure: () => "selection-failed",
        onSuccess: ({ name }) => name,
      }),
      "global",
    );
    assert.deepStrictEqual(
      selectGithubCliCredential(
        [exact, credential("exact-two", "repository", ["owner/repo"])],
        "owner/repo",
      ),
      Result.fail("ambiguous"),
    );
    assert.deepStrictEqual(
      selectGithubCliCredential(
        [credential("one", "global"), credential("two", "global")],
        "owner/repo",
      ),
      Result.fail("ambiguous"),
    );
    assert.deepStrictEqual(selectGithubCliCredential([], "owner/repo"), Result.fail("missing"));
  });

  it("selects at most one applicable Pi credential", () => {
    const credential = (name: string): CredentialRegistryCredential => ({
      name,
      kind: "pi-auth",
      scope: "global",
      currentVersionRef: "version-a",
    });
    assert.strictEqual(
      Result.match(selectPiAuthCredential([credential("openai")]), {
        onFailure: () => "selection-failed",
        onSuccess: ({ name }) => name,
      }),
      "openai",
    );
    assert.deepStrictEqual(selectPiAuthCredential([]), Result.fail("missing"));
    assert.deepStrictEqual(
      selectPiAuthCredential([credential("openai"), credential("alternate")]),
      Result.fail("ambiguous"),
    );
  });

  it.effect(
    "pins encrypted versions, removes the desired value for new Sessions, and garbage-collects after release",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-04-05T06:07:08.000Z"));
        const storage = memoryStorage();
        yield* useStore(storage, (store) =>
          store.sync(desiredPiInput({ openai: { type: "api_key", key: `${BASE}-a` } })),
        );
        const firstAuthority = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()));
        const firstVersionRef = firstAuthority.credentials[0]?.currentVersionRef;
        assert.isString(firstVersionRef);
        const issued = yield* useStore(storage, (store) => store.issueGrants(grantInput));
        assert.strictEqual(issued.grants[0]?.versionRef, firstVersionRef);

        const synced = yield* useStore(storage, (store) =>
          store.sync(desiredPiInput({ openai: { type: "api_key", key: `${BASE}-b` } })),
        );
        assert.deepStrictEqual(synced.credentials, [
          { name: "openai", kind: "pi-auth", scope: "global", configured: true },
        ]);
        const secondVersionRef = success(
          decodeCredentialRegistryAuthorityResult(storage.snapshot()),
        ).credentials[0]?.currentVersionRef;
        assert.isString(secondVersionRef);
        const repeatedSync = yield* useStore(storage, (store) =>
          store.sync(desiredPiInput({ openai: { type: "api_key", key: `${BASE}-b` } })),
        );
        assert.deepStrictEqual(repeatedSync.credentials, synced.credentials);
        const old = yield* useStore(storage, (store) =>
          store.resolve({
            ...grantInput,
            name: "openai",
            kind: "pi-auth",
            versionRef: firstVersionRef,
            handle: PI_HANDLE,
          }),
        );
        assert.strictEqual(
          Redacted.value(old),
          JSON.stringify({ openai: { key: `${BASE}-a`, type: "api_key" } }),
        );
        const nextSession = yield* useStore(storage, (store) =>
          store.issueGrants({ version: 1, sessionId: "b0c1d2e3f4a5" }),
        );
        assert.strictEqual(nextSession.grants[0]?.versionRef, secondVersionRef);

        yield* useStore(storage, (store) => store.sync({ version: 1, credentials: [] }));
        const noGrant = yield* useStore(storage, (store) =>
          store.issueGrants({ version: 1, sessionId: "c0d1e2f3a4b5" }),
        );
        assert.deepStrictEqual(noGrant.grants, []);
        const beforeRelease = decodeCredentialRegistryAuthorityResult(storage.snapshot());
        const before = success(beforeRelease);
        assert.deepStrictEqual(before.credentials, []);
        assert.strictEqual(before.versions.length, 2);

        const released = yield* useStore(storage, (store) =>
          store.release({ version: 1, sessionId: SESSION }),
        );
        assert.deepStrictEqual(released, {
          version: 1,
          sessionId: SESSION,
          released: true,
        });
        const releaseRetry = yield* useStore(storage, (store) =>
          store.release({ version: 1, sessionId: SESSION }),
        );
        assert.deepStrictEqual(releaseRetry, released);
        yield* useStore(storage, (store) =>
          store.release({ version: 1, sessionId: "b0c1d2e3f4a5" }),
        );
        const afterRelease = decodeCredentialRegistryAuthorityResult(storage.snapshot());
        const after = success(afterRelease);
        assert.deepStrictEqual(after.versions, []);
        assert.ok(!JSON.stringify(storage.snapshot()).includes(BASE));
      }),
  );

  it.effect("proves Pi provider material is encrypted at rest and converges on retry", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const providerSecret = `${BASE}-pi`;
      const input = {
        version: 1 as const,
        credentials: [
          {
            name: "openai",
            kind: "pi-auth" as const,
            scope: "global" as const,
            providers: {
              openai: { type: "api_key" as const, key: providerSecret },
            },
          },
        ],
      };
      const first = yield* useStore(storage, (store) => store.sync(input));
      const second = yield* useStore(storage, (store) => store.sync(input));
      assert.deepStrictEqual(first.credentials, [
        { name: "openai", kind: "pi-auth", scope: "global", configured: true },
      ]);
      assert.deepStrictEqual(second, first);
      const authority = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()));
      assert.strictEqual(authority.versions.length, 1);
      assert.notInclude(JSON.stringify(storage.snapshot()), providerSecret);
    }),
  );

  it.effect("resolves the selected GitHub version transiently for repository verification", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      yield* useStore(storage, (store) =>
        store.sync({
          version: 1,
          credentials: [
            { name: "global", kind: "github-cli", scope: "global", token: "global-token" },
            {
              name: "exact",
              kind: "github-cli",
              scope: "repository",
              repositories: ["owner/repo"],
              token: "exact-token",
            },
          ],
        }),
      );
      const resolved = yield* useStore(storage, (store) =>
        store.resolveGithubCliCredential({ version: 1, repository: "owner/repo" }),
      );
      assert.strictEqual(Redacted.value(resolved), "exact-token");
      Redacted.wipeUnsafe(resolved);
      assert.notInclude(JSON.stringify(storage.snapshot()), "exact-token");
    }),
  );

  it.effect("issues exactly one deterministic GitHub grant from the desired set", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      yield* useStore(storage, (store) =>
        store.sync({
          version: 1,
          credentials: [
            { name: "github", kind: "github-cli", scope: "global", token: "global-token" },
            {
              name: "repo-github",
              kind: "github-cli",
              scope: "repository",
              repositories: ["owner/repo"],
              token: "repo-token",
            },
          ],
        }),
      );
      const global = yield* useStore(storage, (store) =>
        store.issueGrants({ version: 1, sessionId: "d0e1f2a3b4c5" }),
      );
      assert.deepStrictEqual(
        global.grants.map(({ name }) => name),
        ["github"],
      );
      const repository = yield* useStore(storage, (store) =>
        store.issueGrants({ version: 1, sessionId: "e0f1a2b3c4d5", repository: "owner/repo" }),
      );
      assert.deepStrictEqual(
        repository.grants.map(({ name }) => name),
        ["repo-github"],
      );
    }),
  );

  it.effect("fails closed when multiple Pi credentials are applicable", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      yield* useStore(storage, (store) =>
        store.sync({
          version: 1,
          credentials: [
            {
              name: "openai",
              kind: "pi-auth" as const,
              scope: "global" as const,
              providers: { openai: { type: "api_key" as const, key: `${BASE}-one` } },
            },
            {
              name: "alternate",
              kind: "pi-auth" as const,
              scope: "global" as const,
              providers: { openai: { type: "api_key" as const, key: `${BASE}-two` } },
            },
          ],
        }),
      );
      const issued = yield* Effect.result(
        useStore(storage, (store) => store.issueGrants({ version: 1, sessionId: SESSION })),
      );
      assert.deepInclude(failure(issued), { reason: "credential_ambiguous" });
      const authority = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()));
      assert.deepStrictEqual(authority.grants, []);
      assert.deepStrictEqual(authority.issuedSessions, []);
    }),
  );

  it.effect("fails closed when GitHub grant selection is missing or ambiguous", () =>
    Effect.gen(function* () {
      const issue = (storage: CredentialRegistryStorage, sessionId: string) =>
        useStore(storage, (store) =>
          store.issueGrants({ version: 1, sessionId, repository: "owner/repo" }),
        );
      const sync = (
        storage: CredentialRegistryStorage,
        credentials: ReadonlyArray<CredentialRegistrySyncMaterial>,
      ) => useStore(storage, (store) => store.sync({ version: 1, credentials }));
      const exact: CredentialRegistrySyncMaterial = {
        name: "exact",
        kind: "github-cli" as const,
        scope: "repository" as const,
        repositories: ["owner/repo"],
        token: "exact-token",
      };
      const global = (name: string) => ({
        name,
        kind: "github-cli" as const,
        scope: "global" as const,
        token: `${name}-token`,
      });

      const multipleExact = memoryStorage();
      yield* sync(multipleExact, [exact, { ...exact, name: "exact-two" }]);
      const exactFailure = yield* Effect.result(issue(multipleExact, "f0e1d2a3b4c5"));
      assert.deepInclude(failure(exactFailure), { reason: "credential_ambiguous" });

      const multipleGlobal = memoryStorage();
      yield* sync(multipleGlobal, [global("global-one"), global("global-two")]);
      const globalFailure = yield* Effect.result(issue(multipleGlobal, "g0e1d2a3b4c5"));
      assert.deepInclude(failure(globalFailure), { reason: "credential_ambiguous" });

      const missing = memoryStorage();
      yield* sync(missing, [{ ...exact, repositories: ["other/repo"] as const }]);
      const missingFailure = yield* Effect.result(issue(missing, "h0e1d2a3b4c5"));
      assert.deepInclude(failure(missingFailure), { reason: "credential_missing" });
    }),
  );

  it.effect("pins an empty grant selection across later syncs", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const empty = yield* useStore(storage, (store) =>
        store.sync({ version: 1, credentials: [] }),
      );
      assert.deepStrictEqual(empty.credentials, []);
      const first = yield* useStore(storage, (store) => store.issueGrants(grantInput));
      assert.deepStrictEqual(first.grants, []);
      yield* useStore(storage, (store) =>
        store.sync(desiredPiInput({ openai: { type: "api_key", key: `${BASE}-a` } })),
      );
      const replay = yield* useStore(storage, (store) => store.issueGrants(grantInput));
      assert.deepStrictEqual(replay.grants, []);
    }),
  );

  it.effect("serializes pinned OAuth rotation and commits only with the matching lease", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-04-05T06:07:08.000Z"));
      const storage = memoryStorage();
      yield* useStore(storage, (store) =>
        store.sync(
          desiredPiInput({
            "openai-codex": {
              type: "oauth",
              access: `${BASE}-access`,
              refresh: `${BASE}-refresh`,
              expires: 1,
            },
          }),
        ),
      );
      const oauthVersionRef = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()))
        .credentials[0]?.currentVersionRef;
      assert.isString(oauthVersionRef);
      yield* useStore(storage, (store) => store.issueGrants(grantInput));
      const lease = yield* useStore(storage, (store) =>
        store.beginRefresh({
          version: 1,
          sessionId: SESSION,
          name: "openai",
          versionRef: oauthVersionRef,
          nonce: "nonce-a",
        }),
      );
      assert.strictEqual(lease?.nonce, "nonce-a");
      const busy = yield* useStore(storage, (store) =>
        store.beginRefresh({
          version: 1,
          sessionId: SESSION,
          name: "openai",
          versionRef: oauthVersionRef,
          nonce: "nonce-b",
        }),
      );
      assert.isNull(busy);
      yield* useStore(storage, (store) =>
        store.persistRotation({
          version: 1,
          sessionId: SESSION,
          name: "openai",
          versionRef: oauthVersionRef,
          nonce: "nonce-a",
          patch: { accessToken: "rotated-access", expiresInSeconds: 3600 },
        }),
      );
      const rotated = yield* useStore(storage, (store) =>
        store.resolve({
          ...grantInput,
          name: "openai",
          kind: "pi-auth",
          versionRef: oauthVersionRef,
          handle: PI_HANDLE,
        }),
      );
      assert.include(Redacted.value(rotated), "rotated-access");
      assert.notInclude(JSON.stringify(storage.snapshot()), "rotated-access");
      const stale = yield* Effect.result(
        useStore(storage, (store) =>
          store.persistRotation({
            version: 1,
            sessionId: SESSION,
            name: "openai",
            versionRef: oauthVersionRef,
            nonce: "nonce-a",
            patch: { accessToken: "must-not-commit" },
          }),
        ),
      );
      assert.deepInclude(failure(stale), { reason: "rotation_mismatch" });
    }),
  );
  it.effect("does not publish completion metadata when the commit put fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-04-05T06:07:08.000Z"));
      const storage = memoryStorage();
      const versionRef = yield* prepareOAuth(storage);
      yield* useStore(storage, (store) =>
        store.beginRefresh(refreshInput(versionRef, "nonce-pre")),
      );
      storage.failNextPut();

      const failed = yield* Effect.result(
        useStore(storage, (store) =>
          store.persistRotation(persistInput(versionRef, "nonce-pre", "pre-commit-access")),
        ),
      );
      assert.deepInclude(failure(failed), { reason: "storage" });
      const authority = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()));
      assert.strictEqual(
        authority.versions.find((version) => version.versionRef === versionRef)?.refreshLease
          ?.nonce,
        "nonce-pre",
      );
      assert.deepStrictEqual(authority.rotationCompletions, []);

      yield* useStore(storage, (store) =>
        store.persistRotation(persistInput(versionRef, "nonce-pre", "pre-commit-access")),
      );
      assert.strictEqual(
        success(decodeCredentialRegistryAuthorityResult(storage.snapshot())).rotationCompletions
          ?.length,
        1,
      );
    }),
  );

  it.effect("replays a committed rotation after its persistence response is lost", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-04-05T06:07:08.000Z"));
      const storage = memoryStorage();
      const versionRef = yield* prepareOAuth(storage);
      const input = persistInput(versionRef, "nonce-lost", "response-loss-access");
      yield* useStore(storage, (store) =>
        store.beginRefresh(refreshInput(versionRef, input.nonce)),
      );
      storage.loseNextCommitResponse();

      const lost = yield* Effect.result(useStore(storage, (store) => store.persistRotation(input)));
      assert.deepInclude(failure(lost), { reason: "storage" });
      const committed = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()));
      assert.strictEqual(
        committed.versions.find((version) => version.versionRef === versionRef)?.refreshLease,
        undefined,
      );
      assert.strictEqual(committed.rotationCompletions?.length, 1);
      assert.notInclude(JSON.stringify(storage.snapshot()), "response-loss-access");
      assert.notInclude(JSON.stringify(storage.snapshot()), input.nonce);

      yield* useStore(storage, (store) => store.sync({ version: 1, credentials: [] }));
      assert.strictEqual(
        success(decodeCredentialRegistryAuthorityResult(storage.snapshot())).rotationCompletions
          ?.length,
        1,
      );

      const replayed = yield* Effect.result(
        useStore(storage, (store) => store.persistRotation(input)),
      );
      assert.isTrue(Result.isSuccess(replayed));
      const mismatched = yield* Effect.result(
        useStore(storage, (store) =>
          store.persistRotation(persistInput(versionRef, input.nonce, "different-access")),
        ),
      );
      assert.deepInclude(failure(mismatched), { reason: "rotation_mismatch" });

      yield* useStore(storage, (store) =>
        store.cancelRefresh(refreshInput(versionRef, input.nonce)),
      );
      const resolved = yield* useStore(storage, (store) =>
        store.resolve({
          ...grantInput,
          name: "openai",
          kind: "pi-auth",
          versionRef,
          handle: PI_HANDLE,
        }),
      );
      assert.include(Redacted.value(resolved), "response-loss-access");
    }),
  );

  it.effect("garbage-collects stale rotation completion metadata with released grants", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-04-05T06:07:08.000Z"));
      const storage = memoryStorage();
      const versionRef = yield* prepareOAuth(storage);
      yield* useStore(storage, (store) => store.beginRefresh(refreshInput(versionRef, "nonce-gc")));
      yield* useStore(storage, (store) =>
        store.persistRotation(persistInput(versionRef, "nonce-gc", "gc-access")),
      );
      yield* useStore(storage, (store) => store.release({ version: 1, sessionId: SESSION }));
      const released = success(decodeCredentialRegistryAuthorityResult(storage.snapshot()));
      assert.deepStrictEqual(released.rotationCompletions, []);

      yield* useStore(storage, (store) => store.issueGrants(grantInput));
      const stale = yield* Effect.result(
        useStore(storage, (store) =>
          store.persistRotation(persistInput(versionRef, "nonce-gc", "gc-access")),
        ),
      );
      assert.deepInclude(failure(stale), { reason: "rotation_mismatch" });
      const resolved = yield* useStore(storage, (store) =>
        store.resolve({
          ...grantInput,
          name: "openai",
          kind: "pi-auth",
          versionRef,
          handle: PI_HANDLE,
        }),
      );
      assert.include(Redacted.value(resolved), "gc-access");
    }),
  );

  it.effect(
    "keeps concurrent refreshes fenced and does not let a replay overwrite newer state",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-04-05T06:07:08.000Z"));
        const storage = memoryStorage();
        const versionRef = yield* prepareOAuth(storage);
        yield* useStore(storage, (store) =>
          store.beginRefresh(refreshInput(versionRef, "nonce-one")),
        );
        assert.isNull(
          yield* useStore(storage, (store) =>
            store.beginRefresh(refreshInput(versionRef, "nonce-two")),
          ),
        );
        const rejected = yield* Effect.result(
          useStore(storage, (store) =>
            store.persistRotation(persistInput(versionRef, "nonce-two", "must-not-commit")),
          ),
        );
        assert.deepInclude(failure(rejected), { reason: "rotation_mismatch" });
        yield* useStore(storage, (store) =>
          store.persistRotation(persistInput(versionRef, "nonce-one", "first-access")),
        );
        assert.isNull(
          yield* useStore(storage, (store) =>
            store.beginRefresh(refreshInput(versionRef, "nonce-one")),
          ),
        );
        yield* useStore(storage, (store) =>
          store.beginRefresh(refreshInput(versionRef, "nonce-two")),
        );
        yield* useStore(storage, (store) =>
          store.persistRotation(persistInput(versionRef, "nonce-two", "second-access")),
        );
        yield* useStore(storage, (store) =>
          store.persistRotation(persistInput(versionRef, "nonce-one", "first-access")),
        );
        const resolved = yield* useStore(storage, (store) =>
          store.resolve({
            ...grantInput,
            name: "openai",
            kind: "pi-auth",
            versionRef,
            handle: PI_HANDLE,
          }),
        );
        assert.include(Redacted.value(resolved), "second-access");
        assert.notInclude(Redacted.value(resolved), "must-not-commit");
      }),
  );
});
