import { Schema } from "effect";
import { PiConsoleImagesSchema } from "../../../../protocol/agents/pi/pi-console";
import {
  CanonicalConversationToolSchema,
  CanonicalConversationTurnSchema,
} from "../../../../protocol/session/conversation";

// Wire contract between the Worker and an agent sidecar (scotty-codex-server,
// scotty-claude-server). Every request is fenced by the per-generation token and
// generation header; every proof names its generation and native thread.

const bytes = (maximum: number) =>
  Schema.String.check(
    Schema.makeFilter((text) => new TextEncoder().encode(text).length <= maximum),
  );
const Identifier = bytes(256).check(Schema.isMinLength(1));

export const SidecarAbsolutePath = Schema.String.check(
  Schema.isPattern(/^\//u),
  Schema.makeFilter(
    (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
  ),
  Schema.isMaxLength(4096),
);
export const SidecarAgent = Schema.Literals(["codex", "claude"]);
export type SidecarAgent = typeof SidecarAgent.Type;
export const SidecarGeneration = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u));
export const SidecarControlToken = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const SIDECAR_CONTROL_TOKEN_HEADER = "x-scotty-sidecar-token";
export const SIDECAR_CONTROL_GENERATION_HEADER = "x-scotty-sidecar-generation";

export const SidecarPrompt = Schema.Struct({
  reconcileOnly: Schema.optionalKey(Schema.Boolean),
  threadId: Identifier,
  text: Schema.String.check(Schema.isMinLength(1)),
  images: Schema.optionalKey(PiConsoleImagesSchema),
  clientUserMessageId: Schema.optionalKey(Identifier),
});
export const SidecarSteer = Schema.Struct({
  threadId: Identifier,
  text: Schema.String.check(Schema.isMinLength(1)),
  images: Schema.optionalKey(PiConsoleImagesSchema),
  expectedTurnId: Identifier,
  clientUserMessageId: Schema.optionalKey(Identifier),
});
export const SidecarMessageRequest = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("message"), ...SidecarPrompt.fields }),
  Schema.Struct({ mode: Schema.Literal("steer"), ...SidecarSteer.fields }),
]);
export const SidecarInterrupt = Schema.Struct({ threadId: Identifier, turnId: Identifier });
export const SidecarAdmission = Schema.Struct({
  generation: SidecarGeneration,
  threadId: Identifier,
  turnId: Identifier,
});
export const SidecarTurnOutcome = Schema.Literals(["completed", "interrupted", "failed"]);
export type SidecarTurnOutcome = typeof SidecarTurnOutcome.Type;
export const SidecarInterruptResult = Schema.Struct({
  ...SidecarAdmission.fields,
  status: SidecarTurnOutcome,
});

export const SidecarPromptState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({ status: Schema.Literal("admitting") }),
  Schema.Struct({ status: Schema.Literal("running"), turnId: Identifier }),
  Schema.Struct({
    status: Schema.Literal("terminal"),
    turnId: Identifier,
    outcome: SidecarTurnOutcome,
    text: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), turnId: Schema.NullOr(Identifier) }),
]);
export type SidecarPromptState = typeof SidecarPromptState.Type;

export const SidecarCleanup = Schema.Struct({
  cleanup: Schema.Literal("ambiguous"),
  descendants: Schema.Literal("unverified"),
  parent: Schema.Literals(["exited", "unverified"]),
  shutdown: Schema.Literals(["eof", "forced", "unexpected"]),
  exit: Schema.NullOr(
    Schema.Struct({ code: Schema.NullOr(Schema.Number), signal: Schema.NullOr(Schema.String) }),
  ),
  failure: Schema.NullOr(Schema.String),
});
export type SidecarCleanup = typeof SidecarCleanup.Type;

/** Native settings the Worker compares with Session authority before trusting a proof. */
export const SidecarSettings = Schema.Struct({
  model: Identifier,
  effort: Identifier,
  workspace: bytes(4096),
});
export type SidecarSettings = typeof SidecarSettings.Type;

