import { Schema } from "effect";
import { CODEX_MAX_TEXT_BYTES, CODEX_VERSION } from "../../../../protocol/codex-app-server";
import {
  CanonicalConversationTurnSchema,
  CONVERSATION_MAX_TURNS,
} from "../../../../protocol/conversation";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Text = Schema.String.check(
  Schema.makeFilter((value) => new TextEncoder().encode(value).length <= CODEX_MAX_TEXT_BYTES),
);
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
  text: Text,
  expectedTurnId: Schema.optionalKey(Identifier),
  status: Schema.Literals(["accepted", "unknown"]),
  turnId: Schema.optionalKey(Identifier),
});
export const CodexSavedHistory = Schema.Struct({
  ...CodexPersistenceIdentity.fields,
  prompt: Schema.Union([CodexSavedTerminal, CodexSavedFailed]),
  turns: Schema.Array(CanonicalConversationTurnSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CONVERSATION_MAX_TURNS),
  ),
  turnsTruncated: Schema.Boolean,
  operations: Schema.Array(CodexSavedOperation).check(Schema.isMaxLength(CONVERSATION_MAX_TURNS)),
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
export const CODEX_SAVED_STATE_MAX_BYTES = 16 * 1024 * 1024;
export const CODEX_SAVED_HISTORY_MAX_BYTES = 512 * 1024;
export const CodexSavedState = Schema.Struct({
  version: Schema.Literal(1),
  nativeVersion: Schema.Literal(CODEX_VERSION),
  history: CodexSavedHistory,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(
        Schema.isPattern(
          /^sessions\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/rollout-[A-Za-z0-9_.-]+\.jsonl$/u,
        ),
      ),
      content: Schema.NonEmptyString,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
}).check(
  Schema.makeFilter(
    (value) =>
      new Set(value.files.map((file) => file.path)).size === value.files.length &&
      new TextEncoder().encode(JSON.stringify(value.history)).length <=
        CODEX_SAVED_HISTORY_MAX_BYTES,
  ),
);
export const codexSavedStatePath = (workspace: string) => `${workspace}/.scotty/codex-state.json`;
