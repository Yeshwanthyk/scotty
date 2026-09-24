import { Effect, FileSystem, Schema } from "effect";
import { CLAUDE_AGENT_SDK_VERSION } from "../../../../protocol/agents/claude/claude-model-capabilities";
import { SidecarSavedHistory, type SidecarPersistenceIdentity } from "../sidecar/protocol";
import { ClaudeHostError } from "./errors";

// Claude Code keeps its transcript under CLAUDE_CONFIG_DIR, which lives in the private
// generation root. The workspace copy is what backups carry to the next generation.
const TRANSCRIPTS = "projects";
const TranscriptPath = Schema.String.check(
  Schema.isPattern(/^projects\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,3}$/u),
);
const ClaudeSavedState = Schema.Struct({
  version: Schema.Literal(1),
  nativeVersion: Schema.Literal(CLAUDE_AGENT_SDK_VERSION),
  history: SidecarSavedHistory,
  files: Schema.Array(Schema.Struct({ path: TranscriptPath, content: Schema.String })),
}).check(
  Schema.makeFilter(({ history, files }) =>
    files.some(({ path }) => path.endsWith(`/${history.threadId}.jsonl`)),
  ),
);
export type ClaudeSavedState = typeof ClaudeSavedState.Type;
const decodeState = Schema.decodeUnknownEffect(ClaudeSavedState, { onExcessProperty: "error" });
const decodeStateJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeSavedState), {
  onExcessProperty: "error",
});

const statePath = (workspace: string) => `${workspace}/.scotty/claude-state.json`;
const invalid = () => new ClaudeHostError({ code: "invalid_saved_state" });

export const readClaudeSavedState = Effect.fnUntraced(function* (
  workspace: string,
  expected: SidecarPersistenceIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* fs
    .readFileString(statePath(workspace))
    .pipe(Effect.flatMap(decodeStateJson), Effect.mapError(invalid));
  if (
    state.history.threadId !== expected.threadId ||
    state.history.initialTurnId !== expected.initialTurnId
  )
    return yield* invalid();
  return state;
});

/** Restores saved transcripts into a fresh, exclusively created config directory. */
export const importClaudeSavedState = Effect.fnUntraced(function* (
  configDir: string,
  state: ClaudeSavedState,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of state.files) {
    const path = `${configDir}/${file.path}`;
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(path, file.content, { mode: 0o600, flag: "wx" });
  }
});

export const writeClaudeSavedState = Effect.fnUntraced(function* (
  workspace: string,
  configDir: string,
  history: SidecarSavedHistory,
) {
  const fs = yield* FileSystem.FileSystem;
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of yield* fs.readDirectory(`${configDir}/${TRANSCRIPTS}`, { recursive: true })) {
    const path = `${TRANSCRIPTS}/${entry}`;
    if ((yield* fs.stat(`${configDir}/${path}`)).type === "File")
      files.push({ path, content: yield* fs.readFileString(`${configDir}/${path}`) });
  }
  const state = yield* decodeState({
    version: 1,
    nativeVersion: CLAUDE_AGENT_SDK_VERSION,
    history,
    files,
  });
  const directory = `${workspace}/.scotty`;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const staging = `${statePath(workspace)}.${history.threadId}.tmp`;
  yield* fs.writeFileString(staging, JSON.stringify(state), { mode: 0o600 });
  yield* fs.rename(staging, statePath(workspace));
  return { threadId: history.threadId, initialTurnId: history.initialTurnId };
}, Effect.mapError(invalid));
