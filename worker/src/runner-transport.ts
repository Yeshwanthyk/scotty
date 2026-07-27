import { Deferred, Effect, Exit, Option, Predicate, Queue, Result, Schema, Scope } from "effect";
import {
  RUNNER_CREDIT_WINDOW,
  RUNNER_DATA_CHUNK_LIMIT,
  RUNNER_HEADER_BYTES_LIMIT,
  RUNNER_HEADER_COUNT_LIMIT,
  RUNNER_REQUEST_BODY_LIMIT,
  RUNNER_STREAMS_PER_LINK_LIMIT,
  RUNNER_STREAMS_PER_SESSION_LIMIT,
  HttpOpenSchema,
  RunnerHelloSchema,
  RunnerOperationSchema,
  RunnerReplySchema,
  encodeRunnerOperation,
  encodeRunnerRequest,
  type HeaderPair,
  type HttpCancel,
  type HttpCredit,
  type HttpData,
  type HttpFailed,
  type HttpResponse,
  type RunnerOperation,
  type RunnerProbeAck,
  type RunnerRequest,
  type RunnerResponse,
} from "../../protocol/runner.ts";

const MAX_RUNNER_MESSAGE_CHARACTERS = 256 * 1024;
const DEFAULT_DISPATCH_TIMEOUT_MILLIS = 30_000;
const MAX_DISPATCH_TIMEOUT_MILLIS = 5 * 60_000;
const DEFAULT_STATUS_TIMEOUT_MILLIS = 1_000;
const MAX_STATUS_TIMEOUT_MILLIS = 5_000;
const RECENT_TERMINAL_STREAM_LIMIT = 256;
const HTTP_UPSTREAM_FAILURE = "Runner HTTP upstream failed";
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

const RunnerAttachmentSchema = Schema.Struct({
  version: Schema.Literal(2),
  runner: Schema.NonEmptyString,
  connectionId: Schema.NonEmptyString,
  ready: Schema.Boolean,
});
type RunnerAttachment = typeof RunnerAttachmentSchema.Type;

const decodeAttachment = Schema.decodeUnknownOption(RunnerAttachmentSchema, {
  onExcessProperty: "error",
});
const decodeOperation = Schema.decodeUnknownEffect(RunnerOperationSchema, {
  onExcessProperty: "error",
});
const decodeHelloText = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerHelloSchema), {
  onExcessProperty: "error",
});
const decodeReplyText = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerReplySchema), {
  onExcessProperty: "error",
});
const decodeOpen = Schema.decodeUnknownEffect(HttpOpenSchema, {
  onExcessProperty: "error",
});

export interface RunnerSocket {
  readonly send: (data: string | Uint8Array) => Effect.Effect<void, unknown>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
  readonly serializeAttachment: <T>(value: T) => void;
  readonly deserializeAttachment: <T>() => T | null;
}

export type RunnerDispatchFailureCode =
  | "invalid_operation"
  | "runner_disabled"
  | "runner_disconnected"
  | "runner_draining"
  | "runner_timeout"
  | "runner_unavailable";

export type RunnerDispatchResult =
  | { readonly ok: true; readonly response: RunnerResponse }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: RunnerDispatchFailureCode;
        readonly message: string;
      };
    };

interface PendingDispatch {
  readonly connectionId: string;
  readonly encodedOperation: string;
  readonly sessionId: string;
  readonly deferred: Deferred.Deferred<RunnerDispatchResult>;
  waiters: number;
}

interface PendingProbe {
  readonly connectionId: string;
  readonly deferred: Deferred.Deferred<boolean>;
}

interface PendingHttp {
  readonly connectionId: string;
  readonly requestCredits: Queue.Queue<number>;
  readonly requestHasBody: boolean;
  readonly requestReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  readonly response: Deferred.Deferred<Response>;
  readonly responseChunks: Queue.Queue<HttpResponseChunk>;
  readonly runtimeId: string;
  readonly scope: Scope.Closeable;
  readonly sessionId: string;
  readonly socket: RunnerSocket;
  readonly streamId: string;
  requestCredit: number;
  requestEnded: boolean;
  responseCredit: number;
  responseEnded: boolean;
  responseHasBody: boolean;
  responseStarted: boolean;
}

