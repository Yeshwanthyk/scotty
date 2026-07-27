import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  RunnerTransport,
  type RunnerDispatchResult,
  type RunnerSocket,
} from "../src/runner-transport";

class FakeSocket implements RunnerSocket {
  attachment: unknown = null;
  readonly sent: string[] = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  failSend = false;

  readonly send = (data: string | Uint8Array): Effect.Effect<void, string> =>
    this.failSend
      ? Effect.fail("socket unavailable")
      : Effect.sync(() => {
          this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        });

  readonly close = (code: number, reason: string): Effect.Effect<void> =>
    Effect.sync(() => {
      this.closed.push({ code, reason });
    });

  serializeAttachment<T>(value: T): void {
    this.attachment = value;
  }

  deserializeAttachment<T>(): T | null {
    return this.attachment as T | null;
  }
}

const hello = (runner = "slumbers"): string =>
  JSON.stringify({ _tag: "RunnerHello", version: 1, runner });

const response = (sessionId: string, operationId: string): string =>
  JSON.stringify({
    _tag: "RunnerSuccess",
    version: 1,
    sessionId,
    operationId,
    result: {
      _tag: "EnsureRuntimeResult",
      phase: "running",
      resourceId: `runner:${sessionId}`,
      workspace: `/workspace/${sessionId}`,
    },
  });

const ensure = (sessionId: string, operationId: string) => ({
  _tag: "EnsureRuntime" as const,
  version: 1 as const,
  sessionId,
  operationId,
});

const connect = (transport: RunnerTransport, socket: FakeSocket): Effect.Effect<void> =>
  Effect.gen(function* () {
    transport.accept(socket);
    yield* transport.message(socket, hello());
  });

const expectSuccess = (result: RunnerDispatchResult): void => {
  assert.isTrue(result.ok);
};

describe("runner transport", () => {
  it.effect("requires the configured hello before accepting work", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("slumbers");
      const socket = new FakeSocket();
      assert.equal(transport.status(), "disconnected");
      transport.accept(socket);
      assert.equal(transport.status(), "disconnected");

      const unavailable = yield* transport.dispatch(ensure("session-a", "ensure"), 10);
      assert.deepEqual(unavailable, {
        ok: false,
        error: { code: "runner_unavailable", message: "Runner is not connected" },
      });

      yield* transport.message(socket, hello("other"));
      assert.deepEqual(socket.closed, [{ code: 1008, reason: "Runner identity mismatch" }]);
      assert.equal(transport.status(), "disconnected");
    }),
  );

  it.effect("reports only a ready active attachment as connected", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("slumbers");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      assert.equal(transport.status(), "connected");

      const rehydrated = new RunnerTransport("slumbers", [socket]);
      assert.equal(rehydrated.status(), "connected");
      yield* rehydrated.close(socket);
      assert.equal(rehydrated.status(), "disconnected");
    }),
  );

  it.effect("correlates the same operation ID independently across sessions", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("slumbers");
      const socket = new FakeSocket();
      yield* connect(transport, socket);

      const first = yield* transport
        .dispatch(ensure("session-a", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      const second = yield* transport
        .dispatch(ensure("session-b", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(socket.sent.length, 2);

      yield* transport.message(socket, response("session-b", "ensure"));
      yield* transport.message(socket, response("session-a", "ensure"));
      expectSuccess(yield* Fiber.join(first));
      expectSuccess(yield* Fiber.join(second));
    }),
  );

  it.effect("rehydrates the ready link from its hibernatable attachment", () =>
    Effect.gen(function* () {
      const initial = new RunnerTransport("slumbers");
      const socket = new FakeSocket();
      yield* connect(initial, socket);

      const rehydrated = new RunnerTransport("slumbers", [socket]);
      const pending = yield* rehydrated
        .dispatch(ensure("session-a", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* rehydrated.message(socket, response("session-a", "ensure"));
      expectSuccess(yield* Fiber.join(pending));
    }),
  );

  it.effect("lets a late receipt complete a same-identity retry after timeout", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("slumbers");
      const socket = new FakeSocket();
      yield* connect(transport, socket);

      const first = yield* transport
        .dispatch(ensure("session-a", "ensure"), 10)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(10);
      assert.deepEqual(yield* Fiber.join(first), {
        ok: false,
        error: { code: "runner_timeout", message: "Runner did not reply before the timeout" },
      });

      const retry = yield* transport
        .dispatch(ensure("session-a", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(socket.sent.length, 2);
      yield* transport.message(socket, response("session-a", "ensure"));
      expectSuccess(yield* Fiber.join(retry));

      // A duplicate receipt after completion is harmless.
      yield* transport.message(socket, response("session-a", "ensure"));
      assert.deepEqual(socket.closed, []);
    }),
  );

  it.effect("fails and removes pending work when sending defects", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("slumbers");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      socket.failSend = true;

      assert.deepEqual(yield* transport.dispatch(ensure("session-a", "ensure"), 100), {
        ok: false,
        error: {
          code: "runner_disconnected",
          message: "Runner disconnected before replying",
        },
      });
      socket.failSend = false;
      assert.deepEqual(yield* transport.dispatch(ensure("session-a", "ensure-2"), 100), {
        ok: false,
        error: { code: "runner_unavailable", message: "Runner is not connected" },
      });

      const replacement = new FakeSocket();
      yield* connect(transport, replacement);
      const retry = yield* transport
        .dispatch(ensure("session-a", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* transport.message(replacement, response("session-a", "ensure"));
      expectSuccess(yield* Fiber.join(retry));
    }),
  );

  it.effect("fails pending work when a link closes or is replaced", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("slumbers");
      const firstSocket = new FakeSocket();
      yield* connect(transport, firstSocket);
      const pending = yield* transport
        .dispatch(ensure("session-a", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const replacement = new FakeSocket();
      yield* connect(transport, replacement);
      assert.deepEqual(yield* Fiber.join(pending), {
        ok: false,
        error: {
          code: "runner_disconnected",
          message: "Runner disconnected before replying",
        },
      });
      assert.deepEqual(firstSocket.closed, [{ code: 1012, reason: "Runner connection replaced" }]);

      const replacementPending = yield* transport
        .dispatch(ensure("session-b", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* transport.close(replacement);
      assert.deepEqual(yield* Fiber.join(replacementPending), {
        ok: false,
        error: {
          code: "runner_disconnected",
          message: "Runner disconnected before replying",
        },
      });
    }),
  );
});
