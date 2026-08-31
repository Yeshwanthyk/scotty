import { Schema } from "effect";

export const SESSION_TERMINAL_MAX_DIMENSION = 1_000;
export const SESSION_TERMINAL_PATH_SEGMENT = "terminal";

export const sessionTerminalId = (sessionId: string): string => `terminal-${sessionId}`;

export const SessionTerminalRestartedSchema = Schema.Struct({
  status: Schema.Literal("restarted"),
});
export type SessionTerminalRestarted = typeof SessionTerminalRestartedSchema.Type;
