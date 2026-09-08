import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Fiber, FileSystem, Schema, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpIncomingMessage } from "effect/unstable/http";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  CODEX_CONTROL_GENERATION_HEADER,
  CODEX_CONTROL_TOKEN_HEADER,
  CODEX_CONTROL_MAX_BODY,
  CODEX_CONTROL_MAX_RESPONSE,
  CodexBridgeError,
  CodexControlToken,
  CodexGeneration,
  CodexSteer,
  CodexInterrupt,
  CodexPrompt,
  CodexRuntimeStart,
  startCodexRuntime,
  type CodexRuntime,
} from "./runtime";
import { consumeControlToken } from "./token-file";

export const CodexServerStart = Schema.Struct({
  ...CodexRuntimeStart.fields,
  tokenFile: Schema.String.check(
    Schema.isPattern(/^\//u),
    Schema.isMaxLength(4096),
    Schema.makeFilter(
      (path) => !path.includes("\0") && !path.includes("\n") && !path.includes("\r"),
    ),
  ),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
const decodeStart = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexServerStart), {
  onExcessProperty: "error",
});
const decodeToken = Schema.decodeUnknownEffect(CodexControlToken);
const decodeHeaders = Schema.decodeUnknownEffect(
  Schema.Struct({
    [CODEX_CONTROL_TOKEN_HEADER]: CodexControlToken,
    [CODEX_CONTROL_GENERATION_HEADER]: CodexGeneration,
  }),
);
const decodeLength = Schema.decodeUnknownEffect(
  Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: CODEX_CONTROL_MAX_BODY }),
  ),
);
const decodePrompt = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexPrompt), {
  onExcessProperty: "error",
});
const CodexMessageRequest = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("message"), ...CodexPrompt.fields }),
  Schema.Struct({ mode: Schema.Literal("steer"), ...CodexSteer.fields }),
]);
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexMessageRequest), {
  onExcessProperty: "error",
});
const decodeInterrupt = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexInterrupt), {
  onExcessProperty: "error",
});
const respond = Effect.fnUntraced(function* (value: unknown, status = 200) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > CODEX_CONTROL_MAX_RESPONSE)
    return yield* new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" });
  return HttpServerResponse.text(body, {
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
  });
});
const statusFor = (error: CodexBridgeError) =>
  error.code === "unauthorized"
    ? 401
    : error.code === "invalid_request"
      ? 400
      : error.code === "request_timeout"
        ? 504
        : error.code === "host_failed" || error.code === "invalid_snapshot"
          ? 502
          : 409;
const handle = <R>(
  operation: Effect.Effect<HttpServerResponse.HttpServerResponse, CodexBridgeError, R>,
) =>
  operation.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.text(JSON.stringify({ error: error.code, outcome: error.outcome }), {
          status: statusFor(error),
          contentType: "application/json",
          headers: { "cache-control": "no-store" },
        }),
      ),
    ),
  );

