import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  RUNNER_CREDIT_WINDOW,
  HttpCreditSchema,
  HttpDataSchema,
  RunnerProbeSchema,
  decodeRunnerRequestText,
  encodeRunnerFrame,
} from "../../protocol/runner";
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

const hello = (runner = "example-runner"): string =>
  JSON.stringify({ _tag: "RunnerHello", version: 2, runner });

const response = (sessionId: string, operationId: string): string =>
  JSON.stringify({
    _tag: "RunnerSuccess",
    version: 2,
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
  version: 2 as const,
  sessionId,
  operationId,
});

const connect = (transport: RunnerTransport, socket: FakeSocket): Effect.Effect<void> =>
  Effect.gen(function* () {
    transport.accept(socket);
    yield* transport.message(socket, hello());
  });

const decodeProbe = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerProbeSchema));

const acknowledgeStatus = (transport: RunnerTransport, socket: FakeSocket) =>
  Effect.gen(function* () {
    const status = yield* transport.status(1_000).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const probe = yield* decodeProbe(socket.sent.at(-1));
    yield* transport.message(
      socket,
      JSON.stringify({
        _tag: "RunnerProbeAck",
        version: 2,
        probeId: probe.probeId,
      }),
    );
    return yield* Fiber.join(status);
  });

const expectSuccess = (result: RunnerDispatchResult): void => {
  assert.isTrue(result.ok);
};

const decodeSent = (socket: FakeSocket, index: number) =>
  decodeRunnerRequestText(socket.sent[index] ?? "");
const decodeCreditSent = Schema.decodeUnknownEffect(Schema.fromJsonString(HttpCreditSchema));
const decodeDataSent = Schema.decodeUnknownEffect(Schema.fromJsonString(HttpDataSchema));

