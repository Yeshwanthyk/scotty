import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Predicate, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  RUNNER_CREDIT_WINDOW,
  RunnerFrameSchema,
  HttpResponseSchema,
  encodeRunnerFrame,
  encodeRunnerRequest,
  type HttpOpen,
  type InspectRuntime,
  type RunnerFrame,
  type RunnerResponse,
} from "../../protocol/runner";
import {
  RunnerLinkError,
  runRunnerLinkWith,
  runRunnerSupervisorWith,
  type RunnerConnector,
  type RunnerHttpHandler,
  type RunnerWebSocketConstructor,
} from "../src/runner-link";
import { RunnerRuntime } from "../src/runner-runtime";

const inspect = (operationId: string): InspectRuntime => ({
  _tag: "InspectRuntime",
  version: 2,
  operationId,
  sessionId: "session-a",
});

const response = (operation: InspectRuntime): RunnerResponse => ({
  _tag: "RunnerSuccess",
  version: 2,
  operationId: operation.operationId,
  sessionId: operation.sessionId,
  result: {
    _tag: "InspectRuntimeResult",
    phase: "running",
    resourceId: "test-resource",
    workspace: "/test/workspace",
  },
});

const runtime = RunnerRuntime.of({
  handle: (operation) => {
    assert.isTrue(Predicate.isTagged("InspectRuntime")(operation));
    return Predicate.isTagged("InspectRuntime")(operation)
      ? Effect.succeed(response(operation))
      : Effect.die("unexpected operation");
  },
});

const decodeFrame = Schema.decodeUnknownResult(Schema.fromJsonString(RunnerFrameSchema));
const decodeFrameSync = Schema.decodeUnknownSync(Schema.fromJsonString(RunnerFrameSchema));
const decodeHttpResponse = Schema.decodeUnknownSync(Schema.fromJsonString(HttpResponseSchema));

const sentFrame = (socket: FakeWebSocket, index: number): RunnerFrame =>
  decodeFrameSync(socket.sent[index] ?? "");

const openHttp = (overrides: Partial<HttpOpen> = {}): HttpOpen => ({
  _tag: "HttpOpen",
  version: 2,
  streamId: "stream-1",
  sessionId: "session-a",
  runtimeId: "runtime-a",
  method: "GET",
  target: "/s/session-a",
  headers: [],
  hasBody: false,
  responseCredit: RUNNER_CREDIT_WINDOW,
  ...overrides,
});

const closeEvent = (code: number): Event => {
  const event = new Event("close");
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: "" },
  });
  return event;
};

class FakeWebSocket extends EventTarget implements WebSocket {
  binaryType: BinaryType = "arraybuffer";
  readonly bufferedAmount = 0;
  readonly extensions = "";
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  readonly protocol = "";
  readyState = WebSocket.CONNECTING;
  readonly url: string;
  readonly sent: Array<string> = [];
  readonly closeCodes: Array<number | undefined> = [];
  onSend: (data: string) => void = () => {};

  constructor(url: string) {
    super();
    this.url = url;
  }

  close(code?: number): void {
    this.closeCodes.push(code);
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(closeEvent(code ?? 1005));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    assert.strictEqual(typeof data, "string");
    if (typeof data === "string") {
      this.sent.push(data);
      this.onSend(data);
    }
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string | Uint8Array): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  remoteClose(code: number): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(closeEvent(code));
  }
}

