import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  Scope,
} from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import {
  RUNNER_CREDIT_WINDOW,
  RUNNER_DATA_CHUNK_LIMIT,
  RUNNER_HEADER_BYTES_LIMIT,
  RUNNER_HEADER_COUNT_LIMIT,
  RUNNER_REQUEST_BODY_LIMIT,
  RUNNER_STREAMS_PER_LINK_LIMIT,
  RUNNER_STREAMS_PER_SESSION_LIMIT,
  decodeRunnerRequestText,
  encodeRunnerFrame,
  type HeaderPair,
  type HttpCancel,
  type HttpCredit,
  type HttpData,
  type HttpOpen,
  type RunnerFrame,
} from "../../protocol/runner";
import { RunnerRuntime } from "./runner-runtime";

const MAX_RUNNER_MESSAGE_CHARACTERS = 256 * 1024;
const RUNNER_RECONNECT_BASE_MILLIS = 1_000;
const RUNNER_RECONNECT_MAX_MILLIS = 30_000;
const RUNNER_RECONNECT_MAX_STEP = 6;
const RUNNER_HEARTBEAT_INTERVAL_MILLIS = 15_000;
const RUNNER_HEARTBEAT_ACK_TIMEOUT_MILLIS = 5_000;
const RECENT_TERMINAL_STREAM_LIMIT = 256;
const RUNNER_HTTP_ORIGIN = "http://127.0.0.1:31415";
const HTTP_REQUEST_HEADERS_TO_STRIP = [
  "authorization",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-pican-proxy-token",
] as const;
const HTTP_RESPONSE_HEADERS_TO_STRIP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

export interface RunnerHttpIdentity {
  readonly runtimeId: string;
  readonly sessionId: string;
}

export type RunnerHttpHandler = (
  identity: RunnerHttpIdentity,
  request: Request,
) => Effect.Effect<Response, unknown>;

export interface RunnerLinkConfig {
  readonly url: string;
  readonly runnerName: string;
  readonly token: string;
  readonly httpHandler?: RunnerHttpHandler;
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
  version: 2,
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
    { closeCodeIsError: () => true },
  );

interface ActiveHttpStream {
  readonly abort: AbortController;
  readonly open: HttpOpen;
  readonly requestController: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly responseCredits: Queue.Queue<number>;
  fiber: Fiber.Fiber<void, unknown> | undefined;
  requestBytes: number;
  requestCredit: number;
  requestEnded: boolean;
  requestUncredited: number;
  responseCredit: number;
  responseEnded: boolean;
  responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  responseStarted: boolean;
}

