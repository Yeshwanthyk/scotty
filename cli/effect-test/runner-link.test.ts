import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  encodeRunnerFrame,
  encodeRunnerRequest,
  type InspectRuntime,
  type RunnerResponse,
} from "../../protocol/runner";
import {
  RunnerLinkError,
  runRunnerLinkWith,
  runRunnerSupervisorWith,
  type RunnerConnector,
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

      yield* runRunnerLinkWith(
        {
          url: "ws://127.0.0.1/runner",
          runnerName: "runner-a",
          token: "runner-secret",
          onOpen: Effect.sync(() => {
            openedAfterHello = socket?.sent.length === 1;
          }),
        },
        makeWebSocket,
      ).pipe(Effect.provideService(RunnerRuntime, runtime));

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
        encodeRunnerFrame({
          _tag: "RunnerProtocolRejected",
          version: 2,
          code: "invalid_message",
        }),
      ]);
      assert.deepStrictEqual(socket?.closeCodes, [1000]);
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
});
