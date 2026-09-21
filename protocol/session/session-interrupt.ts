import { Schema } from "effect";

const Identifier = Schema.NonEmptyString;
const SessionRevision = Schema.Int;

const PiInterruptAcceptedResponseSchema = Schema.Struct({
  id: Identifier,
  status: Schema.Literal("accepted"),
  commandId: Identifier,
  epoch: Identifier,
  sessionRevision: SessionRevision,
});

const CodexInterruptAcceptedResponseSchema = Schema.Struct({
  id: Identifier,
  status: Schema.Literal("accepted"),
  turnId: Identifier,
  sessionRevision: SessionRevision,
});

const StaleResponseSchema = Schema.Struct({
  id: Identifier,
  status: Schema.Literal("stale"),
  reason: Schema.Literals(["session_revision_changed", "epoch_changed"]),
  expectedSessionRevision: SessionRevision,
  sessionRevision: Schema.optionalKey(SessionRevision),
  retryable: Schema.Literal(false),
});

const UnavailableResponseSchema = Schema.Struct({
  id: Identifier,
  status: Schema.Literal("unavailable"),
  reason: Schema.Literals([
    "provider_passive_relay_unavailable",
    "session_authority_unavailable",
    "session_not_warm",
    "session_operation_active",
    "provider_unsupported",
    "command_id_conflict",
    "extension_ui_not_pending",
    "extension_ui_response_already_delivered",
    "invalid_command",
    "pi_quiescing",
    "command_rejected",
    "codex_interrupt_unavailable",
    "turn_already_terminal",
  ]),
  retryable: Schema.Boolean,
});

const AmbiguousResponseSchema = Schema.Struct({
  id: Identifier,
  status: Schema.Literal("ambiguous"),
  reason: Schema.Literals([
    "command_transport_failed",
    "command_response_invalid",
    "command_receipt_mismatch",
    "codex_interrupt_unknown",
  ]),
  retryable: Schema.optionalKey(Schema.Literal(false)),
});

export const SessionInterruptResponseSchema = Schema.Union([
  PiInterruptAcceptedResponseSchema,
  CodexInterruptAcceptedResponseSchema,
  StaleResponseSchema,
  UnavailableResponseSchema,
  AmbiguousResponseSchema,
]);
export type SessionInterruptResponse = typeof SessionInterruptResponseSchema.Type;
