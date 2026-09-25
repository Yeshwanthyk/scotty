import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  makeRuntimeCliSelection,
  RUNTIME_CLI_SELECTION_FRESH_MILLIS,
  type RuntimeCliSelectionStorage,
} from "../../src/runtime-cli/selection";
import {
  RuntimeCliReleaseLookupError,
  RuntimeCliReleaseSignatureError,
  NoCompatibleRuntimeCliReleaseError,
  RuntimeCliReleaseSearchTruncatedError,
  MalformedRuntimeCliReleaseDataError,
  type ResolvedRuntimeCliRelease,
} from "../../src/runtime-cli/release-resolver";
import {
  RuntimeCliCacheIntegrityError,
  runtimeCliCacheObjectKey,
} from "../../src/runtime-cli/cache";
import { runtimeCliPin } from "./fixtures";

const release = (version = "0.3.19"): ResolvedRuntimeCliRelease => ({
  releaseId: 1,
  releaseTag: `v${version}`,
  artifactDownloadUrl: `https://github.com/Yeshwanthyk/scotty/releases/download/v${version}/scotty-runtime-linux-amd64`,
  descriptor: {
    ...runtimeCliPin.descriptor,
    releaseTag: `v${version}`,
    artifact: { ...runtimeCliPin.descriptor.artifact, cliVersion: version },
  },
});
const handle = (value: ResolvedRuntimeCliRelease) => ({
  release: value,
  key: runtimeCliCacheObjectKey(value.descriptor.artifact.sha256),
  sha256: value.descriptor.artifact.sha256,
  byteSize: value.descriptor.artifact.byteSize,
});
const memory = () => {
  let state: unknown;
  let tail = Promise.resolve();
  const storage: RuntimeCliSelectionStorage = {
    transaction: (operation) => {
      const result = tail.then(() =>
        operation({
          get: async () => state,
          put: async (value) => {
            state = value;
          },
        }),
      );
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return { storage, read: () => state };
};
const supported = runtimeCliPin.descriptor.compatibility;
const cache = { ensure: (value: ResolvedRuntimeCliRelease) => Effect.succeed(handle(value)) };

describe("SandboxConfig runtime CLI authority", () => {
  it.effect(
    "persists only after cache verification and retains honest outage freshness across reconstruction",
    () =>
      Effect.gen(function* () {
        const state = memory();
        const selector = makeRuntimeCliSelection(
          state.storage,
          { resolve: () => Effect.succeed(release()) },
          {
            ensure: (value) =>
              Effect.sync(() => {
                assert.deepEqual(state.read(), { issued: 1, committed: 0, pin: null });
                return handle(value);
              }),
          },
        );
        const pin = yield* selector.select(supported);
        assert.equal(pin.freshness, "github_verified");
        yield* TestClock.adjust(RUNTIME_CLI_SELECTION_FRESH_MILLIS);
        const restarted = makeRuntimeCliSelection(
          state.storage,
          {
            resolve: () =>
              Effect.fail(
                new RuntimeCliReleaseLookupError({
                  reason: "outage",
                  stage: "releases",
                  status: 503,
                }),
              ),
          },
          cache,
        );
        const fallback = yield* restarted.select(supported);
        assert.deepEqual(fallback, { ...pin, freshness: "cached_during_lookup_outage" });
        const incompatible = { ...supported, bunVersion: "9.0.0" };
        const error = yield* restarted.select(incompatible).pipe(Effect.flip);
        assert.deepInclude(error, { reason: "no_cached_selection" });
      }),
  );
  it.effect("does not downgrade cache integrity failure or overwrite verified authority", () =>
    Effect.gen(function* () {
      const state = memory();
      const first = yield* makeRuntimeCliSelection(
        state.storage,
        { resolve: () => Effect.succeed(release()) },
        cache,
      ).select(supported);
      yield* TestClock.adjust(RUNTIME_CLI_SELECTION_FRESH_MILLIS);
      const error = yield* makeRuntimeCliSelection(
        state.storage,
        { resolve: () => Effect.succeed(release("0.3.20")) },
        {
          ensure: () =>
            Effect.fail(new RuntimeCliCacheIntegrityError({ reason: "digest_mismatch" })),
        },
      )
        .select(supported)
        .pipe(Effect.flip);
      assert.deepInclude(error, { reason: "digest_mismatch" });
      assert.deepEqual(state.read(), { issued: 2, committed: 1, pin: first });
    }),
  );
  for (const failure of [
    new RuntimeCliReleaseLookupError({ reason: "outage", stage: "manifest", status: 404 }),
    new RuntimeCliReleaseLookupError({ reason: "outage", stage: "releases", status: 401 }),
    new RuntimeCliReleaseLookupError({ reason: "outage", stage: "manifest", status: 403 }),
    new RuntimeCliReleaseSignatureError({ reason: "invalid_signature", releaseTag: "v0.3.20" }),
    new NoCompatibleRuntimeCliReleaseError(),
    new RuntimeCliReleaseSearchTruncatedError({ pagesSearched: 3, releasesSearched: 30 }),
    new MalformedRuntimeCliReleaseDataError({ stage: "manifest" }),
  ]) {
    it.effect(`does not downgrade ${failure.name}`, () =>
      Effect.gen(function* () {
        const state = memory();
        yield* makeRuntimeCliSelection(
          state.storage,
          { resolve: () => Effect.succeed(release()) },
          cache,
        ).select(supported);
        yield* TestClock.adjust(RUNTIME_CLI_SELECTION_FRESH_MILLIS);
        const error = yield* makeRuntimeCliSelection(
          state.storage,
          { resolve: () => Effect.fail(failure) },
          cache,
        )
          .select(supported)
          .pipe(Effect.flip);
        assert.strictEqual(error, failure);
      }),
    );
  }
  it.effect("reuses a recently verified pin without querying GitHub", () =>
    Effect.gen(function* () {
      const state = memory();
      let lookups = 0;
      const selector = makeRuntimeCliSelection(
        state.storage,
        { resolve: () => Effect.sync(() => (lookups += 1)).pipe(Effect.as(release())) },
        cache,
      );
      const pin = yield* selector.select(supported);
      yield* TestClock.adjust(RUNTIME_CLI_SELECTION_FRESH_MILLIS - 1);
      assert.deepEqual(yield* selector.select(supported), pin);
      assert.strictEqual(lookups, 1);
      assert.deepEqual(state.read(), { issued: 1, committed: 1, pin });
      yield* TestClock.adjust(1);
      const refreshed = yield* selector.select(supported);
      assert.strictEqual(lookups, 2);
      assert.strictEqual(refreshed.verifiedAt, RUNTIME_CLI_SELECTION_FRESH_MILLIS);
    }),
  );
  it.effect("falls back to the cached pin when the releases API is rate limited", () =>
    Effect.gen(function* () {
      const state = memory();
      const pin = yield* makeRuntimeCliSelection(
        state.storage,
        { resolve: () => Effect.succeed(release()) },
        cache,
      ).select(supported);
      yield* TestClock.adjust(RUNTIME_CLI_SELECTION_FRESH_MILLIS);
      const fallback = yield* makeRuntimeCliSelection(
        state.storage,
        {
          resolve: () =>
            Effect.fail(
              new RuntimeCliReleaseLookupError({
                reason: "outage",
                stage: "releases",
                status: 403,
              }),
            ),
        },
        cache,
      ).select(supported);
      assert.deepEqual(fallback, { ...pin, freshness: "cached_during_lookup_outage" });
    }),
  );
  it.effect("stale completion cannot roll the installation selection back", () =>
    Effect.gen(function* () {
      const state = memory();
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const slow = makeRuntimeCliSelection(
        state.storage,
        { resolve: () => Effect.succeed(release()) },
        {
          ensure: (value) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(handle(value)),
            ),
        },
      );
      const pending = yield* slow.select(supported).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const newer = yield* makeRuntimeCliSelection(
        state.storage,
        { resolve: () => Effect.succeed(release("0.3.20")) },
        cache,
      ).select(supported);
      yield* Deferred.succeed(finish, undefined);
      const olderAdmission = yield* Fiber.join(pending);
      assert.equal(olderAdmission.descriptor.releaseTag, "v0.3.19");
      assert.deepEqual(state.read(), { issued: 2, committed: 2, pin: newer });
    }),
  );
});
