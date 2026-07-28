import { Context, Data, Effect, Layer, Result, Schedule, Schema } from "effect";
import { agentEnv } from "./container-auth";
import { CredentialVault, type CredentialVaultFailure } from "./credential-vault";
import { SandboxRuntime, type SandboxRuntimeFailure } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

const PICAN_PORT = 31_415;
const PICAN_PROCESS_ID = "scotty-pican";
const PICAN_PROXY_TOKEN_HEADER = "x-pican-proxy-token";
const PICAN_COMMAND =
  "/usr/local/bin/pican -host 0.0.0.0 -p 31415 -runtime codex -codex-command /usr/local/bin/codex";
const PICAN_READY_TIMEOUT_MILLIS = 30_000;
const PICAN_STOP_TIMEOUT_MILLIS = 10_000;
const REQUEST_HEADERS_TO_STRIP = [
  "authorization",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "connection",
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
  PICAN_PROXY_TOKEN_HEADER,
] as const;
const RESPONSE_HEADERS_TO_STRIP = [
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

const PicanCreateResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  nativeId: Schema.NonEmptyString,
  runtime: Schema.Literal("codex"),
  createState: Schema.Literals(["created", "creating", "unknown"]),
  promptDispatchState: Schema.Literals(["accepted", "not_requested", "dispatching", "unknown"]),
});
type PicanCreateResponse = typeof PicanCreateResponseSchema.Type;
const decodePicanCreateResponseJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(PicanCreateResponseSchema),
);
const PicanBootstrapResponseSchema = Schema.Struct({
  defaultBranch: Schema.NonEmptyString,
  repoExists: Schema.Boolean,
});
export type PicanBootstrapResponse = typeof PicanBootstrapResponseSchema.Type;
export const decodePicanBootstrapResponseJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(PicanBootstrapResponseSchema),
);

export type PicanCreateResult =
  | ({ readonly state: "pending" } & PicanCreateResponse)
  | ({ readonly state: "stable" } & PicanCreateResponse)
  | ({ readonly state: "unknown" } & PicanCreateResponse)
  | { readonly state: "conflict" }
  | { readonly state: "invalid" };

export class PicanTransportFailure extends Data.TaggedError("PicanTransportFailure")<{
  readonly reason: "transport";
  readonly message: "Pican upstream transport failed";
}> {}

export type PicanLaunchFailure =
  | CredentialVaultFailure
  | PicanTransportFailure
  | SandboxRuntimeFailure;
export type PicanCreateFailure = CredentialVaultFailure | PicanTransportFailure;

export interface PicanCapabilities {
  readonly containerFetch: (request: Request, port: number) => Promise<Response>;
}

interface PicanShape {
  readonly fetch: (
    request: Request,
  ) => Effect.Effect<Response, CredentialVaultFailure | PicanTransportFailure>;
  readonly launch: (id: string) => Effect.Effect<void, PicanLaunchFailure>;
  readonly createHostedSession: (
    id: string,
    prompt?: string,
  ) => Effect.Effect<PicanCreateResult, PicanCreateFailure>;
  readonly stop: () => Effect.Effect<void, SandboxRuntimeFailure>;
}

export class Pican extends Context.Service<Pican, PicanShape>()("scotty/Pican") {}

