import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { RunnerOperation } from "../../protocol/runner";
import {
  makeRunnerControl,
  type RunnerConnectionState,
  type RunnerControlStorage,
  type RunnerDesiredState,
} from "../src/runner-control";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const operations = [
  { _tag: "EnsureRuntime", version: 2, sessionId: "session-a", operationId: "ensure" },
  { _tag: "InspectRuntime", version: 2, sessionId: "session-a", operationId: "inspect" },
  {
    _tag: "ExecRuntime",
    version: 2,
    sessionId: "session-a",
    operationId: "exec",
    argv: ["true"],
  },
  { _tag: "StopRuntime", version: 2, sessionId: "session-a", operationId: "stop" },
  { _tag: "RemoveRuntime", version: 2, sessionId: "session-a", operationId: "remove" },
] satisfies ReadonlyArray<RunnerOperation>;

const drainingFailure = {
  code: "runner_draining",
  message: "Runner is draining and cannot accept new sessions",
};

const disabledFailure = {
  code: "runner_disabled",
  message: "Runner is disabled for this operation",
};

const makeStorage = (initial?: {
  readonly desired?: unknown;
  readonly lastSeenAtMillis?: unknown;
}) => {
  let desired = initial?.desired;
  let lastSeenAtMillis = initial?.lastSeenAtMillis;
  const storage: RunnerControlStorage = {
    load: () => Effect.succeed({ desired, lastSeenAtMillis }),
    saveDesired: (next: RunnerDesiredState) =>
      Effect.sync(() => {
        desired = next;
      }),
    saveLastSeenAtMillis: (next: number) =>
      Effect.sync(() => {
        lastSeenAtMillis = next;
      }),
  };
  return {
    storage,
    snapshot: () => ({ desired, lastSeenAtMillis }),
  };
};

describe("runner control", () => {
  it.effect("preserves existing runner admission while persisting desired state", () =>
    Effect.gen(function* () {
      const persisted = makeStorage();
      const control = yield* makeRunnerControl(persisted.storage, () =>
        Effect.succeed("disconnected"),
      );

      assert.deepEqual(yield* control.status(), {
        desired: "accepting",
        connection: "disconnected",
        lastSeenAt: null,
      });

      yield* control.setDesired("draining");
      assert.equal(persisted.snapshot().desired, "draining");

      const rehydrated = yield* makeRunnerControl(persisted.storage, () =>
        Effect.succeed("disconnected"),
      );
      assert.equal((yield* rehydrated.status()).desired, "draining");
    }),
  );

  it.effect("records only successful active probes as last seen", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const persisted = makeStorage();
      let connection: RunnerConnectionState = "connected";
      const control = yield* makeRunnerControl(persisted.storage, () => Effect.succeed(connection));

      assert.deepEqual(yield* control.status(), {
        desired: "accepting",
        connection: "connected",
        lastSeenAt: "2026-07-27T12:00:00.000Z",
      });
      assert.equal(persisted.snapshot().lastSeenAtMillis, NOW);

      yield* TestClock.adjust(60_000);
      connection = "disconnected";
      assert.deepEqual(yield* control.status(), {
        desired: "accepting",
        connection: "disconnected",
        lastSeenAt: "2026-07-27T12:00:00.000Z",
      });
      assert.equal(persisted.snapshot().lastSeenAtMillis, NOW);
    }),
  );

  it.effect("enforces every desired-state and operation combination", () =>
    Effect.gen(function* () {
      const persisted = makeStorage();
      const control = yield* makeRunnerControl(persisted.storage, () =>
        Effect.succeed("connected"),
      );

      assert.deepEqual(operations.map(control.admission), [null, null, null, null, null]);
      assert.isTrue(control.mountedHttpEnabled());

      yield* control.setDesired("draining");
      assert.deepEqual(operations.map(control.admission), [
        drainingFailure,
        null,
        null,
        null,
        null,
      ]);
      assert.isTrue(control.mountedHttpEnabled());

      yield* control.setDesired("disabled");
      assert.deepEqual(operations.map(control.admission), [
        disabledFailure,
        null,
        disabledFailure,
        null,
        null,
      ]);
      assert.isFalse(control.mountedHttpEnabled());
    }),
  );

  it.effect("does not let an in-flight probe overwrite a desired-state change", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const persisted = makeStorage();
      const probe = yield* Deferred.make<RunnerConnectionState>();
      const control = yield* makeRunnerControl(persisted.storage, () => Deferred.await(probe));

      const status = yield* control.status().pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* control.setDesired("draining");
      yield* Deferred.succeed(probe, "connected");

      assert.deepEqual(yield* Fiber.join(status), {
        desired: "draining",
        connection: "connected",
        lastSeenAt: "2026-07-27T12:00:00.000Z",
      });
      assert.equal(persisted.snapshot().desired, "draining");
    }),
  );

  it.effect("fails closed for invalid persisted desired state", () =>
    Effect.gen(function* () {
      const persisted = makeStorage({ desired: "unknown", lastSeenAtMillis: "invalid" });
      const control = yield* makeRunnerControl(persisted.storage, () =>
        Effect.succeed("disconnected"),
      );

      assert.deepEqual(yield* control.status(), {
        desired: "disabled",
        connection: "disconnected",
        lastSeenAt: null,
      });
    }),
  );
});