describe("runner transport", () => {
  it.effect("requires the configured hello before accepting work", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      assert.equal(yield* transport.status(), "disconnected");
      transport.accept(socket);
      assert.equal(yield* transport.status(), "disconnected");

      const unavailable = yield* transport.dispatch(ensure("session-a", "ensure"), 10);
      assert.deepEqual(unavailable, {
        ok: false,
        error: { code: "runner_unavailable", message: "Runner is not connected" },
      });

      yield* transport.message(socket, hello("other"));
      assert.deepEqual(socket.closed, [{ code: 1008, reason: "Runner identity mismatch" }]);
      assert.equal(yield* transport.status(), "disconnected");
    }),
  );

  it.effect("reports only a ready active attachment as connected", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      assert.equal(yield* acknowledgeStatus(transport, socket), "connected");

      const rehydrated = new RunnerTransport("example-runner", [socket]);
      assert.equal(yield* acknowledgeStatus(rehydrated, socket), "connected");
      yield* rehydrated.close(socket);
      assert.equal(yield* rehydrated.status(), "disconnected");
    }),
  );

  it.effect("acknowledges a runner-owned liveness probe", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);

      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "RunnerProbe",
          version: 2,
          probeId: "runner-probe-1",
        }),
      );

      const acknowledged = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("RunnerProbeAck")(acknowledged));
      if (!Predicate.isTagged("RunnerProbeAck")(acknowledged)) return;
      assert.strictEqual(acknowledged.probeId, "runner-probe-1");
      assert.deepStrictEqual(socket.closed, []);
    }),
  );

  it.effect("disconnects a stale ready attachment when its liveness probe times out", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);

      const status = yield* transport.status(1_000).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(1_000);

      assert.equal(yield* Fiber.join(status), "disconnected");
      assert.deepEqual(socket.closed, [{ code: 1011, reason: "Runner probe timed out" }]);
      assert.equal(yield* transport.status(), "disconnected");
    }),
  );

  it.effect("correlates the same operation ID independently across sessions", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
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
      const initial = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(initial, socket);

      const rehydrated = new RunnerTransport("example-runner", [socket]);
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
      const transport = new RunnerTransport("example-runner");
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
      const transport = new RunnerTransport("example-runner");
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
      const transport = new RunnerTransport("example-runner");
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

  it.effect("operator disconnect fails concurrent probes and dispatches", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);

      const status = yield* transport.status(1_000).pipe(Effect.forkChild);
      const dispatch = yield* transport
        .dispatch(ensure("session-a", "ensure"), 1_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* transport.disconnect();

      assert.equal(yield* Fiber.join(status), "disconnected");
      assert.deepEqual(yield* Fiber.join(dispatch), {
        ok: false,
        error: {
          code: "runner_disconnected",
          message: "Runner disconnected before replying",
        },
      });
      assert.deepEqual(socket.closed, [{ code: 1012, reason: "Runner disconnected by operator" }]);
      assert.equal(yield* transport.status(), "disconnected");

      // Repeating the command with no current transport is harmless.
      yield* transport.disconnect();
      assert.equal(socket.closed.length, 1);
    }),
  );

  it.effect("operator disconnect also closes a connection still in its handshake", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      transport.accept(socket);

      yield* transport.disconnect();

      assert.deepEqual(socket.closed, [{ code: 1012, reason: "Runner disconnected by operator" }]);
      yield* transport.message(socket, hello());
      assert.equal(yield* transport.status(), "disconnected");
    }),
  );

  it.effect("streams a mounted GET response and replenishes response credit as chunks drain", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);

      const pending = yield* transport
        .http({
          request: new Request("https://scotty.test/s/session-a/events"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/s/session-a/events",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const open = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(open));
      if (!Predicate.isTagged("HttpOpen")(open)) return;
      assert.strictEqual(open.method, "GET");
      assert.strictEqual(open.target, "/s/session-a/events");
      assert.strictEqual(open.responseCredit, RUNNER_CREDIT_WINDOW);

      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: open.streamId,
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/event-stream"]],
          hasBody: true,
        }),
      );
      const response = yield* Fiber.join(pending);
      assert.strictEqual(response.headers.get("content-type"), "text/event-stream");
      const reader = response.body?.getReader();
      assert.isDefined(reader);
      if (reader === undefined) return;

      const first = new TextEncoder().encode("data: first\n\n");
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpData",
          version: 2,
          streamId: open.streamId,
          direction: "response",
          data: encodeBase64(first),
        }),
      );
      const firstRead = yield* Effect.promise(() => reader.read());
      assert.deepStrictEqual(firstRead.value, first);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve))),
      );
      const credit = yield* decodeCreditSent(socket.sent[1] ?? "");
      assert.strictEqual(credit.direction, "response");
      assert.strictEqual(credit.credit, first.byteLength);

      const second = new TextEncoder().encode("data: second\n\n");
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpData",
          version: 2,
          streamId: open.streamId,
          direction: "response",
          data: encodeBase64(second),
        }),
      );
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpEnd",
          version: 2,
          streamId: open.streamId,
          direction: "response",
        }),
      );
      const secondRead = yield* Effect.promise(() => reader.read());
      const ended = yield* Effect.promise(() => reader.read());
      assert.deepStrictEqual(secondRead.value, second);
      assert.isTrue(ended.done);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve))),
      );
      const lateCredit = yield* decodeCreditSent(socket.sent.at(-1) ?? "");
      assert.strictEqual(lateCredit.streamId, open.streamId);

      const next = yield* transport
        .http({
          request: new Request("https://scotty.test/after-terminal"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/after-terminal",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const nextOpen = yield* decodeSent(socket, socket.sent.length - 1);
      assert.isTrue(Predicate.isTagged("HttpOpen")(nextOpen));
      if (!Predicate.isTagged("HttpOpen")(nextOpen)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: nextOpen.streamId,
          status: 204,
          statusText: "No Content",
          headers: [],
          hasBody: false,
        }),
      );
      assert.strictEqual((yield* Fiber.join(next)).status, 204);
      assert.deepStrictEqual(socket.closed, []);
    }),
  );

  it.effect("accepts HTTP response frames from rewrapped WebSocket event handles", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      const eventSocket: RunnerSocket = {
        send: socket.send,
        close: socket.close,
        serializeAttachment: (value) => socket.serializeAttachment(value),
        deserializeAttachment: () => socket.deserializeAttachment(),
      };
      assert.notStrictEqual(eventSocket, socket);

      const pending = yield* transport
        .http({
          request: new Request("https://scotty.test/s/session-a/health"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/s/session-a/health",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const open = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(open));
      if (!Predicate.isTagged("HttpOpen")(open)) return;

      yield* transport.message(
        eventSocket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: open.streamId,
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]],
          hasBody: true,
        }),
      );
      const response = yield* Fiber.join(pending);
      const body = new TextEncoder().encode('{"ok":true}');
      yield* transport.message(
        eventSocket,
        encodeRunnerFrame({
          _tag: "HttpData",
          version: 2,
          streamId: open.streamId,
          direction: "response",
          data: encodeBase64(body),
        }),
      );
      yield* transport.message(
        eventSocket,
        encodeRunnerFrame({
          _tag: "HttpEnd",
          version: 2,
          streamId: open.streamId,
          direction: "response",
        }),
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(yield* Effect.promise(() => response.text()), '{"ok":true}');
      assert.deepStrictEqual(socket.closed, []);
    }),
  );

  it.effect("settles a blocked response read on cancellation and reuses stream capacity", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      const pending = yield* transport
        .http({
          request: new Request("https://scotty.test/blocked"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/blocked",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const open = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(open));
      if (!Predicate.isTagged("HttpOpen")(open)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: open.streamId,
          status: 200,
          statusText: "OK",
          headers: [],
          hasBody: true,
        }),
      );
      const response = yield* Fiber.join(pending);
      const reader = response.body?.getReader();
      assert.isDefined(reader);
      if (reader === undefined) return;
      const blockedRead = reader.read();
      yield* Effect.promise(() => reader.cancel());
      assert.isTrue((yield* Effect.promise(() => blockedRead)).done);

      const reused = yield* transport
        .http({
          request: new Request("https://scotty.test/reused"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/reused",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const reusedOpen = yield* decodeSent(socket, socket.sent.length - 1);
      assert.isTrue(Predicate.isTagged("HttpOpen")(reusedOpen));
      if (!Predicate.isTagged("HttpOpen")(reusedOpen)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: reusedOpen.streamId,
          status: 204,
          statusText: "No Content",
          headers: [],
          hasBody: false,
        }),
      );
      assert.strictEqual((yield* Fiber.join(reused)).status, 204);
      assert.deepStrictEqual(socket.closed, []);
    }),
  );

  it.effect("strips forbidden runner response metadata at the Worker boundary", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      const pending = yield* transport
        .http({
          request: new Request("https://scotty.test/headers"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/headers",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const open = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(open));
      if (!Predicate.isTagged("HttpOpen")(open)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: open.streamId,
          status: 204,
          statusText: "No Content",
          headers: [
            ["connection", "x-runner-secret"],
            ["x-runner-secret", "leak"],
            ["set-cookie", "runtime=secret"],
            ["transfer-encoding", "chunked"],
            ["x-safe", "yes"],
          ],
          hasBody: false,
        }),
      );
      const response = yield* Fiber.join(pending);
      assert.strictEqual(response.headers.get("connection"), null);
      assert.strictEqual(response.headers.get("x-runner-secret"), null);
      assert.strictEqual(response.headers.get("set-cookie"), null);
      assert.strictEqual(response.headers.get("transfer-encoding"), null);
      assert.strictEqual(response.headers.get("x-safe"), "yes");
    }),
  );

  it.effect("maps a pre-response request failure to 502 without closing the link", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      const pending = yield* transport
        .http({
          request: new Request("https://scotty.test/oversized-headers"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/oversized-headers",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const open = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(open));
      if (!Predicate.isTagged("HttpOpen")(open)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpFailed",
          version: 2,
          streamId: open.streamId,
          code: "request_failed",
        }),
      );
      assert.strictEqual((yield* Fiber.join(pending)).status, 502);
      assert.deepStrictEqual(socket.closed, []);

      const next = yield* transport
        .http({
          request: new Request("https://scotty.test/healthy"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/healthy",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const nextOpen = yield* decodeSent(socket, socket.sent.length - 1);
      assert.isTrue(Predicate.isTagged("HttpOpen")(nextOpen));
      if (!Predicate.isTagged("HttpOpen")(nextOpen)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: nextOpen.streamId,
          status: 204,
          statusText: "No Content",
          headers: [],
          hasBody: false,
        }),
      );
      assert.strictEqual((yield* Fiber.join(next)).status, 204);
      assert.deepStrictEqual(socket.closed, []);
    }),
  );

  it.effect("streams a sanitized bounded POST body only after request credit", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      const pending = yield* transport
        .http({
          request: new Request("https://scotty.test/s/session-a/api", {
            method: "POST",
            headers: {
              authorization: "Bearer browser-secret",
              "content-type": "text/plain",
              cookie: "session=secret",
            },
            body: "hello",
          }),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/s/session-a/api?mode=test",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const open = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(open));
      if (!Predicate.isTagged("HttpOpen")(open)) return;
      assert.deepStrictEqual(open.headers, [["content-type", "text/plain"]]);
      assert.strictEqual(socket.sent.length, 1);

      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpCredit",
          version: 2,
          streamId: open.streamId,
          direction: "request",
          credit: 5,
        }),
      );
      yield* Effect.yieldNow;
      const data = yield* decodeDataSent(socket.sent[1] ?? "");
      const end = yield* decodeSent(socket, 2);
      assert.strictEqual(new TextDecoder().decode(decodeBase64(data.data)), "hello");
      assert.isTrue(Predicate.isTagged("HttpEnd")(end));

      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: open.streamId,
          status: 204,
          statusText: "No Content",
          headers: [],
          hasBody: false,
        }),
      );
      assert.strictEqual((yield* Fiber.join(pending)).status, 204);
    }),
  );

  it.effect("propagates consumer cancellation and times out an unopened response", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      const pending = yield* transport
        .http({
          request: new Request("https://scotty.test/s/session-a/events"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/events",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const open = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(open));
      if (!Predicate.isTagged("HttpOpen")(open)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpResponse",
          version: 2,
          streamId: open.streamId,
          status: 200,
          statusText: "OK",
          headers: [],
          hasBody: true,
        }),
      );
      const response = yield* Fiber.join(pending);
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
      const cancel = yield* decodeSent(socket, 1);
      assert.isTrue(Predicate.isTagged("HttpCancel")(cancel));

      const timed = yield* transport
        .http({
          request: new Request("https://scotty.test/s/session-b"),
          sessionId: "session-b",
          runtimeId: "runtime-b",
          target: "/",
          timeoutMillis: 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(1_000);
      assert.strictEqual((yield* Fiber.join(timed)).status, 504);
      const timeoutCancel = yield* decodeSent(socket, socket.sent.length - 1);
      assert.isTrue(Predicate.isTagged("HttpCancel")(timeoutCancel));
    }),
  );

  it.effect("closes malformed stream sequences and enforces per-session concurrency", () =>
    Effect.gen(function* () {
      const transport = new RunnerTransport("example-runner");
      const socket = new FakeSocket();
      yield* connect(transport, socket);
      const active: Array<Fiber.Fiber<Response>> = [];
      for (let index = 0; index < 16; index += 1) {
        active.push(
          yield* transport
            .http({
              request: new Request(`https://scotty.test/${index}`),
              sessionId: "session-a",
              runtimeId: "runtime-a",
              target: `/${index}`,
              timeoutMillis: 1_000,
            })
            .pipe(Effect.forkChild),
        );
      }
      yield* Effect.yieldNow;
      assert.strictEqual(
        (yield* transport.http({
          request: new Request("https://scotty.test/overflow"),
          sessionId: "session-a",
          runtimeId: "runtime-a",
          target: "/overflow",
        })).status,
        429,
      );

      const first = yield* decodeSent(socket, 0);
      assert.isTrue(Predicate.isTagged("HttpOpen")(first));
      if (!Predicate.isTagged("HttpOpen")(first)) return;
      yield* transport.message(
        socket,
        encodeRunnerFrame({
          _tag: "HttpData",
          version: 2,
          streamId: first.streamId,
          direction: "response",
          data: encodeBase64(new Uint8Array([1])),
        }),
      );
      assert.deepStrictEqual(socket.closed, [
        { code: 1008, reason: "Invalid runner HTTP response data" },
      ]);
      for (const fiber of active) assert.strictEqual((yield* Fiber.join(fiber)).status, 502);
    }),
  );
});

function encodeBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
  return decoded;
}
