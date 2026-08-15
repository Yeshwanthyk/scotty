import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  digestPiAuthProviders,
  makeInstallationPiAuthRecord,
  serializePiAuthProviders,
  type InstallationPiAuthRecord,
} from "../../protocol/pi-auth";
import {
  InstallationPiAuthStore,
  installationPiAuthStoreLayer,
  type InstallationPiAuthStorage,
} from "../src/installation-pi-auth-store";

const providers = {
  "openai-codex": {
    type: "oauth" as const,
    access: "access",
    refresh: "refresh",
    expires: 1,
    accountId: "account",
  },
  openai: { type: "api_key" as const, key: "key" },
};

const storage = (initial?: InstallationPiAuthRecord) => {
  let value: unknown = initial;
  let puts = 0;
  const adapter: InstallationPiAuthStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => value,
        put: async (record) => {
          value = structuredClone(record);
          puts += 1;
        },
      }),
  };
  return { adapter, snapshot: () => value, puts: () => puts };
};

const write = (adapter: InstallationPiAuthStorage, record: InstallationPiAuthRecord) =>
  Effect.flatMap(InstallationPiAuthStore, (store) => store.write(record)).pipe(
    Effect.provide(installationPiAuthStoreLayer(adapter)),
  );

const read = (adapter: InstallationPiAuthStorage) =>
  Effect.flatMap(InstallationPiAuthStore, (store) => store.read).pipe(
    Effect.provide(installationPiAuthStoreLayer(adapter)),
  );

describe("installation Pi auth authority", () => {
  it.effect("uses stable provider serialization and digest regardless of input key order", () =>
    Effect.gen(function* () {
      const extended = {
        ...providers,
        "openai-codex": {
          ...providers["openai-codex"],
          oauthExtension: { z: 1, a: { second: true, first: false } },
        },
      };
      const reversed = {
        openai: providers.openai,
        "openai-codex": {
          oauthExtension: { a: { first: false, second: true }, z: 1 },
          ...providers["openai-codex"],
        },
      };
      assert.strictEqual(serializePiAuthProviders(extended), serializePiAuthProviders(reversed));
      assert.match(serializePiAuthProviders(extended), /oauthExtension/u);
      assert.strictEqual(
        yield* Effect.promise(() => digestPiAuthProviders(extended)),
        yield* Effect.promise(() => digestPiAuthProviders(reversed)),
      );
    }),
  );

  it.effect("accepts first and newer writes and makes an equal digest idempotent", () =>
    Effect.gen(function* () {
      const memory = storage();
      const first = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(providers, "2026-08-15T12:00:00.000Z", "sync"),
      );
      const newer = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(providers, "2026-08-15T12:00:01.000Z", "rotation"),
      );
      yield* write(memory.adapter, first);
      yield* write(memory.adapter, first);
      yield* write(memory.adapter, newer);
      assert.strictEqual(memory.puts(), 2);
      assert.deepStrictEqual(memory.snapshot(), newer);
    }),
  );

  it.effect("rejects older writes and equal-timestamp digest conflicts", () =>
    Effect.gen(function* () {
      const current = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(providers, "2026-08-15T12:00:01.000Z", "rotation"),
      );
      const older = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(providers, "2026-08-15T12:00:00.000Z", "sync"),
      );
      const conflict = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(
          { openai: { type: "api_key", key: "different" } },
          current.updatedAt,
          "sync",
        ),
      );
      const memory = storage(current);
      const staleResult = yield* Effect.result(write(memory.adapter, older));
      const conflictResult = yield* Effect.result(write(memory.adapter, conflict));
      assert.ok(Result.isFailure(staleResult));
      assert.strictEqual(staleResult.failure.reason, "stale");
      assert.ok(Result.isFailure(conflictResult));
      assert.strictEqual(conflictResult.failure.reason, "conflict");
      assert.strictEqual(memory.puts(), 0);
    }),
  );

  it.effect("fails closed for a well-shaped stored record with a false digest", () =>
    Effect.gen(function* () {
      const record = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(providers, "2026-08-15T12:00:00.000Z", "sync"),
      );
      const result = yield* Effect.result(
        read(storage({ ...record, digest: "0".repeat(64) }).adapter),
      );
      assert.ok(Result.isFailure(result));
      assert.strictEqual(result.failure.reason, "invalid_authority");
    }),
  );

  it.effect("rejects a well-shaped write with a false digest", () =>
    Effect.gen(function* () {
      const record = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(providers, "2026-08-15T12:00:00.000Z", "sync"),
      );
      const result = yield* Effect.result(
        write(storage().adapter, { ...record, digest: "0".repeat(64) }),
      );
      assert.ok(Result.isFailure(result));
      assert.strictEqual(result.failure.reason, "invalid_input");
    }),
  );

  it.effect("rejects calendar-invalid timestamps on read and write without mutation", () =>
    Effect.gen(function* () {
      const record = yield* Effect.promise(() =>
        makeInstallationPiAuthRecord(providers, "2026-08-15T12:00:00.000Z", "sync"),
      );
      const invalid = { ...record, updatedAt: "2026-02-31T12:00:00.000Z" };
      const storedResult = yield* Effect.result(read(storage(invalid).adapter));
      assert.ok(Result.isFailure(storedResult));
      assert.strictEqual(storedResult.failure.reason, "invalid_authority");

      const memory = storage();
      const writeResult = yield* Effect.result(write(memory.adapter, invalid));
      assert.ok(Result.isFailure(writeResult));
      assert.strictEqual(writeResult.failure.reason, "invalid_input");
      assert.strictEqual(memory.puts(), 0);
    }),
  );
});
