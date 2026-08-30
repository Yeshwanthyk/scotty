import {
  DurableObject,
  DurableObjectState,
  upgrade,
  type DurableObjectShape,
  type WebSocket,
} from "alchemy/Cloudflare/Workers";
import type { RuntimeContext } from "alchemy";
import { Effect, Result } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RUNNER_HTTP_PATH_PREFIX, type RunnerOperation } from "../../../protocol/runner.ts";
import {
  makeRunnerControl,
  type RunnerControlAction,
  type RunnerControlStatus,
  type RunnerDesiredState,
} from "./control.ts";
import { RunnerTransport, type RunnerDispatchResult } from "./transport.ts";

const RUNNER_DESIRED_STORAGE_KEY = "runner:desired";
const RUNNER_LAST_SEEN_STORAGE_KEY = "runner:last-seen-at-millis";

interface ScottyRunnerShape extends DurableObjectShape {
  readonly status: () => Effect.Effect<"connected" | "disconnected", never, RuntimeContext>;
  readonly controlStatus: () => Effect.Effect<RunnerControlStatus, never, RuntimeContext>;
  readonly control: (action: RunnerControlAction) => Effect.Effect<void, never, RuntimeContext>;
  readonly dispatch: (
    operation: RunnerOperation,
    timeoutMillis?: number,
  ) => Effect.Effect<RunnerDispatchResult>;
}

export class ScottyRunner extends DurableObject<ScottyRunner, ScottyRunnerShape>()(
  "ScottyRunner",
) {}

export default ScottyRunner.make<never>(
  Effect.gen(function* () {
    const state = yield* DurableObjectState;

    return Effect.gen(function* () {
      const runnerName = state.id.name;
      const sockets = yield* state.getWebSockets();
      // Socket identity survives hibernation in attachments. Pending RPC correlations stay
      // activation-local: if the activation dies, the caller observes a rejected RPC and may
      // retry the same durable runner operation identity.
      const transport = new RunnerTransport(runnerName ?? "", sockets);
      const control = yield* makeRunnerControl(
        {
          load: () =>
            state.storage
              .get<unknown>([RUNNER_DESIRED_STORAGE_KEY, RUNNER_LAST_SEEN_STORAGE_KEY])
              .pipe(
                Effect.map((stored) => ({
                  desired: stored.get(RUNNER_DESIRED_STORAGE_KEY),
                  lastSeenAtMillis: stored.get(RUNNER_LAST_SEEN_STORAGE_KEY),
                })),
              ),
          saveDesired: (desired) => state.storage.put(RUNNER_DESIRED_STORAGE_KEY, desired),
          saveLastSeenAtMillis: (lastSeenAtMillis) =>
            state.storage.put(RUNNER_LAST_SEEN_STORAGE_KEY, lastSeenAtMillis),
        },
        () => transport.status(),
      );
      const applyControl = Effect.fnUntraced(function* (action: RunnerControlAction) {
        if (action === "disconnect") return yield* transport.disconnect();
        const desired: RunnerDesiredState =
          action === "enable" ? "accepting" : action === "drain" ? "draining" : "disabled";
        yield* control.setDesired(desired);
      });

      return {
        fetch: Effect.gen(function* () {
          if (!runnerName)
            return HttpServerResponse.text("Runner identity unavailable", {
              status: 500,
            });
          const request = yield* HttpServerRequest.HttpServerRequest;
          const route = runnerHttpRoute(request.url);
          if (Result.isSuccess(route)) {
            if (!control.mountedHttpEnabled())
              return HttpServerResponse.text("Runner is disabled", {
                status: 503,
              });
            const webRequest = HttpServerRequest.toWebResult(request);
            if (Result.isFailure(webRequest))
              return HttpServerResponse.text("Invalid runner HTTP request", {
                status: 400,
              });
            return HttpServerResponse.fromWeb(
              yield* transport.http({
                request: webRequest.success,
                sessionId: route.success.sessionId,
                runtimeId: route.success.runtimeId,
                target: route.success.target,
              }),
            );
          }
          if (
            new URL(request.url, "https://runner.internal").pathname.startsWith(
              RUNNER_HTTP_PATH_PREFIX,
            )
          )
            return HttpServerResponse.text("Invalid runner HTTP route", {
              status: 400,
            });
          const [response, socket] = yield* upgrade();
          transport.accept(socket);
          return response;
        }),
        dispatch: Effect.fnUntraced(function* (operation: RunnerOperation, timeoutMillis?: number) {
          const admissionFailure = control.admission(operation);
          if (admissionFailure !== null) return { ok: false as const, error: admissionFailure };
          return yield* transport.dispatch(operation, timeoutMillis);
        }),
        status: () => control.status().pipe(Effect.map((status) => status.connection)),
        controlStatus: control.status,
        control: applyControl,
        webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) =>
          transport.message(socket, message),
        webSocketClose: (socket: WebSocket, _code: number, _reason: string, _wasClean: boolean) =>
          transport.close(socket),
        // Alchemy beta.63's public DurableObject bridge has no webSocketError hook.
        // Workerd close events, send failures, protocol rejection, replacement, and timeout
        // terminate every pending correlation the bridge can currently observe.
      };
    });
  }),
);

export interface ScottyRunnerStub {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly status: () => Promise<"connected" | "disconnected">;
  readonly controlStatus: () => Promise<RunnerControlStatus>;
  readonly control: (action: RunnerControlAction) => Promise<void>;
  readonly dispatch: (
    operation: RunnerOperation,
    timeoutMillis?: number,
  ) => Promise<RunnerDispatchResult>;
}

export interface ScottyRunnerNamespace {
  readonly getByName: (name: string) => ScottyRunnerStub;
}

export const dispatchRunnerOperation = (
  runners: ScottyRunnerNamespace,
  runnerName: string,
  operation: RunnerOperation,
  timeoutMillis?: number,
): Promise<RunnerDispatchResult> =>
  runners.getByName(runnerName).dispatch(operation, timeoutMillis);

interface RunnerHttpRoute {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly target: string;
}

function runnerHttpRoute(value: string): Result.Result<RunnerHttpRoute, undefined> {
  const parsed = Result.try({
    try: () => new URL(value, "https://runner.internal"),
    catch: () => undefined,
  });
  if (Result.isFailure(parsed) || !parsed.success.pathname.startsWith(RUNNER_HTTP_PATH_PREFIX))
    return Result.fail(undefined);
  const remainder = parsed.success.pathname.slice(RUNNER_HTTP_PATH_PREFIX.length);
  const sessionSeparator = remainder.indexOf("/");
  const runtimeSeparator = remainder.indexOf("/", sessionSeparator + 1);
  if (sessionSeparator <= 0) return Result.fail(undefined);
  const sessionId = decodeRoutePart(remainder.slice(0, sessionSeparator));
  const runtimeEnd = runtimeSeparator === -1 ? remainder.length : runtimeSeparator;
  const runtimeId = decodeRoutePart(remainder.slice(sessionSeparator + 1, runtimeEnd));
  if (
    sessionId === undefined ||
    runtimeId === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(runtimeId)
  )
    return Result.fail(undefined);
  const pathname = runtimeSeparator === -1 ? "/" : remainder.slice(runtimeSeparator);
  return Result.succeed({
    sessionId,
    runtimeId,
    target: `${pathname}${parsed.success.search}`,
  });
}

function decodeRoutePart(value: string): string | undefined {
  const decoded = Result.try({
    try: () => decodeURIComponent(value),
    catch: () => undefined,
  });
  return Result.isSuccess(decoded) ? decoded.success : undefined;
}
