import { Schema, type Effect, type Stream, type Scope, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { AgentConfig } from "../../protocol/supervisor.js";

export type Config = Schema.Schema.Type<typeof AgentConfig>;
export type AgentOutput =
  | { type: "agent"; kind: Config["kind"]; event: unknown }
  | {
      type: "turn_end";
      turn: string;
      codexTurn: string;
      state: "completed" | "interrupted" | "failed";
    }
  | { type: "error"; code: string; message: string };
export type AgentReady = { kind: Config["kind"]; session: string };
export type Delivered = { req: string };
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export interface Runner {
  readonly events: Stream.Stream<AgentOutput>;
  start(
    // Extra variables for the agent and every command it runs.
    env: Record<string, string>,
    threadId?: string,
  ): Effect.Effect<
    AgentReady,
    AgentError,
    Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >;
  send(req: string, turn: string, text: string): Effect.Effect<Delivered, AgentError>;
  interrupt(req: string): Effect.Effect<void, AgentError>;
}