// Piece 3 owns resolving a session runtime to a live loopback listener. Until then,
// callers must inject that narrow host adapter rather than falling through to the
// runner process's unrelated loopback services.
const defaultHttpHandler: RunnerHttpHandler = () => Effect.fail(undefined);

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
      const linkScope = yield* Scope.Scope;
      let pendingHeartbeat:
        | {
            readonly probeId: string;
            readonly acknowledged: Deferred.Deferred<void>;
          }
        | undefined;
      const streams = new Map<string, ActiveHttpStream>();
      const recentTerminalStreams = new Set<string>();
      const httpHandler = config.httpHandler ?? defaultHttpHandler;

      const send = (frame: RunnerFrame) => write(encodeRunnerFrame(frame));
      const closeProtocol = () =>
        write(new Socket.CloseEvent(1008, "Invalid runner HTTP sequence"));
      const cleanup = (pending: ActiveHttpStream, interrupt: boolean) =>
        Effect.gen(function* () {
          if (streams.get(pending.open.streamId) !== pending) return;
          streams.delete(pending.open.streamId);
          recentTerminalStreams.delete(pending.open.streamId);
          recentTerminalStreams.add(pending.open.streamId);
          if (recentTerminalStreams.size > RECENT_TERMINAL_STREAM_LIMIT) {
            const oldest = recentTerminalStreams.values().next().value;
            if (oldest !== undefined) recentTerminalStreams.delete(oldest);
          }
          pending.abort.abort();
          if (!pending.requestEnded) {
            pending.requestEnded = true;
            // oxlint-disable-next-line scotty/no-error-constructor -- boundary: native loopback ReadableStream cancellation.
            pending.requestController?.error(new TypeError("Runner HTTP request cancelled"));
          }
          const reader = pending.responseReader;
          if (reader !== undefined)
            yield* Effect.tryPromise({
              try: () => reader.cancel(),
              catch: () => undefined,
            }).pipe(Effect.ignore);
          if (interrupt && pending.fiber !== undefined) yield* Fiber.interrupt(pending.fiber);
        });
      const cleanupAll = Effect.suspend(() =>
        Effect.forEach(Array.from(streams.values()), (pending) => cleanup(pending, true), {
          discard: true,
        }),
      );
      const protocolViolation = (pending?: ActiveHttpStream) =>
        Effect.gen(function* () {
          if (pending !== undefined) yield* cleanup(pending, true);
          yield* closeProtocol();
        });
      const sendRequestCredit = (streamId: string) =>
        Effect.gen(function* () {
          const pending = streams.get(streamId);
          if (pending === undefined || pending.requestEnded || pending.requestUncredited === 0)
            return;
          const credit = pending.requestUncredited;
          pending.requestUncredited = 0;
          pending.requestCredit += credit;
          yield* send({
            _tag: "HttpCredit",
            version: 2,
            streamId,
            direction: "request",
            credit,
          });
        });
      const cancelRequestByConsumer = (streamId: string) =>
        Effect.gen(function* () {
          const pending = streams.get(streamId);
          if (pending === undefined || pending.requestEnded) return;
          pending.requestEnded = true;
          yield* send({
            _tag: "HttpCancel",
            version: 2,
            streamId,
            direction: "request",
          });
        });
      const failHttp = (pending: ActiveHttpStream, code: "request_failed" | "response_failed") =>
        Effect.gen(function* () {
          if (streams.get(pending.open.streamId) !== pending) return;
          yield* send({
            _tag: "HttpFailed",
            version: 2,
            streamId: pending.open.streamId,
            code,
          });
          yield* cleanup(pending, false);
        });
      const pumpResponse = (pending: ActiveHttpStream, response: Response) =>
        Effect.gen(function* () {
          const headers = responseHeaderPairs(response.headers);
          if (headers === undefined) {
            yield* failHttp(pending, "request_failed");
            return;
          }
          pending.responseStarted = true;
          const reader = response.body?.getReader();
          pending.responseReader = reader;
          yield* send({
            _tag: "HttpResponse",
            version: 2,
            streamId: pending.open.streamId,
            status: response.status,
            statusText: response.statusText,
            headers,
            hasBody: response.body !== null,
          });
          if (reader === undefined) return;
          let available = 0;
          while (!pending.responseEnded && streams.get(pending.open.streamId) === pending) {
            const read = yield* Effect.result(
              Effect.tryPromise({
                try: () => reader.read(),
                catch: () => undefined,
              }),
            );
            if (Result.isFailure(read)) {
              yield* failHttp(pending, "response_failed");
              return;
            }
            if (read.success.done) {
              pending.responseEnded = true;
              yield* send({
                _tag: "HttpEnd",
                version: 2,
                streamId: pending.open.streamId,
                direction: "response",
              });
              return;
            }
            const responseChunk = read.success.value;
            if (responseChunk === undefined) {
              yield* failHttp(pending, "response_failed");
              return;
            }
            let offset = 0;
            while (
              offset < responseChunk.byteLength &&
              streams.get(pending.open.streamId) === pending
            ) {
              if (available === 0) available = yield* Queue.take(pending.responseCredits);
              const size = Math.min(
                RUNNER_DATA_CHUNK_LIMIT,
                available,
                responseChunk.byteLength - offset,
              );
              const chunk = responseChunk.subarray(offset, offset + size);
              available -= size;
              pending.responseCredit -= size;
              offset += size;
              yield* send({
                _tag: "HttpData",
                version: 2,
                streamId: pending.open.streamId,
                direction: "response",
                data: encodeBase64(chunk),
              });
            }
          }
        });
      const runHttp = (pending: ActiveHttpStream, request: Request) =>
        Effect.gen(function* () {
          const handled = yield* Effect.result(
            httpHandler(
              {
                sessionId: pending.open.sessionId,
                runtimeId: pending.open.runtimeId,
              },
              request,
            ),
          );
          if (Result.isFailure(handled)) {
            yield* failHttp(pending, "request_failed");
            return;
          }
          yield* pumpResponse(pending, sanitizeResponse(handled.success));
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              streams.get(pending.open.streamId) === pending
                ? cleanup(pending, false)
                : Effect.void,
            ),
          ),
        );
      const openHttp = (open: HttpOpen) =>
        Effect.gen(function* () {
          if (streams.has(open.streamId)) {
            yield* closeProtocol();
            return;
          }
          if (
            streams.size >= RUNNER_STREAMS_PER_LINK_LIMIT ||
            sessionStreamCount(streams, open.sessionId) >= RUNNER_STREAMS_PER_SESSION_LIMIT
          ) {
            yield* send({
              _tag: "HttpFailed",
              version: 2,
              streamId: open.streamId,
              code: "request_failed",
            });
            return;
          }
          const target = loopbackTarget(open.target);
          if (
            Result.isFailure(target) ||
            ((open.method === "GET" || open.method === "HEAD") && open.hasBody)
          ) {
            yield* closeProtocol();
            return;
          }
          const headers = requestHeaders(open.headers);
          if (Result.isFailure(headers)) {
            yield* closeProtocol();
            return;
          }

          let requestController: ReadableStreamDefaultController<Uint8Array> | undefined;
          const requestBody = open.hasBody
            ? new ReadableStream<Uint8Array>(
                {
                  start: (controller) => {
                    requestController = controller;
                  },
                  pull: () => {
                    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: native loopback request-stream backpressure callback.
                    return Effect.runPromise(sendRequestCredit(open.streamId));
                  },
                  cancel: () => {
                    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: native loopback request-stream cancellation callback.
                    return Effect.runPromise(cancelRequestByConsumer(open.streamId));
                  },
                },
                {
                  highWaterMark: 0,
                  size: (chunk) => chunk?.byteLength ?? 0,
                },
              )
            : undefined;
          if (open.hasBody && requestController === undefined) {
            yield* closeProtocol();
            return;
          }
          const abort = new AbortController();
          const requestResult = Result.try({
            try: () =>
              new Request(target.success, {
                method: open.method,
                headers: headers.success,
                body: requestBody,
                redirect: "manual",
                signal: abort.signal,
                ...(requestBody === undefined ? {} : { duplex: "half" as const }),
              }),
            catch: () => undefined,
          });
          if (Result.isFailure(requestResult)) {
            yield* closeProtocol();
            return;
          }

          const responseCredits = yield* Queue.make<number>();
          yield* Queue.offer(responseCredits, open.responseCredit);
          const pending: ActiveHttpStream = {
            abort,
            open,
            requestController,
            responseCredits,
            fiber: undefined,
            requestBytes: 0,
            requestCredit: open.hasBody ? RUNNER_CREDIT_WINDOW : 0,
            requestEnded: !open.hasBody,
            requestUncredited: 0,
            responseCredit: open.responseCredit,
            responseEnded: false,
            responseReader: undefined,
            responseStarted: false,
          };
          streams.set(open.streamId, pending);
          if (open.hasBody)
            yield* send({
              _tag: "HttpCredit",
              version: 2,
              streamId: open.streamId,
              direction: "request",
              credit: RUNNER_CREDIT_WINDOW,
            });
          pending.fiber = yield* runHttp(pending, requestResult.success).pipe(
            Effect.forkIn(linkScope),
          );
        });
      const receiveData = (frame: HttpData) =>
        Effect.gen(function* () {
          const pending = streams.get(frame.streamId);
          if (pending === undefined && recentTerminalStreams.has(frame.streamId)) return;
          const data = decodeBase64(frame.data);
          if (
            pending === undefined ||
            frame.direction !== "request" ||
            !pending.open.hasBody ||
            pending.requestEnded ||
            pending.requestController === undefined ||
            data.byteLength > pending.requestCredit ||
            pending.requestBytes + data.byteLength > RUNNER_REQUEST_BODY_LIMIT
          ) {
            yield* protocolViolation(pending);
            return;
          }
          pending.requestCredit -= data.byteLength;
          pending.requestBytes += data.byteLength;
          pending.requestUncredited += data.byteLength;
          pending.requestController.enqueue(data);
        });
      const receiveEnd = (streamId: string) =>
        Effect.gen(function* () {
          const pending = streams.get(streamId);
          if (pending === undefined && recentTerminalStreams.has(streamId)) return;
          if (
            pending === undefined ||
            !pending.open.hasBody ||
            pending.requestEnded ||
            pending.requestController === undefined
          ) {
            yield* protocolViolation(pending);
            return;
          }
          pending.requestEnded = true;
          pending.requestController.close();
        });
      const receiveCredit = (frame: HttpCredit) =>
        Effect.gen(function* () {
          const pending = streams.get(frame.streamId);
          if (pending === undefined && recentTerminalStreams.has(frame.streamId)) return;
          if (pending?.responseEnded === true && frame.direction === "response") return;
          if (
            pending === undefined ||
            frame.direction !== "response" ||
            pending.responseEnded ||
            pending.responseCredit + frame.credit > RUNNER_CREDIT_WINDOW
          ) {
            yield* protocolViolation(pending);
            return;
          }
          pending.responseCredit += frame.credit;
          yield* Queue.offer(pending.responseCredits, frame.credit);
        });
      const receiveCancel = (frame: HttpCancel) =>
        Effect.gen(function* () {
          const pending = streams.get(frame.streamId);
          if (pending === undefined) {
            if (recentTerminalStreams.has(frame.streamId)) return;
            yield* closeProtocol();
            return;
          }
          if (frame.direction === "request") {
            if (!pending.open.hasBody || pending.requestEnded) {
              yield* protocolViolation(pending);
              return;
            }
            pending.requestEnded = true;
            // oxlint-disable-next-line scotty/no-error-constructor -- boundary: native loopback ReadableStream remote cancellation.
            pending.requestController?.error(new TypeError("Runner HTTP request cancelled"));
            return;
          }
          yield* cleanup(pending, true);
        });
      const heartbeat = Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(RUNNER_HEARTBEAT_INTERVAL_MILLIS);
          const probeId = crypto.randomUUID();
          const acknowledged = yield* Deferred.make<void>();
          const pending = { probeId, acknowledged };
          pendingHeartbeat = pending;
          yield* send({
            _tag: "RunnerProbe",
            version: 2,
            probeId,
          });
          const result = yield* Deferred.await(acknowledged).pipe(
            Effect.timeoutOption(RUNNER_HEARTBEAT_ACK_TIMEOUT_MILLIS),
          );
          if (pendingHeartbeat === pending) pendingHeartbeat = undefined;
          if (Option.isSome(result)) return;
          yield* write(new Socket.CloseEvent(1011, "Runner heartbeat timed out"));
          return yield* Deferred.fail(
            announceFailure,
            socketOpenError("Runner heartbeat timed out"),
          );
        }),
      );
      const handleMessage = (message: string | Uint8Array) =>
        typeof message !== "string" || message.length > MAX_RUNNER_MESSAGE_CHARACTERS
          ? send(rejected)
          : Effect.gen(function* () {
              const decoded = yield* Effect.result(decodeRunnerRequestText(message));
              if (Result.isFailure(decoded)) {
                return yield* send(rejected);
              }
              if (Predicate.isTagged("RunnerProbeAck")(decoded.success)) {
                const pending = pendingHeartbeat;
                if (pending?.probeId === decoded.success.probeId)
                  yield* Deferred.succeed(pending.acknowledged, undefined);
                return;
              }
              if (Predicate.isTagged("RunnerProbe")(decoded.success))
                return yield* send({
                  _tag: "RunnerProbeAck",
                  version: 2,
                  probeId: decoded.success.probeId,
                });
              if (Predicate.isTagged("HttpOpen")(decoded.success))
                return yield* openHttp(decoded.success);
              if (Predicate.isTagged("HttpData")(decoded.success))
                return yield* receiveData(decoded.success);
              if (Predicate.isTagged("HttpEnd")(decoded.success))
                return yield* receiveEnd(decoded.success.streamId);
              if (Predicate.isTagged("HttpCredit")(decoded.success))
                return yield* receiveCredit(decoded.success);
              if (Predicate.isTagged("HttpCancel")(decoded.success))
                return yield* receiveCancel(decoded.success);
              const response = yield* runtime.handle(decoded.success);
              return yield* send(response);
            });

      const announce = send({
        _tag: "RunnerHello",
        version: 2,
        runner: config.runnerName,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) => Deferred.fail(announceFailure, error).pipe(Effect.asVoid),
          onSuccess: () =>
            heartbeat
              .pipe(Effect.forkIn(linkScope))
              .pipe(Effect.andThen(config.onOpen ?? Effect.void), Effect.asVoid),
        }),
      );

      return yield* Effect.raceFirst(
        socket.runRaw(handleMessage, { onOpen: announce }),
        Deferred.await(announceFailure),
      ).pipe(Effect.ensuring(cleanupAll));
    }),
  ).pipe(Effect.mapError(() => new RunnerLinkError({ reason: "socket_failed" })));
});

