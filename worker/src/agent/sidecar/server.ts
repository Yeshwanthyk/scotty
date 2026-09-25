import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Fiber, Option, Schema, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  SIDECAR_CONTROL_GENERATION_HEADER,
  SIDECAR_CONTROL_TOKEN_HEADER,
  SidecarAbsolutePath,
  SidecarBridgeError,
  SidecarControlToken,
  SidecarGeneration,
  SidecarInterrupt,
  SidecarMessageRequest,
  SidecarPersistenceIdentity,
  SidecarPrompt,
  SidecarStartupFailure,
  type SidecarAgent,
} from "./protocol";
import type { SidecarRuntime } from "./runtime";
import { consumeControlToken } from "./token-file";

/** Launch envelope shared by every sidecar. `launch` is decoded by the agent's own schema. */
export const SidecarServerStart = Schema.Struct({
  generation: SidecarGeneration,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  tokenFile: SidecarAbsolutePath,
  restore: Schema.optionalKey(SidecarPersistenceIdentity),
  launch: Schema.Unknown,
});
export interface SidecarStart<Launch> {
  readonly generation: string;
  readonly launch: Launch;
  readonly restore?: typeof SidecarPersistenceIdentity.Type;
}
export interface SidecarServerSpec<Launch extends { readonly workspace: string }, E> {
  readonly agent: SidecarAgent;
  readonly decodeLaunch: (input: unknown) => Effect.Effect<Launch, Schema.SchemaError>;
  readonly start: (
    input: SidecarStart<Launch>,
  ) => Effect.Effect<SidecarRuntime, E, Scope.Scope | NodeServices.NodeServices>;
}

const rejected = (code: SidecarBridgeError["code"]) =>
  new SidecarBridgeError({ code, outcome: "rejected" });
const decodeStart = Schema.decodeUnknownEffect(Schema.fromJsonString(SidecarServerStart), {
  onExcessProperty: "error",
});
const decodeToken = Schema.decodeUnknownEffect(SidecarControlToken);
const decodeHeaders = Schema.decodeUnknownEffect(
  Schema.Struct({
    [SIDECAR_CONTROL_TOKEN_HEADER]: SidecarControlToken,
    [SIDECAR_CONTROL_GENERATION_HEADER]: SidecarGeneration,
  }),
);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const decodeJsonOptions = { onExcessProperty: "error" } as const;
const decodePromptJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SidecarPrompt),
  decodeJsonOptions,
);
const decodeMessageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SidecarMessageRequest),
  decodeJsonOptions,
);
const decodeInterruptJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SidecarInterrupt),
  decodeJsonOptions,
);

/** Reads a bounded-time strict UTF-8 JSON body and decodes it with `decode`. */
const readJson = <A>(decode: (text: string) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers["content-type"] !== "application/json")
      return yield* rejected("invalid_request");
    const buffer = yield* request.arrayBuffer.pipe(
      Effect.mapError(() => rejected("invalid_request")),
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(rejected("request_timeout")),
      }),
    );
    const text = yield* Effect.try({
      try: () => utf8.decode(buffer),
      catch: () => rejected("invalid_request"),
    });
    return yield* decode(text).pipe(Effect.mapError(() => rejected("invalid_request")));
  });

const respond = (value: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(value), {
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
  });
const STATUS: Record<SidecarBridgeError["code"], number> = {
  unauthorized: 401,
  invalid_request: 400,
  request_timeout: 504,
  host_failed: 502,
  invalid_snapshot: 502,
  stale_generation: 409,
  wrong_thread: 409,
  wrong_turn: 409,
  busy: 409,
  already_admitted: 409,
  not_admitted: 409,
  idempotency_conflict: 409,
  idempotency_unknown: 409,
  token_file: 409,
};
const respondError = (error: SidecarBridgeError) =>
  respond({ error: error.code, outcome: error.outcome }, STATUS[error.code]);
const handle = <R>(
  operation: Effect.Effect<HttpServerResponse.HttpServerResponse, SidecarBridgeError, R>,
) =>
  operation.pipe(
    Effect.catchTag("SidecarBridgeError", (error) => Effect.succeed(respondError(error))),
  );

const ROUTES = new Set([
  "/health",
  "/snapshot",
  "/prompt",
  "/message",
  "/interrupt",
  "/stop",
  "/save",
]);