describe("RunnerLink", () => {
  it.effect("authenticates, announces, dispatches operations, and rejects invalid frames", () =>
    Effect.gen(function* () {
      const first = inspect("inspect-1");
      const second = inspect("inspect-2");
      let socket: FakeWebSocket | undefined;
      let authorization: string | string[] | undefined;
      let openedAfterHello = false;
      const makeWebSocket: RunnerWebSocketConstructor = (url, options) => {
        authorization = options.headers?.Authorization;
        const fake = new FakeWebSocket(url);
        socket = fake;
        fake.onSend = () => {
          if (fake.sent.length === 1) {
            queueMicrotask(() => {
              fake.receive(JSON.stringify(first));
              fake.receive(JSON.stringify(second));
              fake.receive(
                encodeRunnerRequest({
                  _tag: "RunnerProbe",
                  version: 2,
                  probeId: "probe-1",
                }),
              );
              fake.receive(
                encodeRunnerRequest({
                  _tag: "HttpOpen",
                  version: 2,
                  streamId: "stream-1",
                  sessionId: "session-a",
                  runtimeId: "runtime-a",
                  method: "GET",
                  target: "/",
                  headers: [],
                  hasBody: false,
                  responseCredit: 131_072,
                }),
              );
            });
          } else if (fake.sent.length === 5) {
            queueMicrotask(() => {
              fake.receive("{");
              fake.receive(new Uint8Array([1, 2, 3]));
              fake.receive("x".repeat(256 * 1024 + 1));
            });
          } else if (fake.sent.length === 8) {
            fake.remoteClose(1000);
          }
        };
        queueMicrotask(() => fake.open());
        return fake;
      };

      const result = yield* Effect.result(
        runRunnerLinkWith(
          {
            url: "ws://127.0.0.1/runner",
            runnerName: "runner-a",
            token: "runner-secret",
            onOpen: Effect.sync(() => {
              openedAfterHello = socket?.sent.length === 1;
            }),
          },
          makeWebSocket,
        ).pipe(Effect.provideService(RunnerRuntime, runtime)),
      );

      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(authorization, "Bearer runner-secret");
      assert.isTrue(openedAfterHello);
      assert.deepStrictEqual(socket?.sent, [
        encodeRunnerFrame({
          _tag: "RunnerHello",
          version: 2,
          runner: "runner-a",
        }),
        encodeRunnerFrame(response(first)),
        encodeRunnerFrame(response(second)),
        encodeRunnerFrame({
          _tag: "RunnerProbeAck",
          version: 2,
          probeId: "probe-1",
        }),
        encodeRunnerFrame({
          _tag: "HttpFailed",
          version: 2,
          streamId: "stream-1",
          code: "request_failed",
        }),
        encodeRunnerFrame({
          _tag: "RunnerProtocolRejected",
          version: 2,
          code: "invalid_message",
        }),
        encodeRunnerFrame({
          _tag: "RunnerProtocolRejected",
          version: 2,
          code: "invalid_message",
        }),
        encodeRunnerFrame({
          _tag: "RunnerProtocolRejected",
          version: 2,
          code: "invalid_message",
        }),
      ]);
      assert.deepStrictEqual(socket?.closeCodes, [1000]);
    }),
  );

  it.effect("keeps the link healthy only with matching heartbeat acknowledgements", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      let socket: FakeWebSocket | undefined;
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        fake.onSend = (data) => {
          const frame = decodeFrame(data);
          if (Result.isSuccess(frame) && Predicate.isTagged("RunnerProbe")(frame.success))
            queueMicrotask(() => {
              fake.receive(
                encodeRunnerRequest({
                  _tag: "RunnerProbeAck",
                  version: 2,
                  probeId: frame.success.probeId,
                }),
              );
            });
        };
        queueMicrotask(() => fake.open());
        return fake;
      };
      const fiber = yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.forkChild);
      yield* Deferred.await(opened);

      yield* TestClock.adjust(15_000);
      yield* Effect.yieldNow;
      assert.isDefined(socket);
      if (socket === undefined) return;
      assert.isTrue(Predicate.isTagged("RunnerProbe")(sentFrame(socket, 1)));
      assert.deepStrictEqual(socket.closeCodes, []);

      yield* TestClock.adjust(15_000);
      yield* Effect.yieldNow;
      assert.isTrue(Predicate.isTagged("RunnerProbe")(sentFrame(socket, 2)));
      assert.deepStrictEqual(socket.closeCodes, []);

      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(socket.closeCodes, [1000]);
    }),
  );

  it.effect("fails a heartbeat after wrong and late acknowledgements", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      let socket: FakeWebSocket | undefined;
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        queueMicrotask(() => fake.open());
        return fake;
      };
      const fiber = yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.forkChild);
      yield* Deferred.await(opened);
      yield* TestClock.adjust(15_000);
      assert.isDefined(socket);
      if (socket === undefined) return;
      const probe = sentFrame(socket, 1);
      assert.isTrue(Predicate.isTagged("RunnerProbe")(probe));
      if (!Predicate.isTagged("RunnerProbe")(probe)) return;

      socket.receive(
        encodeRunnerRequest({
          _tag: "RunnerProbeAck",
          version: 2,
          probeId: "wrong-probe",
        }),
      );
      yield* TestClock.adjust(4_999);
      assert.deepStrictEqual(socket.closeCodes, []);
      yield* TestClock.adjust(1);
      socket.receive(
        encodeRunnerRequest({
          _tag: "RunnerProbeAck",
          version: 2,
          probeId: probe.probeId,
        }),
      );

      assert.isTrue(Result.isFailure(yield* Effect.result(Fiber.join(fiber))));
      assert.deepStrictEqual(socket.closeCodes, [1011, 1000]);
    }),
  );

  it.effect("heartbeats while an operation remains pending", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      let socket: FakeWebSocket | undefined;
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        queueMicrotask(() => fake.open());
        return fake;
      };
      const pendingRuntime = RunnerRuntime.of({
        handle: () => Effect.never,
      });
      const fiber = yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, pendingRuntime), Effect.forkChild);
      yield* Deferred.await(opened);
      assert.isDefined(socket);
      if (socket === undefined) return;
      socket.receive(encodeRunnerRequest(inspect("pending-operation")));

      yield* TestClock.adjust(15_000);
      const probe = sentFrame(socket, 1);
      assert.isTrue(Predicate.isTagged("RunnerProbe")(probe));
      if (!Predicate.isTagged("RunnerProbe")(probe)) return;
      socket.receive(
        encodeRunnerRequest({
          _tag: "RunnerProbeAck",
          version: 2,
          probeId: probe.probeId,
        }),
      );
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(socket.closeCodes, []);

      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(socket.closeCodes, [1000]);
    }),
  );

  it.effect("reconnects after a missed heartbeat acknowledgement", () =>
    Effect.gen(function* () {
      const sockets: FakeWebSocket[] = [];
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        sockets.push(fake);
        queueMicrotask(() => fake.open());
        return fake;
      };
      const connect: RunnerConnector<RunnerRuntime> = (config) =>
        runRunnerLinkWith(config, makeWebSocket);
      const supervisor = yield* runRunnerSupervisorWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
        },
        connect,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.forkChild);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(15_000);
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(sockets[0]?.closeCodes, [1011, 1000]);
      yield* TestClock.adjust(999);
      assert.strictEqual(sockets.length, 1);
      yield* TestClock.adjust(1);
      assert.strictEqual(sockets.length, 2);

      yield* Fiber.interrupt(supervisor);
      assert.deepStrictEqual(sockets[1]?.closeCodes, [1000]);
    }),
  );

  it.effect("reconnects after a remote clean close", () =>
    Effect.gen(function* () {
      const sockets: FakeWebSocket[] = [];
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        sockets.push(fake);
        fake.onSend = (data) => {
          const frame = decodeFrame(data);
          if (
            sockets.length === 1 &&
            Result.isSuccess(frame) &&
            Predicate.isTagged("RunnerHello")(frame.success)
          )
            queueMicrotask(() => fake.remoteClose(1000));
        };
        queueMicrotask(() => fake.open());
        return fake;
      };
      const connect: RunnerConnector<RunnerRuntime> = (config) =>
        runRunnerLinkWith(config, makeWebSocket);
      const supervisor = yield* runRunnerSupervisorWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
        },
        connect,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(999);
      assert.strictEqual(sockets.length, 1);
      yield* TestClock.adjust(1);
      assert.strictEqual(sockets.length, 2);

      yield* Fiber.interrupt(supervisor);
      assert.deepStrictEqual(sockets[1]?.closeCodes, [1000]);
    }),
  );

  it.effect("closes normally on interruption and sanitizes constructor failures", () =>
    Effect.gen(function* () {
      const opened = Promise.withResolvers<void>();
      let socket: FakeWebSocket | undefined;
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        queueMicrotask(() => {
          fake.open();
          opened.resolve();
        });
        return fake;
      };
      const fiber = yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.forkChild);
      yield* Effect.promise(() => opened.promise);
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(socket?.closeCodes, [1000]);

      const insecure = yield* Effect.result(
        runRunnerLinkWith(
          {
            url: "ws://control.test/runner",
            runnerName: "runner-a",
            token: "runner-secret",
          },
          makeWebSocket,
        ).pipe(Effect.provideService(RunnerRuntime, runtime)),
      );
      assert.isTrue(Result.isFailure(insecure));

      const failed = yield* Effect.result(
        runRunnerLinkWith(
          {
            url: "wss://control.test/runner",
            runnerName: "runner-a",
            token: "runner-secret",
          },
          () => {
            // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: simulate a throwing host constructor.
            throw new Error("runner-secret");
          },
        ).pipe(Effect.provideService(RunnerRuntime, runtime)),
      );
      assert.isTrue(Result.isFailure(failed));
      const failure = Result.merge(failed);
      assert.instanceOf(failure, RunnerLinkError);
      assert.isFalse(JSON.stringify(failure).includes("runner-secret"));
    }),
  );

  it.effect("reconnects with exponential delays capped at thirty seconds", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const connect: RunnerConnector = () =>
        Effect.gen(function* () {
          attempts += 1;
          if (attempts === 7) return;
          return yield* new RunnerLinkError({ reason: "socket_failed" });
        });
      const supervisor = yield* runRunnerSupervisorWith(
        {
          url: "wss://control.test/runner",
          runnerName: "runner-a",
          token: "runner-secret",
        },
        connect,
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.strictEqual(attempts, 1);
      let expectedAttempts = 1;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
        yield* TestClock.adjust(delay - 1);
        assert.strictEqual(attempts, expectedAttempts);
        yield* TestClock.adjust(1);
        expectedAttempts += 1;
        assert.strictEqual(attempts, expectedAttempts);
      }
      assert.strictEqual(attempts, 7);
      yield* Fiber.join(supervisor);
    }),
  );

  it.effect("resets backoff after a connection opens", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const connect: RunnerConnector = (config) =>
        Effect.gen(function* () {
          attempts += 1;
          if (attempts === 3) yield* config.onOpen ?? Effect.void;
          if (attempts === 4) return;
          return yield* new RunnerLinkError({ reason: "socket_failed" });
        });
      const supervisor = yield* runRunnerSupervisorWith(
        {
          url: "wss://control.test/runner",
          runnerName: "runner-a",
          token: "runner-secret",
        },
        connect,
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.strictEqual(attempts, 1);
      yield* TestClock.adjust(1_000);
      assert.strictEqual(attempts, 2);
      yield* TestClock.adjust(2_000);
      assert.strictEqual(attempts, 3);
      yield* TestClock.adjust(999);
      assert.strictEqual(attempts, 3);
      yield* TestClock.adjust(1);
      assert.strictEqual(attempts, 4);
      yield* Fiber.join(supervisor);
    }),
  );

  it.effect("serves a sanitized GET from fixed loopback and streams credited SSE chunks", () =>
    Effect.gen(function* () {
      let socket: FakeWebSocket | undefined;
      let capturedIdentity: { sessionId: string; runtimeId: string } | undefined;
      let capturedRequest: Request | undefined;
      const received: Array<Uint8Array> = [];
      const handler: RunnerHttpHandler = (identity, request) =>
        Effect.sync(() => {
          capturedIdentity = identity;
          capturedRequest = request;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"));
                controller.enqueue(new TextEncoder().encode("data: second\n\n"));
                controller.close();
              },
            }),
            {
              status: 200,
              headers: {
                connection: "x-remove-me",
                "content-type": "text/event-stream",
                "set-cookie": "runtime=secret",
                "x-remove-me": "hop-by-hop",
              },
            },
          );
        });
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        fake.onSend = (text) => {
          const frame = decodeFrame(text);
          if (Result.isFailure(frame)) return;
          if (Predicate.isTagged("RunnerHello")(frame.success)) {
            queueMicrotask(() =>
              fake.receive(
                encodeRunnerRequest(
                  openHttp({
                    headers: [
                      ["authorization", "Bearer browser-secret"],
                      ["content-type", "text/plain"],
                      ["cookie", "browser=secret"],
                    ],
                    target: "/s/session-a/events?after=1",
                  }),
                ),
              ),
            );
          } else if (Predicate.isTagged("HttpData")(frame.success)) {
            const bytes = decodeBase64(frame.success.data);
            received.push(bytes);
            fake.receive(
              encodeRunnerRequest({
                _tag: "HttpCredit",
                version: 2,
                streamId: frame.success.streamId,
                direction: "response",
                credit: bytes.byteLength,
              }),
            );
          } else if (Predicate.isTagged("HttpEnd")(frame.success)) {
            fake.remoteClose(1000);
          }
        };
        queueMicrotask(() => fake.open());
        return fake;
      };

      yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          httpHandler: handler,
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.flip);

      assert.deepStrictEqual(capturedIdentity, {
        sessionId: "session-a",
        runtimeId: "runtime-a",
      });
      assert.strictEqual(capturedRequest?.url, "http://127.0.0.1:31415/s/session-a/events?after=1");
      assert.strictEqual(capturedRequest?.headers.get("content-type"), "text/plain");
      assert.strictEqual(capturedRequest?.headers.get("authorization"), null);
      assert.strictEqual(capturedRequest?.headers.get("cookie"), null);
      assert.strictEqual(
        new TextDecoder().decode(concatenate(received)),
        "data: first\n\ndata: second\n\n",
      );
      const responseIndex =
        socket?.sent
          .map((_, index) => sentFrame(socket, index))
          .findIndex((frame) => Predicate.isTagged("HttpResponse")(frame)) ?? -1;
      assert.notStrictEqual(responseIndex, -1);
      const response = decodeHttpResponse(socket?.sent[responseIndex] ?? "");
      assert.deepStrictEqual(response.headers, [["content-type", "text/event-stream"]]);
    }),
  );

  it.effect("streams a credited POST body into the per-session handler", () =>
    Effect.gen(function* () {
      let socket: FakeWebSocket | undefined;
      let body = "";
      let requestUrl = "";
      const handler: RunnerHttpHandler = (_identity, request) =>
        Effect.tryPromise({
          try: async () => {
            requestUrl = request.url;
            body = await request.text();
            return new Response("accepted", { status: 202 });
          },
          catch: () => undefined,
        });
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        let sentBody = false;
        fake.onSend = (text) => {
          const frame = decodeFrame(text);
          if (Result.isFailure(frame)) return;
          if (Predicate.isTagged("RunnerHello")(frame.success)) {
            queueMicrotask(() =>
              fake.receive(
                encodeRunnerRequest(
                  openHttp({
                    method: "POST",
                    target: "/s/session-a/api",
                    headers: [["content-type", "text/plain"]],
                    hasBody: true,
                  }),
                ),
              ),
            );
          } else if (
            Predicate.isTagged("HttpCredit")(frame.success) &&
            frame.success.direction === "request" &&
            !sentBody
          ) {
            sentBody = true;
            fake.receive(
              encodeRunnerRequest({
                _tag: "HttpData",
                version: 2,
                streamId: frame.success.streamId,
                direction: "request",
                data: encodeBase64(new TextEncoder().encode("hello runner")),
              }),
            );
            fake.receive(
              encodeRunnerRequest({
                _tag: "HttpEnd",
                version: 2,
                streamId: frame.success.streamId,
                direction: "request",
              }),
            );
          } else if (Predicate.isTagged("HttpEnd")(frame.success)) {
            fake.remoteClose(1000);
          }
        };
        queueMicrotask(() => fake.open());
        return fake;
      };

      yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          httpHandler: handler,
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.flip);

      assert.strictEqual(requestUrl, "http://127.0.0.1:31415/s/session-a/api");
      assert.strictEqual(body, "hello runner");
      assert.isTrue(
        socket?.sent.some((_, index) =>
          Predicate.isTagged("HttpResponse")(sentFrame(socket, index)),
        ),
      );
    }),
  );

  it.effect("cancels an active response and closes malformed stream identity", () =>
    Effect.gen(function* () {
      let cancelled = false;
      let socket: FakeWebSocket | undefined;
      const handler: RunnerHttpHandler = () =>
        Effect.succeed(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
          ),
        );
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        fake.onSend = (text) => {
          const frame = decodeFrame(text);
          if (Result.isFailure(frame)) return;
          if (Predicate.isTagged("RunnerHello")(frame.success)) {
            queueMicrotask(() => fake.receive(encodeRunnerRequest(openHttp())));
          } else if (Predicate.isTagged("HttpResponse")(frame.success)) {
            fake.receive(
              encodeRunnerRequest({
                _tag: "HttpCancel",
                version: 2,
                streamId: frame.success.streamId,
                direction: "both",
              }),
            );
            queueMicrotask(() => fake.remoteClose(1000));
          }
        };
        queueMicrotask(() => fake.open());
        return fake;
      };
      yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          httpHandler: handler,
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.flip);
      assert.isTrue(cancelled);
      assert.deepStrictEqual(socket?.closeCodes, [1000]);

      let malformedSocket: FakeWebSocket | undefined;
      const malformed = yield* Effect.result(
        runRunnerLinkWith(
          {
            url: "ws://127.0.0.1/runner",
            runnerName: "runner-a",
            token: "runner-secret",
            httpHandler: handler,
          },
          (url) => {
            const fake = new FakeWebSocket(url);
            malformedSocket = fake;
            fake.onSend = (text) => {
              const frame = decodeFrame(text);
              if (Result.isSuccess(frame) && Predicate.isTagged("RunnerHello")(frame.success)) {
                queueMicrotask(() =>
                  fake.receive(
                    encodeRunnerRequest({
                      _tag: "HttpData",
                      version: 2,
                      streamId: "unknown",
                      direction: "request",
                      data: "AQ==",
                    }),
                  ),
                );
              }
            };
            queueMicrotask(() => fake.open());
            return fake;
          },
        ).pipe(Effect.provideService(RunnerRuntime, runtime)),
      );
      assert.isTrue(Result.isFailure(malformed));
      assert.deepStrictEqual(malformedSocket?.closeCodes, [1008, 1000]);
    }),
  );

  it.effect("ignores late response credit after HttpEnd and keeps the link usable", () =>
    Effect.gen(function* () {
      let socket: FakeWebSocket | undefined;
      let completed = 0;
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        fake.onSend = (text) => {
          const frame = decodeFrame(text);
          if (Result.isFailure(frame)) return;
          if (Predicate.isTagged("RunnerHello")(frame.success)) {
            queueMicrotask(() => fake.receive(encodeRunnerRequest(openHttp())));
          } else if (Predicate.isTagged("HttpEnd")(frame.success)) {
            completed += 1;
            if (completed === 1) {
              fake.receive(
                encodeRunnerRequest({
                  _tag: "HttpCredit",
                  version: 2,
                  streamId: frame.success.streamId,
                  direction: "response",
                  credit: 1,
                }),
              );
              fake.receive(
                encodeRunnerRequest(openHttp({ streamId: "stream-2", target: "/second" })),
              );
            } else fake.remoteClose(1000);
          }
        };
        queueMicrotask(() => fake.open());
        return fake;
      };

      yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          httpHandler: () => Effect.succeed(new Response("x")),
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.flip);

      assert.strictEqual(completed, 2);
      assert.deepStrictEqual(socket?.closeCodes, [1000]);
    }),
  );

  it.effect("reports oversized pre-response headers per stream without closing the link", () =>
    Effect.gen(function* () {
      let socket: FakeWebSocket | undefined;
      let failedCode: string | undefined;
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        fake.onSend = (text) => {
          const frame = decodeFrame(text);
          if (Result.isFailure(frame)) return;
          if (Predicate.isTagged("RunnerHello")(frame.success)) {
            queueMicrotask(() => fake.receive(encodeRunnerRequest(openHttp())));
          } else if (Predicate.isTagged("HttpFailed")(frame.success)) {
            failedCode = frame.success.code;
            fake.receive(
              encodeRunnerRequest(openHttp({ streamId: "stream-2", target: "/healthy" })),
            );
          } else if (
            Predicate.isTagged("HttpResponse")(frame.success) &&
            frame.success.streamId === "stream-2"
          )
            fake.remoteClose(1000);
        };
        queueMicrotask(() => fake.open());
        return fake;
      };

      yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          httpHandler: (_identity, request) =>
            Effect.succeed(
              request.url.endsWith("/healthy")
                ? new Response(null, { status: 204 })
                : new Response(null, { headers: { "x-oversized": "x".repeat(65_537) } }),
            ),
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.flip);

      assert.strictEqual(failedCode, "request_failed");
      assert.isFalse(socket?.closeCodes.includes(1008));
      assert.deepStrictEqual(socket?.closeCodes, [1000]);
    }),
  );

  it.effect("bounds concurrent streams per session while admitting another session", () =>
    Effect.gen(function* () {
      let socket: FakeWebSocket | undefined;
      let accepted = 0;
      let limitFailed = false;
      const handler: RunnerHttpHandler = () => Effect.never;
      const makeWebSocket: RunnerWebSocketConstructor = (url) => {
        const fake = new FakeWebSocket(url);
        socket = fake;
        const sendOpen = (sessionId: string, index: number) =>
          fake.receive(
            encodeRunnerRequest(
              openHttp({
                streamId: `${sessionId}-${index}`,
                sessionId,
                runtimeId: `runtime-${sessionId}`,
                method: "POST",
                target: `/${index}`,
                hasBody: true,
              }),
            ),
          );
        fake.onSend = (text) => {
          const frame = decodeFrame(text);
          if (Result.isFailure(frame)) return;
          if (Predicate.isTagged("RunnerHello")(frame.success)) {
            queueMicrotask(() => sendOpen("session-a", 0));
          } else if (
            Predicate.isTagged("HttpCredit")(frame.success) &&
            frame.success.direction === "request"
          ) {
            accepted += 1;
            if (accepted < 16) sendOpen("session-a", accepted);
            else if (accepted === 16) sendOpen("session-b", 0);
            else if (accepted === 17) sendOpen("session-a", 16);
          } else if (Predicate.isTagged("HttpFailed")(frame.success)) {
            limitFailed = true;
            for (let index = 0; index < 16; index += 1) {
              fake.receive(
                encodeRunnerRequest({
                  _tag: "HttpCancel",
                  version: 2,
                  streamId: `session-a-${index}`,
                  direction: "both",
                }),
              );
            }
            fake.receive(
              encodeRunnerRequest({
                _tag: "HttpCancel",
                version: 2,
                streamId: "session-b-0",
                direction: "both",
              }),
            );
            queueMicrotask(() => fake.remoteClose(1000));
          }
        };
        queueMicrotask(() => fake.open());
        return fake;
      };

      yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          httpHandler: handler,
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime), Effect.flip);

      assert.strictEqual(accepted, 17);
      assert.isTrue(limitFailed);
      assert.deepStrictEqual(socket?.closeCodes, [1000]);
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

function concatenate(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