export const runRunnerLink = (config: RunnerLinkConfig) =>
  runRunnerLinkWith(config, makeBunWebSocket);

export type RunnerConnector<R = never> = (
  config: RunnerLinkConfig,
) => Effect.Effect<void, RunnerLinkError, R>;

const reconnectDelay = (step: number): Duration.Duration =>
  Duration.millis(
    Math.min(
      RUNNER_RECONNECT_MAX_MILLIS,
      RUNNER_RECONNECT_BASE_MILLIS * 2 ** Math.max(0, step - 1),
    ),
  );

export const runRunnerSupervisorWith = Effect.fnUntraced(function* <R>(
  config: RunnerLinkConfig,
  connect: RunnerConnector<R>,
) {
  let backoffStep = 0;
  while (true) {
    let opened = false;
    const result = yield* Effect.result(
      connect({
        ...config,
        onOpen: Effect.sync(() => {
          opened = true;
        }).pipe(Effect.andThen(config.onOpen ?? Effect.void)),
      }),
    );
    if (Result.isSuccess(result)) return;
    backoffStep = opened ? 0 : Math.min(RUNNER_RECONNECT_MAX_STEP, backoffStep + 1);
    yield* Effect.sleep(reconnectDelay(backoffStep));
  }
});

export const runRunnerSupervisor = (config: RunnerLinkConfig) =>
  runRunnerSupervisorWith(config, runRunnerLink);

