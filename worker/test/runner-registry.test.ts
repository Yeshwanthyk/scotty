import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  type RunnerAuthority,
  type RunnerAuthorityStorage,
  RunnerRegistry,
  runnerRegistryLayer,
} from "../src/runner-registry";

const NOW = Date.parse("2026-07-29T16:00:00.000Z");
const FIRST_CREDENTIAL = `scotty_runner_${"a".repeat(43)}`;
const SECOND_CREDENTIAL = `scotty_runner_${"b".repeat(43)}`;

const makeStorage = (initial?: unknown) => {
  let authority = initial;
  const storage: RunnerAuthorityStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => authority,
        put: async (next) => {
          authority = next;
        },
      }),
  };
  return {
    layer: runnerRegistryLayer(storage),
    snapshot: () => authority,
  };
};

describe("runner registry", () => {
  it.effect("registers, lists, and authenticates a runner without storing its credential", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = makeStorage();
      const issued = yield* Effect.flatMap(RunnerRegistry, (registry) =>
        registry.register({
          name: "garage",
          credential: FIRST_CREDENTIAL,
          replace: false,
        }),
      ).pipe(Effect.provide(storage.layer));

      assert.deepEqual(issued, {
        credential: FIRST_CREDENTIAL,
        replaced: false,
        runner: {
          name: "garage",
          createdAt: "2026-07-29T16:00:00.000Z",
          updatedAt: "2026-07-29T16:00:00.000Z",
        },
      });
      const persisted = storage.snapshot() as RunnerAuthority;
      assert.notInclude(JSON.stringify(persisted), FIRST_CREDENTIAL);
      assert.match(persisted.runners[0]?.credentialDigest ?? "", /^[a-f0-9]{64}$/u);

      const authenticated = yield* Effect.flatMap(RunnerRegistry, (registry) =>
        registry.authenticate({ name: "garage", credential: FIRST_CREDENTIAL }),
      ).pipe(Effect.provide(storage.layer));
      assert.equal(authenticated.name, "garage");

      const listed = yield* Effect.flatMap(RunnerRegistry, (registry) => registry.list()).pipe(
        Effect.provide(storage.layer),
      );
      assert.deepEqual(listed, [issued.runner]);
    }),
  );

  it.effect("requires explicit replacement and invalidates the old credential", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = makeStorage();
      yield* Effect.flatMap(RunnerRegistry, (registry) =>
        registry.register({
          name: "garage",
          credential: FIRST_CREDENTIAL,
          replace: false,
        }),
      ).pipe(Effect.provide(storage.layer));

      const duplicate = yield* Effect.flip(
        Effect.flatMap(RunnerRegistry, (registry) =>
          registry.register({
            name: "garage",
            credential: SECOND_CREDENTIAL,
            replace: false,
          }),
        ).pipe(Effect.provide(storage.layer)),
      );
      assert.equal(duplicate.reason, "runner_exists");

      yield* TestClock.adjust(1_000);
      const replaced = yield* Effect.flatMap(RunnerRegistry, (registry) =>
        registry.register({
          name: "garage",
          credential: SECOND_CREDENTIAL,
          replace: true,
        }),
      ).pipe(Effect.provide(storage.layer));
      assert.isTrue(replaced.replaced);
      assert.equal(replaced.runner.createdAt, "2026-07-29T16:00:00.000Z");
      assert.equal(replaced.runner.updatedAt, "2026-07-29T16:00:01.000Z");

      const oldCredential = yield* Effect.flip(
        Effect.flatMap(RunnerRegistry, (registry) =>
          registry.authenticate({ name: "garage", credential: FIRST_CREDENTIAL }),
        ).pipe(Effect.provide(storage.layer)),
      );
      assert.equal(oldCredential.reason, "credential_invalid");

      const current = yield* Effect.flatMap(RunnerRegistry, (registry) =>
        registry.authenticate({ name: "garage", credential: SECOND_CREDENTIAL }),
      ).pipe(Effect.provide(storage.layer));
      assert.equal(current.name, "garage");
    }),
  );

  it.effect("removes registrations and fails closed on malformed authority", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      yield* Effect.flatMap(RunnerRegistry, (registry) =>
        registry.register({
          name: "garage",
          credential: FIRST_CREDENTIAL,
          replace: false,
        }),
      ).pipe(Effect.provide(storage.layer));
      yield* Effect.flatMap(RunnerRegistry, (registry) => registry.remove("garage")).pipe(
        Effect.provide(storage.layer),
      );

      const missing = yield* Effect.flip(
        Effect.flatMap(RunnerRegistry, (registry) => registry.get("garage")).pipe(
          Effect.provide(storage.layer),
        ),
      );
      assert.equal(missing.reason, "runner_missing");

      const corrupt = makeStorage({ version: 1, runners: [{ name: "garage" }] });
      const invalid = yield* Effect.flip(
        Effect.flatMap(RunnerRegistry, (registry) => registry.list()).pipe(
          Effect.provide(corrupt.layer),
        ),
      );
      assert.equal(invalid.reason, "invalid_authority");
    }),
  );
});
