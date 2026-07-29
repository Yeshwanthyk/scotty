import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import type { StoredCredential } from "../src/contracts";
import {
  CredentialVault,
  credentialVaultLayer,
  type CredentialVaultShape,
  type CredentialVaultStorage,
} from "../src/credential-vault";
import { InMemoryFaultInjectableFake, makeCredentialVaultStorageFake } from "./support";

const NOW = Date.parse("2026-04-05T06:07:08.000Z");
const PI_SENTINEL = "scotty-pi-session-sentinel-0";
const GITHUB_SENTINEL = "scotty-github-session-sentinel";
const PI_SEED = JSON.stringify({
  "openai-codex": {
    type: "oauth",
    access: "seed-access-token",
    refresh: "seed-refresh-token",
    expires: NOW - 1,
    accountId: "seed-account-id",
  },
});
const SEED = {
  piAuthJson: PI_SEED,
  providerSentinelSeed: "scotty-pi-session-sentinel",
  githubSentinel: GITHUB_SENTINEL,
};

const credential = (overrides: Partial<StoredCredential> = {}): StoredCredential => ({
  providers: {
    "openai-codex": {
      credential: {
        type: "oauth",
        access: "stored-access-token",
        refresh: "stored-refresh-token",
        expires: NOW - 1,
        accountId: "stored-account-id",
        idToken: "stored-id-token",
      },
      sentinel: PI_SENTINEL,
    },
  },
  githubToken: "stored-github-token",
  githubSentinel: GITHUB_SENTINEL,
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const withVault = <A, E>(
  storage: CredentialVaultStorage,
  githubSeed: unknown,
  effect: Effect.Effect<A, E, CredentialVault>,
): Effect.Effect<A, E> => Effect.provide(effect, credentialVaultLayer(storage, githubSeed));

const vaultEffect = <A, E>(
  use: (vault: CredentialVaultShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E, CredentialVault> => Effect.flatMap(CredentialVault, use);

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("CredentialVault", () => {
  it.effect("seeds both credential kinds once with a Clock-owned timestamp", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake();
      yield* TestClock.setTime(NOW);
      const seeded = yield* withVault(
        storage,
        "seed-github-token",
        vaultEffect((vault) => vault.seed(SEED)),
      );
      assert.deepInclude(seeded, {
        githubToken: "seed-github-token",
        githubSentinel: GITHUB_SENTINEL,
        updatedAt: "2026-04-05T06:07:08.000Z",
      });
      assert.deepInclude(seeded.providers["openai-codex"], {
        credential: {
          type: "oauth",
          access: "seed-access-token",
          refresh: "seed-refresh-token",
          expires: NOW - 1,
          accountId: "seed-account-id",
        },
        sentinel: PI_SENTINEL,
      });
      assert.deepStrictEqual(storage.snapshot(), seeded);
    }),
  );

  it.effect("serializes competing first seeds into one complete authority tuple", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake();
      yield* TestClock.setTime(NOW);
      const results = yield* Effect.all(
        [
          withVault(
            storage,
            "github-token-a",
            vaultEffect((vault) =>
              vault.seed({
                ...SEED,
                piAuthJson: JSON.stringify({
                  openai: { type: "api_key", key: "openai-token-a" },
                }),
                providerSentinelSeed: "scotty-pi-a",
                githubSentinel: `${GITHUB_SENTINEL}-a`,
              }),
            ),
          ),
          withVault(
            storage,
            "github-token-b",
            vaultEffect((vault) =>
              vault.seed({
                ...SEED,
                piAuthJson: JSON.stringify({
                  openai: { type: "api_key", key: "openai-token-b" },
                }),
                providerSentinelSeed: "scotty-pi-b",
                githubSentinel: `${GITHUB_SENTINEL}-b`,
              }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(results[0], results[1]);
      assert.deepStrictEqual(storage.snapshot(), results[0]);
      const authorityTuple = [
        results[0].providers.openai?.credential.type === "api_key"
          ? results[0].providers.openai.credential.key
          : undefined,
        results[0].githubToken,
        results[0].providers.openai?.sentinel,
        results[0].githubSentinel,
      ].join("|");
      assert.ok(
        [
          `openai-token-a|github-token-a|scotty-pi-a-0|${GITHUB_SENTINEL}-a`,
          `openai-token-b|github-token-b|scotty-pi-b-0|${GITHUB_SENTINEL}-b`,
        ].includes(authorityTuple),
      );
    }),
  );

  it.effect("keeps existing authority despite changed or missing environment seeds", () =>
    Effect.gen(function* () {
      const existing = credential({
        refreshLease: { nonce: "held", startedAt: "2026-01-02T00:00:01.000Z" },
      });
      const storage = makeCredentialVaultStorageFake(existing);
      const result = yield* withVault(
        storage,
        undefined,
        vaultEffect((vault) => vault.seed({ piAuthJson: undefined })),
      );
      assert.deepStrictEqual(result, existing);
      assert.deepStrictEqual(storage.snapshot(), existing);
    }),
  );

  it.effect("explicitly reseeds the provider map while preserving session sentinels", () =>
    Effect.gen(function* () {
      const existing = credential({
        refreshLease: { nonce: "abandoned", startedAt: "2026-01-02T00:00:01.000Z" },
      });
      const storage = makeCredentialVaultStorageFake(existing);
      yield* TestClock.setTime(NOW);
      const reseeded = yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) =>
          vault.reseed({
            piAuthJson: JSON.stringify({
              "openai-codex": {
                type: "oauth",
                access: "replacement-access",
                refresh: "replacement-refresh",
                expires: 0,
                accountId: "replacement-account",
              },
              anthropic: {
                type: "oauth",
                access: "anthropic-access",
                refresh: "anthropic-refresh",
                expires: 0,
              },
            }),
            providerSentinelSeed: "scotty-pi-reseed",
          }),
        ),
      );
      assert.strictEqual(reseeded.providers["openai-codex"]?.sentinel, PI_SENTINEL);
      assert.strictEqual(reseeded.providers.anthropic?.sentinel, "scotty-pi-reseed-1");
      assert.deepInclude(reseeded.providers["openai-codex"]?.credential, {
        type: "oauth",
        access: "replacement-access",
        refresh: "replacement-refresh",
      });
      assert.strictEqual(reseeded.githubToken, existing.githubToken);
      assert.strictEqual(reseeded.githubSentinel, existing.githubSentinel);
      assert.strictEqual(reseeded.refreshLease, undefined);
      assert.strictEqual(reseeded.updatedAt, "2026-04-05T06:07:08.000Z");
    }),
  );

  it.effect("fails closed for malformed present authority without reseeding", () =>
    Effect.gen(function* () {
      const honeypot = "honeypot-malformed-github-secret";
      const { githubToken: _githubToken, ...missingGithubToken } = credential();
      for (const malformed of [
        { ...credential(), githubToken: "" },
        missingGithubToken,
        { ...credential(), unexpected: honeypot },
        { ...credential(), updatedAt: "not-a-timestamp" },
        {
          ...credential(),
          refreshLease: { nonce: "held", startedAt: "not-a-timestamp" },
        },
      ]) {
        const storage = makeCredentialVaultStorageFake(malformed);
        const result = yield* Effect.result(
          withVault(
            storage,
            "replacement-github-token",
            vaultEffect((vault) => vault.seed(SEED)),
          ),
        );
        const error = failure(result);
        assert.deepInclude(error, {
          reason: "invalid_authority",
          message: "Stored credential record is invalid",
        });
        assert.ok(!JSON.stringify(error).includes(honeypot));
        assert.deepStrictEqual(storage.snapshot(), malformed);
      }
    }),
  );

  it.effect("fails new sessions closed with fixed safe errors for missing seeds", () =>
    Effect.gen(function* () {
      const missingPi = yield* Effect.result(
        withVault(
          makeCredentialVaultStorageFake(),
          "github-seed",
          vaultEffect((vault) => vault.seed({ ...SEED, piAuthJson: "" })),
        ),
      );
      assert.deepInclude(failure(missingPi), {
        reason: "invalid_seed",
        message: "Credential seed is missing or invalid",
      });

      const missingGithub = yield* Effect.result(
        withVault(
          makeCredentialVaultStorageFake(),
          undefined,
          vaultEffect((vault) => vault.seed(SEED)),
        ),
      );
      assert.deepInclude(failure(missingGithub), {
        reason: "invalid_seed",
        message: "GH_TOKEN is missing or invalid",
      });
    }),
  );

  it.effect("looks up only exact Pi and GitHub sentinels", () =>
    Effect.gen(function* () {
      const stored = credential();
      const storage = makeCredentialVaultStorageFake(stored);
      for (const sentinel of [PI_SENTINEL, GITHUB_SENTINEL]) {
        assert.deepStrictEqual(
          yield* withVault(
            storage,
            "ignored",
            vaultEffect((vault) => vault.readForProxy(sentinel)),
          ),
          stored,
        );
      }
      assert.strictEqual(
        yield* withVault(
          storage,
          "ignored",
          vaultEffect((vault) => vault.readForProxy(`${PI_SENTINEL}-wrong`)),
        ),
        null,
      );
      assert.strictEqual(
        yield* withVault(
          storage,
          "ignored",
          vaultEffect((vault) => vault.readForProxy("unknown-sentinel")),
        ),
        null,
      );
      assert.notStrictEqual(
        stored.providers["openai-codex"]?.credential.type === "oauth"
          ? stored.providers["openai-codex"].credential.access
          : undefined,
        stored.githubToken,
      );
    }),
  );

  it.effect("keeps refresh busy until the exact 60-second TestClock threshold", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake(credential());
      yield* TestClock.setTime(NOW);
      const first = yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.beginRefresh(PI_SENTINEL, "nonce-1")),
      );
      assert.strictEqual(first?.nonce, "nonce-1");
      assert.strictEqual(first?.credential.refreshLease?.startedAt, "2026-04-05T06:07:08.000Z");

      yield* TestClock.adjust(59_999);
      assert.strictEqual(
        yield* withVault(
          storage,
          "ignored",
          vaultEffect((vault) => vault.beginRefresh(PI_SENTINEL, "nonce-2")),
        ),
        null,
      );
      yield* TestClock.adjust(1);
      const expired = yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.beginRefresh(PI_SENTINEL, "nonce-3")),
      );
      assert.strictEqual(expired?.nonce, "nonce-3");
    }),
  );

  it.effect("rejects stale rotation nonces and persists rotation before later reads", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake(credential());
      yield* TestClock.setTime(NOW);
      yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.beginRefresh(PI_SENTINEL, "held-nonce")),
      );
      const stale = yield* Effect.result(
        withVault(
          storage,
          "ignored",
          vaultEffect((vault) =>
            vault.persistRotation(PI_SENTINEL, { accessToken: "must-not-persist" }, "stale-nonce"),
          ),
        ),
      );
      assert.deepInclude(failure(stale), {
        reason: "lease_mismatch",
        message: "Credential refresh lease mismatch",
      });
      const malformedNonce = yield* Effect.result(
        withVault(
          storage,
          "ignored",
          vaultEffect((vault) =>
            vault.persistRotation(PI_SENTINEL, { accessToken: "must-not-persist" }, ""),
          ),
        ),
      );
      assert.deepInclude(failure(malformedNonce), {
        reason: "lease_mismatch",
        message: "Credential refresh lease mismatch",
      });

      yield* TestClock.adjust(1_000);
      yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) =>
          vault.persistRotation(
            PI_SENTINEL,
            { accessToken: "rotated-access-token", ignored: "strip-me" },
            "held-nonce",
          ),
        ),
      );
      const read = yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.readForProxy(PI_SENTINEL)),
      );
      const provider = read?.providers["openai-codex"];
      assert.strictEqual(
        provider?.credential.type === "oauth" ? provider.credential.access : undefined,
        "rotated-access-token",
      );
      assert.strictEqual(
        provider?.credential.type === "oauth" ? provider.credential.idToken : undefined,
        "stored-id-token",
      );
      assert.strictEqual(
        provider?.credential.type === "oauth" ? provider.credential.refresh : undefined,
        "stored-refresh-token",
      );
      assert.strictEqual(read?.githubToken, "stored-github-token");
      assert.strictEqual(provider?.sentinel, PI_SENTINEL);
      assert.strictEqual(read?.githubSentinel, GITHUB_SENTINEL);
      assert.ok(!("ignored" in (read ?? {})));
      assert.strictEqual(read?.refreshLease, undefined);
      assert.strictEqual(read?.updatedAt, "2026-04-05T06:07:09.000Z");
    }),
  );

  it.effect("cancels only the matching refresh lease", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake(
        credential({
          refreshLease: { nonce: "held", startedAt: "2026-01-02T00:00:01.000Z" },
        }),
      );
      yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.cancelRefresh(PI_SENTINEL, "stale")),
      );
      assert.strictEqual((storage.snapshot() as StoredCredential).refreshLease?.nonce, "held");
      yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.cancelRefresh(PI_SENTINEL, "held")),
      );
      assert.strictEqual((storage.snapshot() as StoredCredential).refreshLease, undefined);
    }),
  );

  it.effect("deletes authority transactionally and remains deleted after reconstruction", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake(credential());
      yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.delete),
      );
      assert.strictEqual(storage.snapshot(), undefined);
      const reconstructed = yield* Effect.result(
        withVault(
          storage,
          "ignored",
          vaultEffect((vault) => vault.require),
        ),
      );
      assert.deepInclude(failure(reconstructed), {
        reason: "missing",
        message: "Session credential bundle is missing",
      });
    }),
  );

  it.effect("redacts storage failures and credential honeypots", () =>
    Effect.gen(function* () {
      const honeypot = "honeypot-provider-credential";
      const memory = new InMemoryFaultInjectableFake();
      memory.injectFailure("transaction", { error: honeypot });
      const storage = makeCredentialVaultStorageFake(undefined, memory);
      const result = yield* Effect.result(
        withVault(
          storage,
          honeypot,
          vaultEffect((vault) => vault.require),
        ),
      );
      const error = failure(result);
      assert.deepInclude(error, {
        reason: "storage",
        message: "Credential storage operation failed",
      });
      assert.ok(!JSON.stringify(error).includes(honeypot));
    }),
  );
});