function loopbackTarget(target: string): Result.Result<string, undefined> {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("#"))
    return Result.fail(undefined);
  const parsed = Result.try({
    try: () => new URL(target, RUNNER_HTTP_ORIGIN),
    catch: () => undefined,
  });
  return Result.isSuccess(parsed) && parsed.success.origin === RUNNER_HTTP_ORIGIN
    ? Result.succeed(parsed.success.href)
    : Result.fail(undefined);
}

function requestHeaders(pairs: ReadonlyArray<HeaderPair>): Result.Result<Headers, undefined> {
  const result = Result.try({
    try: () => new Headers(pairs.map(([name, value]) => [name, value])),
    catch: () => undefined,
  });
  if (Result.isFailure(result)) return result;
  const headers = result.success;
  for (const name of headers.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  for (const name of HTTP_REQUEST_HEADERS_TO_STRIP) headers.delete(name);
  return Result.succeed(headers);
}

function sanitizeResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of headers.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  for (const name of HTTP_RESPONSE_HEADERS_TO_STRIP) headers.delete(name);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function responseHeaderPairs(headers: Headers): ReadonlyArray<HeaderPair> | undefined {
  const pairs = Array.from(headers.entries());
  if (pairs.length > RUNNER_HEADER_COUNT_LIMIT) return undefined;
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [name, value] of pairs) {
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
    if (bytes > RUNNER_HEADER_BYTES_LIMIT) return undefined;
  }
  return pairs;
}

function sessionStreamCount(
  streams: ReadonlyMap<string, ActiveHttpStream>,
  sessionId: string,
): number {
  let count = 0;
  for (const pending of streams.values()) {
    if (pending.open.sessionId === sessionId) count += 1;
  }
  return count;
}

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
