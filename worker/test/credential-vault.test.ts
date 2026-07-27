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
const CODEX_SENTINEL = "scotty-codex-session-sentinel";
const GITHUB_SENTINEL = "scotty-github-session-sentinel";
const PICAN_PROXY_TOKEN = "scotty-pican-proxy-token";
const CODEX_SEED = JSON.stringify({
  tokens: {
    id_token: "seed-id-token",
    access_token: "seed-access-token",
    refresh_token: "seed-refresh-token",
    account_id: "seed-account-id",
  },
});
const SEED = {
  codexAuthJson: CODEX_SEED,
  codexSentinel: CODEX_SENTINEL,
  githubSentinel: GITHUB_SENTINEL,
  picanProxyToken: PICAN_PROXY_TOKEN,
};

const credential = (overrides: Partial<StoredCredential> = {}): StoredCredential => ({
  codex: {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "stored-id-token",
      access_token: "stored-access-token",
      refresh_token: "stored-refresh-token",
      account_id: "stored-account-id",
    },
    account_id: null,
    last_refresh: "2026-01-02T00:00:00.000Z",
  },
  githubToken: "stored-github-token",
  codexSentinel: CODEX_SENTINEL,
  githubSentinel: GITHUB_SENTINEL,
  picanProxyToken: PICAN_PROXY_TOKEN,
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
        codexSentinel: CODEX_SENTINEL,
        githubSentinel: GITHUB_SENTINEL,
        picanProxyToken: PICAN_PROXY_TOKEN,
        updatedAt: "2026-04-05T06:07:08.000Z",
      });
      assert.strictEqual(seeded.codex.tokens?.access_token, "seed-access-token");
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
                codexAuthJson: JSON.stringify({ OPENAI_API_KEY: "codex-token-a" }),
                codexSentinel: `${CODEX_SENTINEL}-a`,
                githubSentinel: `${GITHUB_SENTINEL}-a`,
                picanProxyToken: `${PICAN_PROXY_TOKEN}-a`,
              }),
            ),
          ),
          withVault(
            storage,
            "github-token-b",
            vaultEffect((vault) =>
              vault.seed({
                ...SEED,
                codexAuthJson: JSON.stringify({ OPENAI_API_KEY: "codex-token-b" }),
                codexSentinel: `${CODEX_SENTINEL}-b`,
                githubSentinel: `${GITHUB_SENTINEL}-b`,
                picanProxyToken: `${PICAN_PROXY_TOKEN}-b`,
              }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(results[0], results[1]);
      assert.deepStrictEqual(storage.snapshot(), results[0]);
      const authorityTuple = [
        results[0].codex.OPENAI_API_KEY,
        results[0].githubToken,
        results[0].codexSentinel,
        results[0].githubSentinel,
        results[0].picanProxyToken,
      ].join("|");
      assert.ok(
        [
          `codex-token-a|github-token-a|${CODEX_SENTINEL}-a|${GITHUB_SENTINEL}-a|${PICAN_PROXY_TOKEN}-a`,
          `codex-token-b|github-token-b|${CODEX_SENTINEL}-b|${GITHUB_SENTINEL}-b|${PICAN_PROXY_TOKEN}-b`,
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
        vaultEffect((vault) => vault.seed({ codexAuthJson: undefined })),
      );
      assert.deepStrictEqual(result, existing);
      assert.deepStrictEqual(storage.snapshot(), existing);
    }),
  );

  it.effect("fails closed for malformed present authority without reseeding", () =>
    Effect.gen(function* () {
      const honeypot = "honeypot-malformed-github-secret";
      const { githubToken: _githubToken, ...missingGithubToken } = credential();
      const { picanProxyToken: _picanProxyToken, ...missingPicanProxyToken } = credential();
      for (const malformed of [
        { ...credential(), githubToken: "" },
        missingGithubToken,
        missingPicanProxyToken,
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
      const missingCodex = yield* Effect.result(
        withVault(
          makeCredentialVaultStorageFake(),
          "github-seed",
          vaultEffect((vault) => vault.seed({ ...SEED, codexAuthJson: "" })),
        ),
      );
      assert.deepInclude(failure(missingCodex), {
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

      const missingPicanProxyToken = yield* Effect.result(
        withVault(
          makeCredentialVaultStorageFake(),
          "github-seed",
          vaultEffect((vault) => vault.seed({ ...SEED, picanProxyToken: "" })),
        ),
      );
      assert.deepInclude(failure(missingPicanProxyToken), {
        reason: "invalid_seed",
        message: "Credential seed is missing or invalid",
      });
    }),
  );

  it.effect("looks up only exact Codex and GitHub sentinels", () =>
    Effect.gen(function* () {
      const stored = credential();
      const storage = makeCredentialVaultStorageFake(stored);
      for (const sentinel of [CODEX_SENTINEL, GITHUB_SENTINEL]) {
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
          vaultEffect((vault) => vault.readForProxy(`${CODEX_SENTINEL}-wrong`)),
        ),
        null,
      );
      assert.strictEqual(
        yield* withVault(
          storage,
          "ignored",
          vaultEffect((vault) => vault.readForProxy(PICAN_PROXY_TOKEN)),
        ),
        null,
      );
      assert.notStrictEqual(stored.codex.tokens?.access_token, stored.githubToken);
    }),
  );

  it.effect("keeps refresh busy until the exact 60-second TestClock threshold", () =>
    Effect.gen(function* () {
      const storage = makeCredentialVaultStorageFake(credential());
      yield* TestClock.setTime(NOW);
      const first = yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.beginRefresh(CODEX_SENTINEL, "nonce-1")),
      );
      assert.strictEqual(first?.nonce, "nonce-1");
      assert.strictEqual(first?.credential.refreshLease?.startedAt, "2026-04-05T06:07:08.000Z");

      yield* TestClock.adjust(59_999);
      assert.strictEqual(
        yield* withVault(
          storage,
          "ignored",
          vaultEffect((vault) => vault.beginRefresh(CODEX_SENTINEL, "nonce-2")),
        ),
        null,
      );
      yield* TestClock.adjust(1);
      const expired = yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.beginRefresh(CODEX_SENTINEL, "nonce-3")),
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
        vaultEffect((vault) => vault.beginRefresh(CODEX_SENTINEL, "held-nonce")),
      );
      const stale = yield* Effect.result(
        withVault(
          storage,
          "ignored",
          vaultEffect((vault) =>
            vault.persistRotation(
              CODEX_SENTINEL,
              { accessToken: "must-not-persist" },
              "stale-nonce",
            ),
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
            vault.persistRotation(CODEX_SENTINEL, { accessToken: "must-not-persist" }, ""),
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
            CODEX_SENTINEL,
            { accessToken: "rotated-access-token", ignored: "strip-me" },
            "held-nonce",
          ),
        ),
      );
      const read = yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.readForProxy(CODEX_SENTINEL)),
      );
      assert.strictEqual(read?.codex.tokens?.access_token, "rotated-access-token");
      assert.strictEqual(read?.codex.tokens?.id_token, "stored-id-token");
      assert.strictEqual(read?.codex.tokens?.refresh_token, "stored-refresh-token");
      assert.strictEqual(read?.githubToken, "stored-github-token");
      assert.strictEqual(read?.codexSentinel, CODEX_SENTINEL);
      assert.strictEqual(read?.githubSentinel, GITHUB_SENTINEL);
      assert.strictEqual(read?.picanProxyToken, PICAN_PROXY_TOKEN);
      assert.ok(!("ignored" in (read ?? {})));
      assert.strictEqual(read?.refreshLease, undefined);
      assert.strictEqual(read?.updatedAt, "2026-04-05T06:07:09.000Z");
      assert.strictEqual(read?.codex.last_refresh, "2026-04-05T06:07:09.000Z");
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
        vaultEffect((vault) => vault.cancelRefresh(CODEX_SENTINEL, "stale")),
      );
      assert.strictEqual((storage.snapshot() as StoredCredential).refreshLease?.nonce, "held");
      yield* withVault(
        storage,
        "ignored",
        vaultEffect((vault) => vault.cancelRefresh(CODEX_SENTINEL, "held")),
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
