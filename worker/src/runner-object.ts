import {
  DurableObject,
  DurableObjectState,
  upgrade,
  type DurableObjectShape,
  type WebSocket,
} from "alchemy/Cloudflare/Workers";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { RunnerOperation } from "../../protocol/runner.ts";
import { RunnerTransport, type RunnerDispatchResult } from "./runner-transport.ts";

interface ScottyRunnerShape extends DurableObjectShape {
  readonly status: () => Effect.Effect<"connected" | "disconnected">;
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

      return {
        fetch: Effect.gen(function* () {
          if (!runnerName)
            return HttpServerResponse.text("Runner identity unavailable", {
              status: 500,
            });
          const [response, socket] = yield* upgrade();
          transport.accept(socket);
          return response;
        }),
        dispatch: (operation: RunnerOperation, timeoutMillis?: number) =>
          transport.dispatch(operation, timeoutMillis),
        status: () => transport.status(),
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
