import { Schema } from "effect";
import { CODEX_VERSION } from "../../../../protocol/agents/codex/codex-app-server";
import { SidecarSavedHistory } from "../sidecar/protocol";

export const CODEX_ROLLOUT_RELATIVE_PATH =
  /^sessions\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/rollout-[A-Za-z0-9_.-]+\.jsonl$/u;
export const CodexSavedState = Schema.Struct({
  version: Schema.Literal(2),
  // Existing 0.153.4 rollout archives remain readable by the pinned 0.154.0
  // native app-server; new writes always record CODEX_VERSION.
  nativeVersion: Schema.Literals(["0.153.4", CODEX_VERSION]),
  history: SidecarSavedHistory,
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
