import { Effect, Schema } from "effect";
import type { FromSupervisorMessage } from "../../protocol/supervisor.js";
import type { Draft } from "./log.js";

/** Translate the agent-neutral supervisor envelope; only view.ts reads agent payloads. */
export const supervisorEvent = (
  message: FromSupervisorMessage,
): Effect.Effect<Draft | undefined, Schema.SchemaError> =>
  Effect.gen(function* () {
    switch (message.type) {
      case "hello":
        return {
          kind: "sup.hello",
          gen: message.gen,
          n: message.n,
          version: message.version,
          boot: message.boot,
        };
      case "workspace_ready":
        return {
          kind: "workspace.ready",
          gen: message.gen,
          n: message.n,
          base: message.base,
          branch: message.branch,
          commit: message.commit,
        };
      case "agent_ready":
        return {
          kind: "agent.ready",
          gen: message.gen,
          n: message.n,
          agentKind: message.kind,
          session: message.session,
        };
      case "delivered":
        return { kind: "prompt.delivered", gen: message.gen, n: message.n, req: message.req };
      case "agent": {
        const event = yield* Schema.decodeUnknownEffect(Schema.Json)(message.event);
        return {
          kind: "agent.event",
          gen: message.gen,
          n: message.n,
          agentKind: message.kind,
          event,
        };
      }
      case "turn_end":
        return {
          kind: "turn.ended",
          gen: message.gen,
          n: message.n,
          turn: message.turn,
          codexTurn: message.codexTurn,
          state: message.state,
        };
      case "error":
        return {
          kind: "sup.error",
          gen: message.gen,
          n: message.n,
          code: message.code,
          message: message.message,
          ...(message.req === undefined ? {} : { req: message.req }),
        };
      case "ack":
        return undefined;
    }
  });
