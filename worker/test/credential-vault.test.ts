import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { makeInstallationPiAuthRecord } from "../../protocol/pi-auth";
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
const UNKNOWN_SENTINEL = "scotty-pi-unknown-sentinel";
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
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const withVault = <A, E>(
  storage: CredentialVaultStorage,
  githubSeed: unknown,
  effect: Effect.Effect<A, E, CredentialVault>,
): Effect.Effect<A, E> => {
  void githubSeed;
  return Effect.provide(effect, credentialVaultLayer(storage));
};

const vaultEffect = <A, E>(
  use: (vault: CredentialVaultShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E, CredentialVault> => Effect.flatMap(CredentialVault, use);

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("CredentialVault", () => {
  it.effect("seeds provider credentials once with a Clock-owned timestamp", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake();
      yield* TestClock.setTime(NOW);
      const seeded = yield* withVault(
        storage,
        "seed-github-token",
        vaultEffect((vault) => vault.seed(SEED)),
      );
      assert.deepInclude(seeded, {
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

  it.effect("serializes competing first provider seeds into one complete authority tuple", () =>
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
        results[0].providers.openai?.sentinel,
      ].join("|");
      assert.ok(
        ["openai-token-a|scotty-pi-a-0", "openai-token-b|scotty-pi-b-0"].includes(authorityTuple),
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

  it.effect("seeds a new session from the installation record instead of bootstrap JSON", () =>
    Effect.gen(function* () {
      const record = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(
          {
            "openai-codex": {
              type: "oauth",
              access: "installation-access",
              refresh: "installation-refresh",
              expires: 1,
            },
          },
          "2026-04-01T00:00:00.000Z",
          "sync",
        ),
      );
      const seeded = yield* withVault(
        makeCredentialVaultStorageFake(),
        "github-seed",
        vaultEffect((vault) =>
          vault.seed({
            installationRecord: record,
            providerSentinelSeed: "scotty-pi-installation",
          }),
        ),
      );
      assert.strictEqual(seeded.updatedAt, record.updatedAt);
      assert.strictEqual(seeded.providers.openai, undefined);
      assert.deepInclude(seeded.providers["openai-codex"]?.credential, {
        access: "installation-access",
        refresh: "installation-refresh",
      });
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
      assert.strictEqual(reseeded.refreshLease, undefined);
      assert.strictEqual(reseeded.updatedAt, "2026-04-05T06:07:08.000Z");
    }),
  );

  it.effect("reconciles only a strictly newer installation record", () =>
    Effect.gen(function* () {
      const current = credential({ updatedAt: "2026-04-02T00:00:00.000Z" });
      const memory = makeCredentialVaultStorageFake(current);
      const older = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(
          { openai: { type: "api_key", key: "older" } },
          "2026-04-01T00:00:00.000Z",
          "sync",
        ),
      );
      const unchanged = yield* withVault(
        memory,
        "ignored",
        vaultEffect((vault) => vault.reconcile(older, "new-sentinel")),
      );
      assert.deepStrictEqual(unchanged, current);

      const newer = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(
          { openai: { type: "api_key", key: "newer" } },
          "2026-04-03T00:00:00.000Z",
          "sync",
        ),
      );
      const reconciled = yield* withVault(
        memory,
        "ignored",
        vaultEffect((vault) => vault.reconcile(newer, "new-sentinel")),
      );
      assert.strictEqual(reconciled.updatedAt, newer.updatedAt);
      assert.deepInclude(reconciled.providers.openai, {
        credential: { type: "api_key", key: "newer" },
        sentinel: "new-sentinel-0",
      });
      assert.strictEqual(reconciled.refreshLease, undefined);
    }),
  );

  it.effect("treats equal matching freshness as idempotent and rejects equal divergence", () =>
    Effect.gen(function* () {
      const current = credential();
      const currentProviders = Object.fromEntries(
        Object.entries(current.providers).map(([id, provider]) => [id, provider.credential]),
      );
      const same = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(currentProviders, current.updatedAt, "rotation"),
      );
      const memory = makeCredentialVaultStorageFake(current);
      assert.deepStrictEqual(
        yield* withVault(
          memory,
          "ignored",
          vaultEffect((vault) => vault.reconcile(same, "unused")),
        ),
        current,
      );
      const divergent = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(
          { openai: { type: "api_key", key: "different" } },
          current.updatedAt,
          "sync",
        ),
      );
      const result = yield* Effect.result(
        withVault(
          memory,
          "ignored",
          vaultEffect((vault) => vault.reconcile(divergent, "unused")),
        ),
      );
      assert.deepInclude(failure(result), {
        reason: "invalid_authority",
        message: "Credential freshness conflict",
      });
    }),
  );

  it.effect("fails closed for malformed present authority without reseeding", () =>
    Effect.gen(function* () {
      const honeypot = "honeypot-malformed-provider-secret";
      for (const malformed of [
        {
          ...credential(),
          providers: {
            "openai-codex": { ...credential().providers["openai-codex"], sentinel: "" },
          },
        },
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

  it.effect("fails new sessions closed with fixed safe errors for missing provider seeds", () =>
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
    }),
  );

  it.effect("looks up only exact provider sentinels", () =>
    Effect.gen(function* () {
      const stored = credential();
      const storage = makeCredentialVaultStorageFake(stored);
      assert.deepStrictEqual(
        yield* withVault(
          storage,
          "ignored",
          vaultEffect((vault) => vault.readForProxy(PI_SENTINEL)),
        ),
        stored,
      );
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
          vaultEffect((vault) => vault.readForProxy(UNKNOWN_SENTINEL)),
        ),
        null,
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
            {
              accessToken: "rotated-access-token",
              expiresInSeconds: 3600,
              ignored: "strip-me",
            },
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
      assert.strictEqual(
        provider?.credential.type === "oauth" ? provider.credential.expires : undefined,
        NOW + 3_601_000,
      );
      assert.strictEqual(provider?.sentinel, PI_SENTINEL);
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
