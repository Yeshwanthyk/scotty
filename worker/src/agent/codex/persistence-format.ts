import { Schema } from "effect";
import { CODEX_VERSION } from "../../../../protocol/codex-app-server";
import { CanonicalConversationTurnSchema } from "../../../../protocol/session/conversation";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Text = Schema.String;
export const CodexPersistenceIdentity = Schema.Struct({
  threadId: Identifier,
  initialTurnId: Identifier,
});
export const CodexSavedTerminal = Schema.Struct({
  status: Schema.Literal("terminal"),
  turnId: Identifier,
  outcome: Schema.Literals(["completed", "interrupted", "failed"]),
  text: Text,
});
export const CodexSavedFailed = Schema.Struct({
  status: Schema.Literal("failed"),
  turnId: Identifier,
});
export const CodexSavedOperation = Schema.Struct({
  id: Identifier,
  mode: Schema.Literals(["message", "steer"]),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  status: Schema.Literals(["accepted", "unknown"]),
  turnId: Schema.optionalKey(Identifier),
});
export const CodexSavedHistory = Schema.Struct({
  ...CodexPersistenceIdentity.fields,
  prompt: Schema.Union([CodexSavedTerminal, CodexSavedFailed]),
  turns: Schema.Array(CanonicalConversationTurnSchema).check(Schema.isMinLength(1)),
  turnsTruncated: Schema.Boolean,
  operations: Schema.Array(CodexSavedOperation),
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
export const CODEX_ROLLOUT_RELATIVE_PATH =
  /^sessions\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/rollout-[A-Za-z0-9_.-]+\.jsonl$/u;
export const CodexSavedState = Schema.Struct({
  version: Schema.Literal(2),
  // Existing 0.153.4 rollout archives remain readable by the pinned 0.154.0
  // native app-server; new writes always record CODEX_VERSION.
  nativeVersion: Schema.Literals(["0.153.4", CODEX_VERSION]),
  history: CodexSavedHistory,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isPattern(CODEX_ROLLOUT_RELATIVE_PATH)),
      content: Schema.NonEmptyString,
    }),
  ).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(
    (value) => new Set(value.files.map((file) => file.path)).size === value.files.length,
  ),
);
export const codexSavedStatePath = (workspace: string) => `${workspace}/.scotty/codex-state.json`;