export const picanLayer = (
  capabilities: PicanCapabilities,
): Layer.Layer<Pican, never, CredentialVault | SandboxRuntime> =>
  Layer.effect(
    Pican,
    Effect.gen(function* () {
      const runtime = yield* SandboxRuntime;
      const vault = yield* CredentialVault;

      const forwardWithToken = (request: Request, token: string) =>
        Effect.tryPromise({
          try: (signal) =>
            capabilities.containerFetch(sanitizeRequest(request, token, signal), PICAN_PORT),
          catch: picanTransportFailure,
        }).pipe(Effect.map(sanitizeResponse));

      const forward = (
        request: Request,
      ): Effect.Effect<Response, CredentialVaultFailure | PicanTransportFailure> =>
        Effect.gen(function* () {
          const credential = yield* vault.require;
          return yield* forwardWithToken(request, credential.picanProxyToken);
        });

      const awaitReady = (id: string, token: string) =>
        Effect.gen(function* () {
          const response = yield* forwardWithToken(
            new Request(`http://pican.internal/s/${id}/api/settings`),
            token,
          );
          yield* Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: picanTransportFailure,
          });
          if (!response.ok) return yield* picanTransportFailure();
        }).pipe(
          Effect.retry({
            schedule: Schedule.spaced("500 millis"),
            times: 59,
          }),
          Effect.timeoutOrElse({
            duration: PICAN_READY_TIMEOUT_MILLIS,
            orElse: () => Effect.fail(picanTransportFailure()),
          }),
        );

      return Pican.of({
        fetch: forward,
        launch: Effect.fnUntraced(function* (id) {
          const existing = yield* runtime.getProcess(PICAN_PROCESS_ID);
          const credential = yield* vault.require;
          if (
            existing !== null &&
            (existing.status === "starting" || existing.status === "running")
          ) {
            return yield* awaitReady(id, credential.picanProxyToken);
          }

          const root = sessionRoot(id);
          yield* runtime.startProcess(PICAN_COMMAND, {
            autoCleanup: true,
            cwd: root,
            processId: PICAN_PROCESS_ID,
            env: {
              ...agentEnv(id, credential),
              PICAN_MODE: "hosted",
              PICAN_BASE_PATH: `/s/${id}`,
              PICAN_WORKSPACE_ROOT: root,
              PICAN_STATE_ROOT: `${root}/.pican`,
              PICAN_AUTH_MODE: "proxy",
              PICAN_PROXY_HEADER: "X-Pican-Proxy-Token",
              PICAN_PROXY_TOKEN: credential.picanProxyToken,
            },
          });
          return yield* awaitReady(id, credential.picanProxyToken);
        }),
        createHostedSession: Effect.fnUntraced(function* (id, prompt) {
          const response = yield* forward(picanCreateRequest("http://pican.internal", id, prompt));

          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: picanTransportFailure,
          });
          return classifyPicanCreateResponse(response.status, text);
        }),
        stop: Effect.fnUntraced(function* () {
          const process = yield* runtime.getProcess(PICAN_PROCESS_ID);
          if (process === null) return;

          yield* process.kill("SIGTERM");
          const graceful = yield* Effect.result(process.waitForExit(PICAN_STOP_TIMEOUT_MILLIS));
          if (Result.isSuccess(graceful)) return;

          const stillRunning = yield* runtime.getProcess(PICAN_PROCESS_ID);
          if (stillRunning === null) return;
          yield* stillRunning.kill("SIGKILL");
          yield* stillRunning.waitForExit(PICAN_STOP_TIMEOUT_MILLIS);
        }),
      });
    }),
  );

export function picanCreateRequest(origin: string, id: string, prompt?: string): Request {
  const body =
    prompt === undefined
      ? { path: sessionRoot(id), runtime: "codex" }
      : { path: sessionRoot(id), runtime: "codex", initialPrompt: prompt };
  return new Request(`${origin}/s/${id}/api/new-session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": id,
    },
    body: JSON.stringify(body),
  });
}

export function classifyPicanCreateResponse(status: number, text: string): PicanCreateResult {
  if (status === 409) return { state: "conflict" };
  if (status === 400 || status === 413) return { state: "invalid" };
  const decoded = decodePicanCreateResponseJson(text);
  if (Result.isFailure(decoded)) return { state: "invalid" };
  return classifyDecodedCreateResponse(status, decoded.success);
}

function classifyDecodedCreateResponse(
  status: number,
  response: PicanCreateResponse,
): PicanCreateResult {
  if (response.createState === "unknown" || response.promptDispatchState === "unknown")
    return status === 202 || status === 503
      ? { ...response, state: "unknown" }
      : { state: "invalid" };
  if (response.createState === "creating" || response.promptDispatchState === "dispatching")
    return status === 202 ? { ...response, state: "pending" } : { state: "invalid" };
  if (
    response.createState === "created" &&
    (response.promptDispatchState === "accepted" ||
      response.promptDispatchState === "not_requested")
  )
    return status === 200 ? { ...response, state: "stable" } : { state: "invalid" };
  return { state: "invalid" };
}

function sanitizeRequest(request: Request, token: string, signal: AbortSignal): Request {
  const headers = new Headers(request.headers);
  stripConnectionHeaders(headers);
  for (const name of REQUEST_HEADERS_TO_STRIP) headers.delete(name);
  headers.set(PICAN_PROXY_TOKEN_HEADER, token);
  return new Request(request, {
    headers,
    redirect: "manual",
    signal: AbortSignal.any([request.signal, signal]),
  });
}

function sanitizeResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  stripConnectionHeaders(headers);
  for (const name of RESPONSE_HEADERS_TO_STRIP) headers.delete(name);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function stripConnectionHeaders(headers: Headers): void {
  const nominatedHeaders = headers.get("connection")?.split(",") ?? [];
  for (const value of nominatedHeaders) {
    const name = value.trim();
    if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) headers.delete(name);
  }
}

function picanTransportFailure(): PicanTransportFailure {
  return new PicanTransportFailure({
    reason: "transport",
    message: "Pican upstream transport failed",
  });
}
