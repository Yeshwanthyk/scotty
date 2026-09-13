import { assert, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { type HatchState } from "../../src/hatch/contracts";
import { HatchStore, hatchStoreLayer } from "../../src/hatch/store";
import { makeSessionRecord } from "../support";

it.effect("fences Hatch startup receipts by attempt and runtime epoch", () =>
  Effect.gen(function* () {
    let state: HatchState = {};
    let runtimeEpoch = "epoch-one";
    const record = makeSessionRecord();
    const layer = hatchStoreLayer({
      get: async () => state,
      transaction: async (operation) =>
        operation({
          getHatch: async () => state,
          getActorAuthority: async () => undefined,
          getRecord: async () => record,
          getRuntimeEpoch: async () => runtimeEpoch,
          putHatch: async (next) => {
            state = next;
          },
          deleteHatch: async () => {
            state = {};
          },
        }),
    });
    const program = Effect.gen(function* () {
      const store = yield* HatchStore;
      const first = yield* store.updateStartup(record.id, "attempt-one", { operation: "begin" });
      const second = yield* store.updateStartup(record.id, "attempt-two", { operation: "begin" });
      assert.deepStrictEqual(first, { attemptId: "attempt-one", runtimeEpoch: "epoch-one" });
      assert.deepStrictEqual(second, { attemptId: "attempt-two", runtimeEpoch: "epoch-one" });
      const staleAttempt = yield* Effect.result(
        store.updateStartup(record.id, "ignored", {
          operation: "finish",
          ...first,
          failureCode: "preparation_failed",
        }),
      );
      assert.isTrue(Result.isFailure(staleAttempt));
      assert.deepStrictEqual(state.startup?.attemptId, "attempt-two");

      runtimeEpoch = "epoch-two";
      const staleRuntime = yield* Effect.result(
        store.updateStartup(record.id, "ignored", {
          operation: "finish",
          ...second,
          failureCode: "preparation_failed",
        }),
      );
      assert.isTrue(Result.isFailure(staleRuntime));
      assert.deepStrictEqual(state.startup?.attemptId, "attempt-two");

      const current = yield* store.updateStartup(record.id, "attempt-three", {
        operation: "begin",
      });
      yield* store.updateStartup(record.id, "ignored", {
        operation: "finish",
        ...current,
        failureCode: "preparation_failed",
      });
      assert.deepStrictEqual(yield* store.publicStatus, {
        status: "not_configured",
        startupFailure: "preparation_failed",
      });
      const succeeded = yield* store.updateStartup(record.id, "attempt-four", {
        operation: "begin",
      });
      yield* store.updateStartup(record.id, "ignored", { operation: "finish", ...succeeded });
      assert.deepStrictEqual(yield* store.publicStatus, { status: "not_configured" });
    });
    yield* program.pipe(Effect.provide(layer));
  }),
);

it.effect("resume clears a superseded startup failure and restores its configured timeout", () =>
  Effect.gen(function* () {
    const record = makeSessionRecord({
      status: "booting",
      operation: { kind: "resume", nonce: "resume-one", startedAt: "2026-01-01T00:00:01.000Z" },
    });
    let state: HatchState = {
      primary: {
        hatchId: "hatch-one",
        sessionId: record.id,
        generation: 1,
        service: {
          name: "web",
          argv: ["npm", "run", "dev"],
          workingDirectory: `/workspace/${record.id}`,
          port: 4_173,
          healthPath: "/health",
          readyTimeoutSeconds: 60,
        },
        desiredStatus: "open",
        observedStatus: "sleeping",
        exposure: "closed",
        routeNonce: "habcdefghijklmn",
        permits: [],
        requests: [],
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
      startup: {
        attemptId: "prior-attempt",
        runtimeEpoch: "prior-epoch",
        failureCode: "preparation_failed",
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
    };
    const layer = hatchStoreLayer({
      get: async () => state,
      transaction: async (operation) =>
        operation({
          getHatch: async () => state,
          getActorAuthority: async () => undefined,
          getRecord: async () => record,
          getRuntimeEpoch: async () => "resume-epoch",
          putHatch: async (next) => {
            state = next;
          },
          deleteHatch: async () => {
            state = {};
          },
        }),
    });
    yield* Effect.gen(function* () {
      const store = yield* HatchStore;
      assert.strictEqual((yield* store.publicStatus).startupFailure, "preparation_failed");
      const sleeping = state.primary;
      const staleStartup = state.startup;
      assert.isDefined(sleeping);
      assert.isDefined(staleStartup);
      const starting = yield* store.beginRestore({
        operationNonce: "resume-one",
        runtimeEpoch: "resume-epoch",
      });
      assert.isDefined(starting);
      assert.isUndefined((yield* store.publicStatus).startupFailure);
      assert.strictEqual((yield* store.restoreDescriptor)?.service.readyTimeoutSeconds, 60);
      yield* store.publishRunning(
        "resume-one",
        starting.hatchId,
        starting.generation,
        "resume-epoch",
      );
      assert.isUndefined((yield* store.publicStatus).startupFailure);
      assert.isUndefined(state.startup);

      state = { startup: staleStartup };
      const staleLease = yield* Effect.result(
        store.beginRestore({ operationNonce: "wrong-resume", runtimeEpoch: "resume-epoch" }),
      );
      assert.isTrue(Result.isFailure(staleLease));
      assert.strictEqual((yield* store.publicStatus).startupFailure, "preparation_failed");
      assert.isUndefined(
        yield* store.beginRestore({ operationNonce: "resume-one", runtimeEpoch: "resume-epoch" }),
      );
      assert.isUndefined(state.startup);

      state = { primary: { ...sleeping, desiredStatus: "closed" }, startup: staleStartup };
      assert.isUndefined(
        yield* store.beginRestore({ operationNonce: "resume-one", runtimeEpoch: "resume-epoch" }),
      );
      assert.isUndefined(state.startup);
    }).pipe(Effect.provide(layer));
  }),
);