type HttpResponseChunk =
  | { readonly _tag: "Data"; readonly data: Uint8Array }
  | { readonly _tag: "End" }
  | { readonly _tag: "Shutdown" }
  | { readonly _tag: "Error"; readonly message: string };

export interface RunnerHttpRequest {
  readonly request: Request;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly target: string;
  readonly timeoutMillis?: number;
}

const failure = (code: RunnerDispatchFailureCode, message: string): RunnerDispatchResult => ({
  ok: false,
  error: { code, message },
});

const attachmentOf = (socket: RunnerSocket): Option.Option<RunnerAttachment> =>
  decodeAttachment(socket.deserializeAttachment<unknown>());

export class RunnerTransport {
  readonly #http = new Map<string, PendingHttp>();
  readonly #recentTerminalHttp = new Map<string, string>();
  readonly #pending = new Map<string, PendingDispatch>();
  readonly #probes = new Map<string, PendingProbe>();
  readonly #sockets = new Set<RunnerSocket>();
  readonly runnerName: string;

  constructor(runnerName: string, sockets: ReadonlyArray<RunnerSocket> = []) {
    this.runnerName = runnerName;
    for (const socket of sockets) {
      const attachment = attachmentOf(socket);
      if (Option.isSome(attachment) && attachment.value.runner === runnerName)
        this.#sockets.add(socket);
    }
  }

  accept(socket: RunnerSocket): void {
    socket.serializeAttachment<RunnerAttachment>({
      version: 2,
      runner: this.runnerName,
      connectionId: crypto.randomUUID(),
      ready: false,
    });
    this.#sockets.add(socket);
  }

