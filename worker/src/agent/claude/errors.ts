import { Data } from "effect";

export class ClaudeHostError extends Data.TaggedError("ClaudeHostError")<{
  readonly code:
    | "invalid_launch"
    | "invalid_saved_state"
    | "isolation_setup_failed"
    | "startup_failed"
    | "transport_failed"
    | "not_ready"
    | "turn_busy"
    | "no_active_turn"
    | "turn_mismatch";
}> {}
