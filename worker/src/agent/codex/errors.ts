import { Data, Schema } from "effect";

export const Cleanup = Schema.Struct({
  cleanup: Schema.Literal("ambiguous"),
  descendants: Schema.Literal("unverified"),
  parent: Schema.Literals(["exited", "unverified"]),
  shutdown: Schema.Literals(["eof", "forced", "unexpected"]),
  exit: Schema.NullOr(
    Schema.Struct({ code: Schema.NullOr(Schema.Number), signal: Schema.NullOr(Schema.String) }),
  ),
  failure: Schema.NullOr(Schema.String),
});
export type Cleanup = typeof Cleanup.Type;

export class CodexHostError extends Data.TaggedError("CodexHostError")<{
  readonly code:
    | "invalid_saved_state"
    | "invalid_launch_selection"
    | "credential_expired"
    | "upstream_failed"
    | "invalid_deadline"
    | "unsupported_platform"
    | "isolation_setup_failed"
    | "hatch_restore_failed"
    | "hatch_cleanup_failed"
    | "tool_execution_failed"
    | "spawn_failed"
    | "transport_failed"
    | "invalid_message"
    | "message_too_large"
    | "invalid_utf8"
    | "truncated_record"
    | "output_budget"
    | "event_budget"
    | "stderr_budget"
    | "input_budget"
    | "startup_timeout"
    | "request_timeout"
    | "turn_timeout"
    | "unexpected_exit"
    | "interrupted"
    | "runtime_mismatch"
    | "settings_mismatch"
    | "rpc_rejected"
    | "unexpected_response_id"
    | "unsupported_notification"
    | "stale_notification"
    | "duplicate_turn_started"
    | "turn_not_started"
    | "reused_turn_id"
    | "not_ready"
    | "turn_busy"
    | "turn_mismatch"
    | "no_active_turn"
    | "stopped";
  readonly cleanup?: Cleanup;
  readonly staleDiagnostic?: string;
  readonly upstreamDiagnostic?: string;
}> {}