  status(
    timeoutMillis = DEFAULT_STATUS_TIMEOUT_MILLIS,
  ): Effect.Effect<"connected" | "disconnected"> {
    return Effect.gen({ self: this }, function* () {
      const active = this.#activeSocket();
      if (Option.isNone(active)) return "disconnected";

      const probeId = crypto.randomUUID();
      const deferred = yield* Deferred.make<boolean>();
      const pending: PendingProbe = {
        connectionId: active.value.attachment.connectionId,
        deferred,
      };
      this.#probes.set(probeId, pending);

      return yield* Effect.gen({ self: this }, function* () {
        const sent = yield* Effect.result(
          active.value.socket
            .send(
              encodeRunnerRequest({
                _tag: "RunnerProbe",
                version: 2,
                probeId,
              }),
            )
            .pipe(Effect.sandbox),
        );
        if (Result.isFailure(sent)) {
          yield* this.#disconnectSocket(
            active.value.socket,
            active.value.attachment,
            1011,
            "Runner probe failed",
          );
          return "disconnected";
        }

        const acknowledged = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(normalizedStatusTimeout(timeoutMillis)),
        );
        if (Option.isSome(acknowledged)) return acknowledged.value ? "connected" : "disconnected";

        yield* this.#disconnectSocket(
          active.value.socket,
          active.value.attachment,
          1011,
          "Runner probe timed out",
        );
        return "disconnected";
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#probes.get(probeId) === pending) this.#probes.delete(probeId);
          }),
        ),
      );
    });
  }

  dispatch(
    input: unknown,
    timeoutMillis = DEFAULT_DISPATCH_TIMEOUT_MILLIS,
  ): Effect.Effect<RunnerDispatchResult> {
    return Effect.gen({ self: this }, function* () {
      const decoded = yield* Effect.result(decodeOperation(input));
      if (Result.isFailure(decoded))
        return failure("invalid_operation", "Runner operation is invalid");
      const operation = decoded.success;
      const encodedOperation = encodeRunnerOperation(operation);
      if (encodedOperation.length > MAX_RUNNER_MESSAGE_CHARACTERS)
        return failure("invalid_operation", "Runner operation is too large");

      const pendingKey = operationKey(operation.sessionId, operation.operationId);
      const existing = this.#pending.get(pendingKey);
      if (existing !== undefined) {
        if (
          existing.encodedOperation !== encodedOperation ||
          existing.sessionId !== operation.sessionId
        )
          return failure("invalid_operation", "Runner operation ID is already in use");
        return yield* this.#awaitPending(pendingKey, existing, normalizedTimeout(timeoutMillis));
      }

      const active = this.#activeSocket();
      if (Option.isNone(active)) return failure("runner_unavailable", "Runner is not connected");
      const deferred = yield* Deferred.make<RunnerDispatchResult>();
      const pending: PendingDispatch = {
        connectionId: active.value.attachment.connectionId,
        encodedOperation,
        sessionId: operation.sessionId,
        deferred,
        waiters: 0,
      };
      this.#pending.set(pendingKey, pending);
      const sent = yield* Effect.result(
        active.value.socket.send(encodedOperation).pipe(Effect.sandbox),
      );
      if (Result.isFailure(sent)) {
        yield* this.#disconnectSocket(
          active.value.socket,
          active.value.attachment,
          1011,
          "Runner send failed",
        );
      }
      return yield* this.#awaitPending(pendingKey, pending, normalizedTimeout(timeoutMillis));
    });
  }

  http(input: RunnerHttpRequest): Effect.Effect<Response> {
    return Effect.gen({ self: this }, function* () {
      const active = this.#activeSocket();
      if (Option.isNone(active))
        return new Response(HTTP_UPSTREAM_FAILURE, {
          status: 503,
        });
      if (this.#http.size >= RUNNER_STREAMS_PER_LINK_LIMIT)
        return new Response("Runner HTTP stream limit reached", {
          status: 429,
        });
      if (this.#sessionHttpCount(input.sessionId) >= RUNNER_STREAMS_PER_SESSION_LIMIT)
        return new Response("Runner session HTTP stream limit reached", {
          status: 429,
        });
      if (!isRelativeTarget(input.target))
        return new Response("Runner HTTP target is invalid", {
          status: 400,
        });
      if (
        (input.request.method === "GET" || input.request.method === "HEAD") &&
        input.request.body !== null
      )
        return new Response("Runner HTTP request body is invalid", {
          status: 400,
        });
      const declaredLength = Number(input.request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > RUNNER_REQUEST_BODY_LIMIT)
        return new Response("Runner HTTP request body is too large", {
          status: 413,
        });

      const headers = requestHeaderPairs(input.request.headers);
      if (headers === undefined)
        return new Response("Runner HTTP request headers are too large", {
          status: 431,
        });
      const streamId = crypto.randomUUID();
      const openResult = yield* Effect.result(
        decodeOpen({
          _tag: "HttpOpen",
          version: 2,
          streamId,
          sessionId: input.sessionId,
          runtimeId: input.runtimeId,
          method: input.request.method,
          target: input.target,
          headers,
          hasBody: input.request.body !== null,
          responseCredit: RUNNER_CREDIT_WINDOW,
        }),
      );
      if (Result.isFailure(openResult))
        return new Response("Runner HTTP request is invalid", {
          status: 400,
        });

      const response = yield* Deferred.make<Response>();
      const responseChunks = yield* Queue.make<HttpResponseChunk>();
      const requestCredits = yield* Queue.make<number>();
      const scope = yield* Scope.make();
      const pending: PendingHttp = {
        connectionId: active.value.attachment.connectionId,
        requestCredits,
        requestHasBody: openResult.success.hasBody,
        requestReader: input.request.body?.getReader(),
        response,
        responseChunks,
        runtimeId: input.runtimeId,
        scope,
        sessionId: input.sessionId,
        socket: active.value.socket,
        streamId,
        requestCredit: 0,
        requestEnded: false,
        responseCredit: RUNNER_CREDIT_WINDOW,
        responseEnded: false,
        responseHasBody: false,
        responseStarted: false,
      };
      this.#http.set(streamId, pending);

      const sent = yield* this.#sendHttp(pending, openResult.success);
      if (!sent)
        return new Response(HTTP_UPSTREAM_FAILURE, {
          status: 502,
        });
      if (pending.requestHasBody) {
        yield* this.#pumpRequest(pending).pipe(Effect.forkIn(scope));
      }

      const awaited = yield* Deferred.await(response).pipe(
        Effect.timeoutOption(
          normalizedTimeout(input.timeoutMillis ?? DEFAULT_DISPATCH_TIMEOUT_MILLIS),
        ),
        Effect.onInterrupt(() => this.#cancelHttp(pending, true)),
      );
      if (Option.isSome(awaited)) return awaited.value;

      yield* this.#cancelHttp(pending, true);
      return new Response("Runner HTTP response timed out", {
        status: 504,
      });
    });
  }

  message(socket: RunnerSocket, message: string | ArrayBuffer): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const attachment = attachmentOf(socket);
      if (Option.isNone(attachment) || attachment.value.runner !== this.runnerName) {
        yield* this.#reject(socket, "Invalid runner connection");
        return;
      }
      if (typeof message !== "string" || message.length > MAX_RUNNER_MESSAGE_CHARACTERS) {
        yield* this.#reject(socket, "Invalid runner message");
        return;
      }

      if (!attachment.value.ready) {
        const decoded = yield* Effect.result(decodeHelloText(message));
        if (Result.isFailure(decoded) || decoded.success.runner !== this.runnerName) {
          yield* this.#reject(socket, "Runner identity mismatch");
          return;
        }
        yield* this.#activate(socket, attachment.value);
        return;
      }

      const decoded = yield* Effect.result(decodeReplyText(message));
      if (Result.isFailure(decoded)) {
        yield* this.#reject(socket, "Invalid runner response");
        return;
      }
      if (Predicate.isTagged("RunnerProbeAck")(decoded.success)) {
        yield* this.#completeProbe(socket, attachment.value, decoded.success);
        return;
      }
      if (Predicate.isTagged("HttpCredit")(decoded.success)) {
        yield* this.#httpCredit(socket, attachment.value, decoded.success);
        return;
      }
      if (Predicate.isTagged("HttpResponse")(decoded.success)) {
        yield* this.#httpResponse(socket, attachment.value, decoded.success);
        return;
      }
      if (Predicate.isTagged("HttpData")(decoded.success)) {
        yield* this.#httpData(socket, attachment.value, decoded.success);
        return;
      }
      if (Predicate.isTagged("HttpEnd")(decoded.success)) {
        yield* this.#httpEnd(socket, attachment.value, decoded.success.streamId);
        return;
      }
      if (Predicate.isTagged("HttpCancel")(decoded.success)) {
        yield* this.#httpCancel(socket, attachment.value, decoded.success);
        return;
      }
      if (Predicate.isTagged("HttpFailed")(decoded.success)) {
        yield* this.#httpFailed(socket, attachment.value, decoded.success);
        return;
      }
      if (
        !Predicate.isTagged("RunnerSuccess")(decoded.success) &&
        !Predicate.isTagged("RunnerFailure")(decoded.success)
      ) {
        yield* this.#reject(socket, "Invalid runner response");
        return;
      }
      yield* this.#complete(socket, attachment.value, decoded.success);
    });
  }

  close(socket: RunnerSocket): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const attachment = attachmentOf(socket);
      this.#sockets.delete(socket);
      if (Option.isSome(attachment)) yield* this.#failConnection(attachment.value.connectionId);
    });
  }

  disconnect(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const socket of Array.from(this.#sockets)) {
        const attachment = attachmentOf(socket);
        if (Option.isSome(attachment))
          yield* this.#disconnectSocket(
            socket,
            attachment.value,
            1012,
            "Runner disconnected by operator",
          );
        else {
          this.#sockets.delete(socket);
          yield* socket
            .close(1012, "Runner disconnected by operator")
            .pipe(Effect.sandbox, Effect.ignore);
        }
      }
    });
  }

  #activeSocket(): Option.Option<{
    readonly socket: RunnerSocket;
    readonly attachment: RunnerAttachment;
  }> {
    for (const socket of this.#sockets) {
      const attachment = attachmentOf(socket);
      if (
        Option.isSome(attachment) &&
        attachment.value.runner === this.runnerName &&
        attachment.value.ready
      )
        return Option.some({ socket, attachment: attachment.value });
    }
    return Option.none();
  }

  #activate(socket: RunnerSocket, attachment: RunnerAttachment): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const peer of this.#sockets) {
        if (peer === socket) continue;
        const peerAttachment = attachmentOf(peer);
        if (Option.isSome(peerAttachment) && peerAttachment.value.ready) {
          this.#sockets.delete(peer);
          yield* this.#failConnection(peerAttachment.value.connectionId);
          yield* peer.close(1012, "Runner connection replaced").pipe(Effect.sandbox, Effect.ignore);
        }
      }
      socket.serializeAttachment<RunnerAttachment>({
        ...attachment,
        ready: true,
      });
    });
  }

  #complete(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    response: RunnerResponse,
  ): Effect.Effect<void> {
    const pendingKey = operationKey(response.sessionId, response.operationId);
    const pending = this.#pending.get(pendingKey);
    if (pending === undefined) return Effect.void;
    if (
      pending.connectionId !== attachment.connectionId ||
      pending.sessionId !== response.sessionId
    )
      return this.#reject(socket, "Runner response identity mismatch");
    this.#pending.delete(pendingKey);
    return Deferred.succeed(pending.deferred, { ok: true, response }).pipe(Effect.asVoid);
  }

  #completeProbe(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    response: RunnerProbeAck,
  ): Effect.Effect<void> {
    const pending = this.#probes.get(response.probeId);
    if (pending === undefined) return Effect.void;
    if (pending.connectionId !== attachment.connectionId)
      return this.#reject(socket, "Runner probe identity mismatch");
    this.#probes.delete(response.probeId);
    return Deferred.succeed(pending.deferred, true).pipe(Effect.asVoid);
  }

  #httpCredit(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    frame: HttpCredit,
  ): Effect.Effect<void> {
    const pending = this.#http.get(frame.streamId);
    if (pending === undefined && this.#isRecentTerminal(frame.streamId, attachment.connectionId))
      return Effect.void;
    if (
      pending === undefined ||
      frame.direction !== "request" ||
      pending.connectionId !== attachment.connectionId ||
      pending.socket !== socket ||
      !pending.requestHasBody ||
      pending.requestEnded ||
      pending.requestCredit + frame.credit > RUNNER_CREDIT_WINDOW
    )
      return this.#reject(socket, "Invalid runner HTTP credit");
    pending.requestCredit += frame.credit;
    return Queue.offer(pending.requestCredits, frame.credit).pipe(Effect.asVoid);
  }

  #httpResponse(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    frame: HttpResponse,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const pending = this.#http.get(frame.streamId);
      if (pending === undefined && this.#isRecentTerminal(frame.streamId, attachment.connectionId))
        return;
      if (
        pending === undefined ||
        pending.connectionId !== attachment.connectionId ||
        pending.socket !== socket ||
        pending.responseStarted ||
        frame.status < 200
      ) {
        yield* this.#reject(socket, "Invalid runner HTTP response");
        return;
      }
      const headersResult = Result.try({
        try: () => new Headers(frame.headers),
        catch: () => undefined,
      });
      if (Result.isFailure(headersResult)) {
        yield* this.#reject(socket, "Invalid runner HTTP response headers");
        return;
      }
      const headers = sanitizeResponseHeaders(headersResult.success);
      if (!frame.hasBody) {
        const response = Result.try({
          try: () =>
            new Response(null, {
              status: frame.status,
              statusText: frame.statusText,
              headers,
            }),
          catch: () => undefined,
        });
        if (Result.isFailure(response)) {
          yield* this.#reject(socket, "Invalid runner HTTP response metadata");
          return;
        }
        pending.responseStarted = true;
        yield* Deferred.succeed(pending.response, response.success);
        yield* this.#cleanupHttp(pending);
        return;
      }

      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: native response-stream backpressure callback.
            return Effect.runPromise(this.#pullResponse(pending, controller));
          },
          cancel: () => {
            // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: native response-stream cancellation callback.
            return Effect.runPromise(this.#cancelHttpById(pending.streamId));
          },
        },
        {
          highWaterMark: 0,
          size: (chunk) => chunk.byteLength,
        },
      );
      const response = Result.try({
        try: () =>
          new Response(body, {
            status: frame.status,
            statusText: frame.statusText,
            headers,
          }),
        catch: () => undefined,
      });
      if (Result.isFailure(response)) {
        yield* this.#reject(socket, "Invalid runner HTTP response metadata");
        return;
      }
      pending.responseStarted = true;
      pending.responseHasBody = true;
      yield* Deferred.succeed(pending.response, response.success);
    });
  }

  #httpData(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    frame: HttpData,
  ): Effect.Effect<void> {
    const pending = this.#http.get(frame.streamId);
    if (pending === undefined && this.#isRecentTerminal(frame.streamId, attachment.connectionId))
      return Effect.void;
    const data = decodeBase64(frame.data);
    if (
      pending === undefined ||
      frame.direction !== "response" ||
      pending.connectionId !== attachment.connectionId ||
      pending.socket !== socket ||
      !pending.responseStarted ||
      !pending.responseHasBody ||
      pending.responseEnded ||
      data.byteLength > pending.responseCredit
    )
      return this.#reject(socket, "Invalid runner HTTP response data");
    pending.responseCredit -= data.byteLength;
    return Queue.offer(pending.responseChunks, { _tag: "Data", data }).pipe(Effect.asVoid);
  }

  #httpEnd(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    streamId: string,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const pending = this.#http.get(streamId);
      if (pending === undefined && this.#isRecentTerminal(streamId, attachment.connectionId))
        return;
      if (
        pending === undefined ||
        pending.connectionId !== attachment.connectionId ||
        pending.socket !== socket ||
        !pending.responseStarted ||
        !pending.responseHasBody ||
        pending.responseEnded
      ) {
        yield* this.#reject(socket, "Invalid runner HTTP response end");
        return;
      }
      pending.responseEnded = true;
      yield* Queue.offer(pending.responseChunks, { _tag: "End" });
      yield* this.#cleanupHttp(pending);
    });
  }

  #httpCancel(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    frame: HttpCancel,
  ): Effect.Effect<void> {
    const pending = this.#http.get(frame.streamId);
    if (pending === undefined && this.#isRecentTerminal(frame.streamId, attachment.connectionId))
      return Effect.void;
    if (
      pending === undefined ||
      pending.connectionId !== attachment.connectionId ||
      pending.socket !== socket
    )
      return this.#reject(socket, "Invalid runner HTTP cancellation");
    if (frame.direction === "request") {
      if (!pending.requestHasBody || pending.requestEnded)
        return this.#reject(socket, "Invalid runner HTTP request cancellation");
      pending.requestEnded = true;
      const reader = pending.requestReader;
      return Effect.gen(function* () {
        if (reader !== undefined)
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        yield* Scope.close(pending.scope, Exit.void);
      });
    }
    return this.#failHttp(pending, HTTP_UPSTREAM_FAILURE);
  }

  #httpFailed(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    frame: HttpFailed,
  ): Effect.Effect<void> {
    const pending = this.#http.get(frame.streamId);
    if (pending === undefined && this.#isRecentTerminal(frame.streamId, attachment.connectionId))
      return Effect.void;
    if (
      pending === undefined ||
      pending.connectionId !== attachment.connectionId ||
      pending.socket !== socket ||
      (pending.responseStarted && frame.code !== "response_failed") ||
      (!pending.responseStarted && frame.code === "response_failed")
    )
      return this.#reject(socket, "Invalid runner HTTP failure");
    return this.#failHttp(pending, HTTP_UPSTREAM_FAILURE);
  }

  #pullResponse(
    pending: PendingHttp,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const chunk = yield* Queue.take(pending.responseChunks);
      if (Predicate.isTagged("Data")(chunk)) {
        controller.enqueue(chunk.data);
        if (this.#http.get(pending.streamId) !== pending) return;
        pending.responseCredit += chunk.data.byteLength;
        yield* this.#sendHttp(pending, {
          _tag: "HttpCredit",
          version: 2,
          streamId: pending.streamId,
          direction: "response",
          credit: chunk.data.byteLength,
        });
        return;
      }
      if (Predicate.isTagged("Error")(chunk)) {
        // oxlint-disable-next-line scotty/no-error-constructor -- boundary: native ReadableStream failure callback.
        controller.error(new TypeError(chunk.message));
        return;
      }
      if (Predicate.isTagged("Shutdown")(chunk)) return;
      controller.close();
    });
  }

  #pumpRequest(pending: PendingHttp): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const reader = pending.requestReader;
      if (reader === undefined) return;
      let bodyBytes = 0;
      let available = 0;
      while (!pending.requestEnded && this.#http.get(pending.streamId) === pending) {
        const read = yield* Effect.result(
          Effect.tryPromise({
            try: () => reader.read(),
            catch: () => "request_read_failed" as const,
          }),
        );
        if (Result.isFailure(read)) {
          yield* this.#cancelHttp(pending, true, false);
          return;
        }
        if (read.success.done) {
          pending.requestEnded = true;
          yield* this.#sendHttp(pending, {
            _tag: "HttpEnd",
            version: 2,
            streamId: pending.streamId,
            direction: "request",
          });
          return;
        }
        bodyBytes += read.success.value.byteLength;
        if (bodyBytes > RUNNER_REQUEST_BODY_LIMIT) {
          yield* this.#failHttp(pending, "Runner HTTP request body is too large", 413, true, false);
          return;
        }

        let offset = 0;
        while (
          offset < read.success.value.byteLength &&
          this.#http.get(pending.streamId) === pending
        ) {
          if (available === 0) available = yield* Queue.take(pending.requestCredits);
          const size = Math.min(
            RUNNER_DATA_CHUNK_LIMIT,
            available,
            read.success.value.byteLength - offset,
          );
          const chunk = read.success.value.subarray(offset, offset + size);
          available -= size;
          pending.requestCredit -= size;
          offset += size;
          const sent = yield* this.#sendHttp(pending, {
            _tag: "HttpData",
            version: 2,
            streamId: pending.streamId,
            direction: "request",
            data: encodeBase64(chunk),
          });
          if (!sent) return;
        }
      }
    });
  }

  #sendHttp(pending: PendingHttp, frame: RunnerRequest): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      if (this.#http.get(pending.streamId) !== pending) return false;
      const sent = yield* Effect.result(
        pending.socket.send(encodeRunnerRequest(frame)).pipe(Effect.sandbox),
      );
      if (Result.isSuccess(sent)) return true;
      const attachment = attachmentOf(pending.socket);
      if (Option.isSome(attachment))
        yield* this.#disconnectSocket(
          pending.socket,
          attachment.value,
          1011,
          "Runner HTTP send failed",
        );
      return false;
    });
  }

  #cancelHttpById(streamId: string): Effect.Effect<void> {
    const pending = this.#http.get(streamId);
    return pending === undefined ? Effect.void : this.#cancelHttp(pending, true);
  }

  #cancelHttp(pending: PendingHttp, notifyRunner: boolean, closeScope = true): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#http.get(pending.streamId) !== pending) return;
      if (notifyRunner)
        yield* this.#sendHttp(pending, {
          _tag: "HttpCancel",
          version: 2,
          streamId: pending.streamId,
          direction: "both",
        });
      yield* this.#cleanupHttp(pending, closeScope);
    });
  }

  #failHttp(
    pending: PendingHttp,
    message: string,
    status = 502,
    notifyRunner = false,
    closeScope = true,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#http.get(pending.streamId) !== pending) return;
      if (notifyRunner)
        yield* this.#sendHttp(pending, {
          _tag: "HttpCancel",
          version: 2,
          streamId: pending.streamId,
          direction: "both",
        });
      if (!pending.responseStarted)
        yield* Deferred.succeed(
          pending.response,
          new Response(message, {
            status,
          }),
        );
      else yield* Queue.offer(pending.responseChunks, { _tag: "Error", message });
      yield* this.#cleanupHttp(pending, closeScope);
    });
  }

  #cleanupHttp(pending: PendingHttp, closeScope = true): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#http.get(pending.streamId) !== pending) return;
      yield* Queue.offer(pending.responseChunks, { _tag: "Shutdown" });
      this.#http.delete(pending.streamId);
      this.#rememberTerminal(pending);
      if (!pending.requestEnded) {
        pending.requestEnded = true;
        const reader = pending.requestReader;
        if (reader !== undefined)
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: () => undefined,
          }).pipe(Effect.ignore);
      }
      if (closeScope) yield* Scope.close(pending.scope, Exit.void);
    });
  }

  #sessionHttpCount(sessionId: string): number {
    let count = 0;
    for (const pending of this.#http.values()) {
      if (pending.sessionId === sessionId) count += 1;
    }
    return count;
  }

  #isRecentTerminal(streamId: string, connectionId: string): boolean {
    return this.#recentTerminalHttp.get(streamId) === connectionId;
  }

  #rememberTerminal(pending: PendingHttp): void {
    this.#recentTerminalHttp.delete(pending.streamId);
    this.#recentTerminalHttp.set(pending.streamId, pending.connectionId);
    if (this.#recentTerminalHttp.size > RECENT_TERMINAL_STREAM_LIMIT) {
      const oldest = this.#recentTerminalHttp.keys().next().value;
      if (oldest !== undefined) this.#recentTerminalHttp.delete(oldest);
    }
  }

  #reject(socket: RunnerSocket, reason: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const attachment = attachmentOf(socket);
      if (Option.isSome(attachment))
        yield* this.#disconnectSocket(socket, attachment.value, 1008, reason);
      else {
        this.#sockets.delete(socket);
        yield* socket.close(1008, reason).pipe(Effect.sandbox, Effect.ignore);
      }
    });
  }

  #disconnectSocket(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    code: number,
    reason: string,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.#sockets.delete(socket);
      yield* this.#failConnection(attachment.connectionId);
      yield* socket.close(code, reason).pipe(Effect.sandbox, Effect.ignore);
    });
  }

  #failConnection(connectionId: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const [operationId, pending] of this.#pending) {
        if (pending.connectionId !== connectionId) continue;
        this.#pending.delete(operationId);
        yield* Deferred.succeed(
          pending.deferred,
          failure("runner_disconnected", "Runner disconnected before replying"),
        );
      }
      for (const [probeId, pending] of this.#probes) {
        if (pending.connectionId !== connectionId) continue;
        this.#probes.delete(probeId);
        yield* Deferred.succeed(pending.deferred, false);
      }
      for (const pending of Array.from(this.#http.values())) {
        if (pending.connectionId !== connectionId) continue;
        yield* this.#failHttp(pending, HTTP_UPSTREAM_FAILURE);
      }
    });
  }

  #awaitPending(
    operationId: string,
    pending: PendingDispatch,
    timeoutMillis: number,
  ): Effect.Effect<RunnerDispatchResult> {
    pending.waiters += 1;
    return Effect.gen(function* () {
      const result = yield* Deferred.await(pending.deferred).pipe(
        Effect.timeoutOption(timeoutMillis),
      );
      return Option.isSome(result)
        ? result.value
        : failure("runner_timeout", "Runner did not reply before the timeout");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pending.waiters -= 1;
          if (pending.waiters === 0 && this.#pending.get(operationId) === pending)
            this.#pending.delete(operationId);
        }),
      ),
    );
  }
}