export const makeCodexControl = Effect.fnUntraced(function* (
  runtime: CodexRuntime,
  tokenInput: unknown,
) {
  const token = yield* decodeToken(tokenInput).pipe(
    Effect.mapError(() => new CodexBridgeError({ code: "token_file", outcome: "rejected" })),
  );
  const scope = yield* Scope.Scope;
  const router = yield* HttpRouter.make;
  yield* router.add(
    "GET",
    "/health",
    handle(
      runtime.snapshot.pipe(Effect.flatMap((proof) => respond(proof, proof.ready ? 200 : 503))),
    ),
  );
  yield* router.add(
    "GET",
    "/snapshot",
    handle(runtime.snapshot.pipe(Effect.flatMap((proof) => respond(proof)))),
  );
  yield* router.add(
    "POST",
    "/prompt",
    handle(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers["content-type"] !== "application/json")
          return yield* new CodexBridgeError({ code: "invalid_request", outcome: "rejected" });
        if (request.headers["content-length"] !== undefined)
          yield* decodeLength(request.headers["content-length"]).pipe(
            Effect.mapError(
              () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
            ),
          );
        const buffer = yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            FileSystem.Size(CODEX_CONTROL_MAX_BODY),
          ),
          Effect.mapError(
            () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
          ),
          Effect.timeoutOrElse({
            duration: 2000,
            orElse: () =>
              Effect.fail(new CodexBridgeError({ code: "request_timeout", outcome: "rejected" })),
          }),
        );
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer),
          catch: () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
        });
        const command = yield* decodePrompt(text).pipe(
          Effect.mapError(
            () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
          ),
        );
        return yield* runtime
          .admit(command)
          .pipe(Effect.flatMap((admission) => respond(admission, 202)));
      }),
    ),
  );
  yield* router.add(
    "POST",
    "/message",
    handle(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers["content-type"] !== "application/json")
          return yield* new CodexBridgeError({ code: "invalid_request", outcome: "rejected" });
        if (request.headers["content-length"] !== undefined)
          yield* decodeLength(request.headers["content-length"]).pipe(
            Effect.mapError(
              () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
            ),
          );
        const buffer = yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            FileSystem.Size(CODEX_CONTROL_MAX_BODY),
          ),
          Effect.mapError(
            () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
          ),
          Effect.timeoutOrElse({
            duration: 2000,
            orElse: () =>
              Effect.fail(new CodexBridgeError({ code: "request_timeout", outcome: "rejected" })),
          }),
        );
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer),
          catch: () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
        });
        const command = yield* decodeMessage(text).pipe(
          Effect.mapError(
            () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
          ),
        );
        const admission =
          command.mode === "message"
            ? runtime.message({
                ...(command.reconcileOnly === undefined
                  ? {}
                  : { reconcileOnly: command.reconcileOnly }),
                threadId: command.threadId,
                text: command.text,
                ...(command.clientUserMessageId === undefined
                  ? {}
                  : { clientUserMessageId: command.clientUserMessageId }),
              })
            : runtime.steer({
                threadId: command.threadId,
                text: command.text,
                expectedTurnId: command.expectedTurnId,
                ...(command.clientUserMessageId === undefined
                  ? {}
                  : { clientUserMessageId: command.clientUserMessageId }),
              });
        return yield* admission.pipe(Effect.flatMap((value) => respond(value, 202)));
      }),
    ),
  );
  yield* router.add(
    "POST",
    "/interrupt",
    handle(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers["content-type"] !== "application/json")
          return yield* new CodexBridgeError({ code: "invalid_request", outcome: "rejected" });
        if (request.headers["content-length"] !== undefined)
          yield* decodeLength(request.headers["content-length"]).pipe(
            Effect.mapError(
              () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
            ),
          );
        const buffer = yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            FileSystem.Size(CODEX_CONTROL_MAX_BODY),
          ),
          Effect.mapError(
            () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
          ),
          Effect.timeoutOrElse({
            duration: 2000,
            orElse: () =>
              Effect.fail(new CodexBridgeError({ code: "request_timeout", outcome: "rejected" })),
          }),
        );
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer),
          catch: () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
        });
        const command = yield* decodeInterrupt(text).pipe(
          Effect.mapError(
            () => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" }),
          ),
        );
        const result = yield* runtime.interrupt(command);
        return yield* respond(result, 202);
      }),
    ),
  );
  yield* router.add(
    "POST",
    "/stop",
    handle(
      Effect.gen(function* () {
        const stopping = yield* runtime.stop.pipe(Effect.forkIn(scope));
        return yield* Fiber.join(stopping).pipe(
          Effect.flatMap((receipt) => respond({ generation: runtime.generation, ...receipt })),
        );
      }),
    ),
  );
  yield* router.add(
    "POST",
    "/save",
    handle(
      Effect.gen(function* () {
        const saving = yield* runtime.save.pipe(Effect.forkIn(scope));
        return yield* Fiber.join(saving).pipe(
          Effect.flatMap((receipt) => respond({ generation: runtime.generation, ...receipt })),
        );
      }),
    ),
  );
  const routes = router
    .asHttpEffect()
    .pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))));
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = yield* decodeHeaders(request.headers).pipe(
      Effect.mapError(() => new CodexBridgeError({ code: "unauthorized", outcome: "rejected" })),
    );
    if (!timingSafeEqual(Buffer.from(headers[CODEX_CONTROL_TOKEN_HEADER]), Buffer.from(token)))
      return yield* new CodexBridgeError({ code: "unauthorized", outcome: "rejected" });
    if (headers[CODEX_CONTROL_GENERATION_HEADER] !== runtime.generation)
      return yield* new CodexBridgeError({ code: "stale_generation", outcome: "rejected" });
    // No payload, token or alternate dispatch through the URL.
    if (
      !["/health", "/snapshot", "/prompt", "/message", "/interrupt", "/stop", "/save"].includes(
        request.url,
      )
    )
      return HttpServerResponse.empty({ status: 404 });
    return yield* routes;
  }).pipe(
    Effect.timeoutOrElse({
      duration: 20000,
      orElse: () =>
        Effect.fail(new CodexBridgeError({ code: "request_timeout", outcome: "ambiguous" })),
    }),
    Effect.catchTag("CodexBridgeError", (error) =>
      respond({ error: error.code, outcome: error.outcome }, statusFor(error)),
    ),
    Effect.catch(() => respond({ error: "invalid_request", outcome: "rejected" }, 400)),
  );
});

export const serveCodexControl = Effect.fnUntraced(function* (
  runtime: CodexRuntime,
  token: unknown,
  port: number,
) {
  const control = yield* makeCodexControl(runtime, token);
  const server = yield* NodeHttpServer.make(
    () =>
      createServer({
        maxHeaderSize: 4096,
        headersTimeout: 5000,
        requestTimeout: 25000,
        keepAliveTimeout: 1000,
      }),
    { host: "0.0.0.0", port, gracefulShutdownTimeout: 1000 },
  );
  // No HTTP tracing/logging of private headers or model/prompt content.
  yield* server.serve(control).pipe(Effect.withTracerEnabled(false));
  return server.address;
});

export const serverProgram = Effect.fnUntraced(function* (argv: ReadonlyArray<string>) {
  if (argv.length !== 1 || new TextEncoder().encode(argv[0] ?? "").length > 16384)
    return yield* new CodexBridgeError({ code: "invalid_request", outcome: "rejected" });
  const input = yield* decodeStart(argv[0]).pipe(
    Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
  );
  const token = yield* consumeControlToken(input.tokenFile, input.launch.workspace);
  const runtime = yield* startCodexRuntime({
    generation: input.generation,
    launch: input.launch,
    ...(input.restore === undefined ? {} : { restore: input.restore }),
  });
  yield* serveCodexControl(runtime, token, input.port);
  // Keep the failed/stopped proof readable until the Session destroys its runtime.
  yield* Effect.never;
});

// boundary: separate standalone Node entry; parent JSONL main.run is unchanged.
export const runServer = (argv: ReadonlyArray<string>) =>
  NodeRuntime.runMain(
    serverProgram(argv).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.withTracerEnabled(false),
    ),
    { disableErrorReporting: true },
  );