export const SidecarSnapshot = Schema.Struct({
  agent: SidecarAgent,
  version: Identifier,
  generation: SidecarGeneration,
  threadId: Identifier,
  settings: SidecarSettings,
  ready: Schema.Boolean,
  failure: Schema.NullOr(Identifier),
  failureDiagnostic: Schema.optionalKey(bytes(256)),
  prompt: SidecarPromptState,
  tools: Schema.optionalKey(Schema.Array(CanonicalConversationToolSchema)),
  toolsTruncated: Schema.optionalKey(Schema.Boolean),
  sequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  turns: Schema.optionalKey(Schema.Array(CanonicalConversationTurnSchema)),
  turnsTruncated: Schema.optionalKey(Schema.Boolean),
  cleanup: Schema.NullOr(SidecarCleanup),
});
export type SidecarSnapshot = typeof SidecarSnapshot.Type;

/** Durable native identity recorded in backup authority and required to resume. */
export const SidecarPersistenceIdentity = Schema.Struct({
  threadId: Identifier,
  initialTurnId: Identifier,
});
export type SidecarPersistenceIdentity = typeof SidecarPersistenceIdentity.Type;
export const SidecarSaved = Schema.Struct({
  generation: SidecarGeneration,
  ...SidecarPersistenceIdentity.fields,
});

const SavedTerminal = Schema.Struct({
  status: Schema.Literal("terminal"),
  turnId: Identifier,
  outcome: SidecarTurnOutcome,
  text: Schema.String,
});
const SavedFailed = Schema.Struct({ status: Schema.Literal("failed"), turnId: Identifier });
const SavedOperation = Schema.Struct({
  id: Identifier,
  mode: Schema.Literals(["message", "steer"]),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  status: Schema.Literals(["accepted", "unknown"]),
  turnId: Schema.optionalKey(Identifier),
});
/** Agent-neutral conversation history a sidecar persists beside its native transcript. */
export const SidecarSavedHistory = Schema.Struct({
  ...SidecarPersistenceIdentity.fields,
  prompt: Schema.Union([SavedTerminal, SavedFailed]),
  turns: Schema.Array(CanonicalConversationTurnSchema).check(Schema.isMinLength(1)),
  turnsTruncated: Schema.Boolean,
  operations: Schema.Array(SavedOperation),
}).check(
  Schema.makeFilter(
    (value) =>
      value.turns[0]?.id === value.initialTurnId &&
      value.turns.every((turn) => turn.state !== "streaming") &&
      value.turns.some(
        (turn) =>
          turn.id === value.prompt.turnId &&
          (value.prompt.status !== "failed" || turn.state === "failed"),
      ) &&
      new Set(value.turns.map((turn) => turn.id)).size === value.turns.length &&
      new Set(value.operations.map((operation) => operation.id)).size === value.operations.length &&
      value.operations.every(
        (operation) => operation.status !== "accepted" || operation.turnId !== undefined,
      ),
  ),
);
export type SidecarSavedHistory = typeof SidecarSavedHistory.Type;

export const SidecarBridgeErrorCode = Schema.Literals([
  "invalid_request",
  "unauthorized",
  "stale_generation",
  "wrong_thread",
  "wrong_turn",
  "busy",
  "already_admitted",
  "not_admitted",
  "idempotency_conflict",
  "idempotency_unknown",
  "host_failed",
  "invalid_snapshot",
  "request_timeout",
  "token_file",
]);
export class SidecarBridgeError extends Schema.TaggedError<SidecarBridgeError>()(
  "SidecarBridgeError",
  {
    code: SidecarBridgeErrorCode,
    outcome: Schema.Literals(["rejected", "ambiguous"]),
  },
) {}

export const SidecarStartupFailure = Schema.Struct({
  event: Schema.Literal("sidecar_startup_failed"),
  agent: SidecarAgent,
  stage: Schema.Literals(["input", "token", "runtime", "control"]),
  code: bytes(128).check(Schema.isMinLength(1)),
  generation: Schema.optionalKey(SidecarGeneration),
});