export const makeSidecarControl = Effect.fnUntraced(function* (
  runtime: SidecarRuntime,
  tokenInput: unknown,
) {
  const token = yield* decodeToken(tokenInput).pipe(Effect.mapError(() => rejected("token_file")));
  const scope = yield* Scope.Scope;
  // Stop and save outlive a disconnected caller; the generation scope owns them.
  const detached = <A>(operation: Effect.Effect<A, SidecarBridgeError>) =>
    operation.pipe(
      Effect.forkIn(scope),
      Effect.flatMap(Fiber.join),
      Effect.map((receipt) => respond({ generation: runtime.generation, ...receipt })),
    );
  const router = yield* HttpRouter.make;
  yield* router.add(
    "GET",
    "/health",
    handle(runtime.snapshot.pipe(Effect.map((proof) => respond(proof, proof.ready ? 200 : 503)))),
  );
  yield* router.add("GET", "/snapshot", handle(runtime.snapshot.pipe(Effect.map(respond))));
  yield* router.add(
    "POST",
    "/prompt",
    handle(
      readJson(decodePromptJson).pipe(
        Effect.flatMap(runtime.admit),
        Effect.map((admission) => respond(admission, 202)),
      ),
    ),
  );
  yield* router.add(
    "POST",
    "/message",
    handle(
      readJson(decodeMessageJson).pipe(
        Effect.flatMap(({ mode, ...command }) =>
          mode === "message" ? runtime.message(command) : runtime.steer(command),
        ),
        Effect.map((admission) => respond(admission, 202)),
      ),
    ),
  );
  yield* router.add(
    "POST",
    "/interrupt",
    handle(
      readJson(decodeInterruptJson).pipe(
        Effect.flatMap(runtime.interrupt),
        Effect.map((result) => respond(result, 202)),
      ),
    ),
  );
  yield* router.add("POST", "/stop", handle(detached(runtime.stop)));
  yield* router.add("POST", "/save", handle(detached(runtime.save)));
  const routes = router
    .asHttpEffect()
    .pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))));
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = yield* decodeHeaders(request.headers).pipe(
      Effect.mapError(() => rejected("unauthorized")),
    );
    if (!timingSafeEqual(Buffer.from(headers[SIDECAR_CONTROL_TOKEN_HEADER]), Buffer.from(token)))
      return yield* rejected("unauthorized");
    if (headers[SIDECAR_CONTROL_GENERATION_HEADER] !== runtime.generation)
      return yield* rejected("stale_generation");
    // No payload, token or alternate dispatch through the URL.
    if (!ROUTES.has(request.url)) return HttpServerResponse.empty({ status: 404 });
    return yield* routes;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () =>
        Effect.fail(new SidecarBridgeError({ code: "request_timeout", outcome: "ambiguous" })),
    }),
    Effect.catchTag("SidecarBridgeError", (error) => Effect.succeed(respondError(error))),
    Effect.catch(() => Effect.succeed(respondError(rejected("invalid_request")))),
  );
});

export const serveSidecarControl = Effect.fnUntraced(function* (
  runtime: SidecarRuntime,
  token: unknown,
  port: number,
) {
  const control = yield* makeSidecarControl(runtime, token);
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

const decodeFailureCode = Schema.decodeUnknownOption(
  Schema.Struct({ code: SidecarStartupFailure.fields.code }),
);
const reportStartupFailure =
  (agent: SidecarAgent, stage: typeof SidecarStartupFailure.Type.stage, generation?: string) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          const code = Cause.findErrorOption(cause).pipe(
            Option.flatMap(decodeFailureCode),
            Option.match({ onNone: () => "unexpected_failure", onSome: ({ code }) => code }),
          );
          const failure: typeof SidecarStartupFailure.Type = {
            event: "sidecar_startup_failed",
            agent,
            stage,
            code,
            ...(generation === undefined ? {} : { generation }),
          };
          console.error(JSON.stringify(failure));
        }),
      ),
    );

export const sidecarServerProgram = <Launch extends { readonly workspace: string }, E>(
  spec: SidecarServerSpec<Launch, E>,
) => {
  return Effect.fnUntraced(function* (argv: ReadonlyArray<string>) {
    const [argument] = argv;
    if (
      argv.length !== 1 ||
      argument === undefined ||
      new TextEncoder().encode(argument).length > 16384
    )
      return yield* reportStartupFailure(spec.agent, "input")(rejected("invalid_request"));
    const { generation, port, tokenFile, restore, launch } = yield* decodeStart(argument).pipe(
      Effect.flatMap((start) =>
        spec.decodeLaunch(start.launch).pipe(Effect.map((launch) => ({ ...start, launch }))),
      ),
      Effect.mapError(() => rejected("invalid_request")),
      reportStartupFailure(spec.agent, "input"),
    );
    const token = yield* consumeControlToken(tokenFile, launch.workspace).pipe(
      reportStartupFailure(spec.agent, "token", generation),
    );
    const runtime = yield* spec
      .start({ generation, launch, ...(restore === undefined ? {} : { restore }) })
      .pipe(reportStartupFailure(spec.agent, "runtime", generation));
    yield* serveSidecarControl(runtime, token, port).pipe(
      reportStartupFailure(spec.agent, "control", generation),
    );
    // Keep the failed/stopped proof readable until the Session destroys its runtime.
    return yield* Effect.never;
  });
};

// boundary: standalone Node entry for one sidecar process.
export const runSidecarServer = <Launch extends { readonly workspace: string }, E>(
  spec: SidecarServerSpec<Launch, E>,
  argv: ReadonlyArray<string>,
) =>
  NodeRuntime.runMain(
    sidecarServerProgram(spec)(argv).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.withTracerEnabled(false),
    ),
    { disableErrorReporting: true },
  );
