import { Deferred, Effect, Result, Schema } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { decodeRunnerOperationText, encodeRunnerFrame, type RunnerFrame } from "./runner-protocol";
import { RunnerRuntime } from "./runner-runtime";

const MAX_RUNNER_MESSAGE_CHARACTERS = 256 * 1024;

export interface RunnerLinkConfig {
  readonly url: string;
  readonly runnerName: string;
  readonly token: string;
  readonly onOpen?: Effect.Effect<void>;
}

export class RunnerLinkError extends Schema.TaggedErrorClass<RunnerLinkError>("RunnerLinkError")(
  "RunnerLinkError",
  {
    reason: Schema.Literal("socket_failed"),
  },
) {
  override readonly message = "Runner link failed";
}

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "[::1]";

const validateRunnerUrl = (value: string): Result.Result<string, RunnerLinkError> => {
  const parsed = Result.try({
    try: () => new URL(value),
    catch: () => new RunnerLinkError({ reason: "socket_failed" }),
  });
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const url = parsed.success;
  return url.protocol === "wss:" || (url.protocol === "ws:" && isLoopbackHost(url.hostname))
    ? Result.succeed(url.href)
    : Result.fail(new RunnerLinkError({ reason: "socket_failed" }));
};

const rejected: RunnerFrame = {
  _tag: "RunnerProtocolRejected",
  version: 1,
  code: "invalid_message",
};

const socketOpenError = (cause: unknown): Socket.SocketError =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
  });

export type RunnerWebSocketConstructor = (url: string, options: Bun.WebSocketOptions) => WebSocket;

const makeBunWebSocket: RunnerWebSocketConstructor = (url, options) =>
  // boundary: Bun extends the DOM constructor with authenticated upgrade headers.
  new (WebSocket as new (url: string | URL, options?: Bun.WebSocketOptions) => WebSocket)(
    url,
    options,
  );

const makeSocket = (config: RunnerLinkConfig, makeWebSocket: RunnerWebSocketConstructor) =>
  Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          makeWebSocket(config.url, {
            headers: { Authorization: `Bearer ${config.token}` },
          }),
        catch: socketOpenError,
      }),
      (webSocket) =>
        Effect.sync(() => {
          webSocket.close(1000);
        }),
    ),
    { closeCodeIsError: (code) => code !== 1000 },
  );

export const runRunnerLinkWith = Effect.fnUntraced(function* (
  config: RunnerLinkConfig,
  makeWebSocket: RunnerWebSocketConstructor,
) {
  const runtime = yield* RunnerRuntime;
  const url = yield* Effect.fromResult(validateRunnerUrl(config.url));
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* makeSocket({ ...config, url }, makeWebSocket);
      const write = yield* socket.writer;
      const announceFailure = yield* Deferred.make<void, Socket.SocketError>();

      const send = (frame: RunnerFrame) => write(encodeRunnerFrame(frame));
      const handleMessage = (message: string | Uint8Array) =>
        typeof message !== "string" || message.length > MAX_RUNNER_MESSAGE_CHARACTERS
          ? send(rejected)
          : Effect.gen(function* () {
              const decoded = yield* Effect.result(decodeRunnerOperationText(message));
              if (Result.isFailure(decoded)) {
                return yield* send(rejected);
              }
              const response = yield* runtime.handle(decoded.success);
              return yield* send(response);
            });

      const announce = send({
        _tag: "RunnerHello",
        version: 1,
        runner: config.runnerName,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) => Deferred.fail(announceFailure, error).pipe(Effect.asVoid),
          onSuccess: () => config.onOpen ?? Effect.void,
        }),
      );

      return yield* Effect.raceFirst(
        socket.runRaw(handleMessage, { onOpen: announce }),
        Deferred.await(announceFailure),
      );
    }),
  ).pipe(Effect.mapError(() => new RunnerLinkError({ reason: "socket_failed" })));
});

export const runRunnerLink = (config: RunnerLinkConfig) =>
  runRunnerLinkWith(config, makeBunWebSocket);