function normalizedTimeout(timeoutMillis: number): number {
  if (!Number.isFinite(timeoutMillis)) return DEFAULT_DISPATCH_TIMEOUT_MILLIS;
  return Math.min(MAX_DISPATCH_TIMEOUT_MILLIS, Math.max(1, Math.floor(timeoutMillis)));
}

function normalizedStatusTimeout(timeoutMillis: number): number {
  if (!Number.isFinite(timeoutMillis)) return DEFAULT_STATUS_TIMEOUT_MILLIS;
  return Math.min(MAX_STATUS_TIMEOUT_MILLIS, Math.max(1, Math.floor(timeoutMillis)));
}

const operationKey = (sessionId: string, operationId: string): string =>
  `${sessionId}\u0000${operationId}`;

function isRelativeTarget(target: string): boolean {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("#")) return false;
  const parsed = Result.try({
    try: () => new URL(target, "http://runner.invalid"),
    catch: () => undefined,
  });
  return Result.isSuccess(parsed) && parsed.success.origin === "http://runner.invalid";
}

function requestHeaderPairs(headers: Headers): ReadonlyArray<HeaderPair> | undefined {
  const sanitized = new Headers(headers);
  for (const name of sanitized.get("connection")?.split(",") ?? []) sanitized.delete(name.trim());
  for (const name of HTTP_REQUEST_HEADERS_TO_STRIP) sanitized.delete(name);
  const pairs = Array.from(sanitized.entries());
  if (pairs.length > RUNNER_HEADER_COUNT_LIMIT) return undefined;
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [name, value] of pairs) {
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
    if (bytes > RUNNER_HEADER_BYTES_LIMIT) return undefined;
  }
  return pairs;
}

function sanitizeResponseHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of headers.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  for (const name of HTTP_RESPONSE_HEADERS_TO_STRIP) headers.delete(name);
  return headers;
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

export type { RunnerOperation };
