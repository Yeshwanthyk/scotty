import type { PromptImage } from "../../protocol/prompt.js";
import { Schema, type Effect, type Stream, type Scope, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { AgentConfig } from "../../protocol/supervisor.js";

import type { Output } from "./wire.js";

export type Config = Schema.Schema.Type<typeof AgentConfig>;
export type AgentOutput =
  | Extract<Output, { type: "agent" | "turn_end" }>
  | Omit<Extract<Output, { type: "error" }>, "req">;
export type AgentReady = Omit<Extract<Output, { type: "agent_ready" }>, "type">;
export type Delivered = Omit<Extract<Output, { type: "delivered" }>, "type">;
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  code: Schema.String,
  message: Schema.String,
  unresumable: Schema.optionalKey(Schema.Boolean),
}) {}

export interface Runner {
  readonly events: Stream.Stream<AgentOutput>;
  start(
    env: Record<string, string>,
    threadId?: string,
  ): Effect.Effect<
    AgentReady,
    AgentError,
    Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >;
  send(
    req: string,
    turn: string,
    text: string,
    images?: readonly PromptImage[],
  ): Effect.Effect<Delivered, AgentError>;
  interrupt(req: string): Effect.Effect<void, AgentError>;
}
