import { CODEX_VERSION } from "../../../../protocol/codex-app-server";
import { Effect, Schema } from "effect";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { CodexHostError } from "./errors";
import {
  CODEX_SAVED_STATE_MAX_BYTES,
  CodexSavedState,
  codexSavedStatePath,
} from "./persistence-format";

const invalid = () => new CodexHostError({ code: "invalid_saved_state" });
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: invalid });
const decodeState = Schema.decodeUnknownEffect(CodexSavedState, { onExcessProperty: "error" });
const decodeStateJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexSavedState), {
  onExcessProperty: "error",
});
const decodeNativeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeNativeIdentity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("session_meta"),
      payload: Schema.Struct({ id: Schema.NonEmptyString }),
    }),
  ),
);
const regularDirectory = Effect.fnUntraced(function* (path: string) {
  const stat = yield* io(() => fs.lstat(path));
  if (!stat.isDirectory() || stat.isSymbolicLink()) return yield* invalid();
});
const readRegular = Effect.fnUntraced(function* (path: string, maximum: number) {
  return yield* Effect.acquireUseRelease(
    io(() => fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
    Effect.fnUntraced(function* (handle) {
      const stat = yield* io(() => handle.stat());
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || stat.size === 0)
        return yield* invalid();
      const buffer = new Uint8Array(stat.size + 1);
      const result = yield* io(() => handle.read(buffer, 0, buffer.length, 0));
      if (result.bytesRead !== stat.size) return yield* invalid();
      return yield* Effect.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            buffer.subarray(0, stat.size),
          ),
        catch: invalid,
      });
    }),
    // oxlint-disable-next-line scotty/no-effect-escape-hatch -- boundary: native file-handle release is an infallible scope finalizer; close failure must prevent success
    (handle) => io(() => handle.close()).pipe(Effect.orDie),
  );
});
const validateNative = Effect.fnUntraced(function* (state: typeof CodexSavedState.Type) {
  let matched = false;
  for (const file of state.files) {
    if (!file.content.endsWith("\n")) return yield* invalid();
    const lines = file.content.trimEnd().split("\n");
    const first = lines[0];
    if (first === undefined) return yield* invalid();
    const metadata = yield* decodeNativeIdentity(first).pipe(Effect.mapError(invalid));
    if (metadata.payload.id === state.history.threadId) matched = true;
    for (const line of lines) yield* decodeNativeLine(line).pipe(Effect.mapError(invalid));
  }
  if (!matched) return yield* invalid();
  return state;
});

export const readCodexSavedState = Effect.fnUntraced(function* (
  workspace: string,
  expected: { readonly threadId: string; readonly initialTurnId: string },
) {
  yield* regularDirectory(`${workspace}/.scotty`);
  const body = yield* readRegular(codexSavedStatePath(workspace), CODEX_SAVED_STATE_MAX_BYTES);
  const state = yield* decodeStateJson(body).pipe(Effect.mapError(invalid));
  if (
    state.history.threadId !== expected.threadId ||
    state.history.initialTurnId !== expected.initialTurnId
  )
    return yield* invalid();
  return yield* validateNative(state);
});

export const importCodexSavedState = Effect.fnUntraced(function* (
  home: string,
  state: typeof CodexSavedState.Type,
) {
  // The destination is an exclusively created generation home. No ambient files are imported.
  for (const file of state.files) {
    const path = `${home}/${file.path}`;
    yield* io(() => fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }));
    yield* io(() => fs.writeFile(path, file.content, { mode: 0o600, flag: "wx" }));
  }
});

export const writeCodexSavedState = Effect.fnUntraced(function* (
  workspace: string,
  home: string,
  history: (typeof CodexSavedState.Type)["history"],
) {
  const files: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  const walk = Effect.fnUntraced(function* (
    relative: string,
    depth: number,
  ): Effect.fn.Return<void, CodexHostError> {
    if (depth > 4) return yield* invalid();
    const path = `${home}/${relative}`;
    yield* regularDirectory(path);
    const entries = yield* io(() => fs.readdir(path, { withFileTypes: true }));
    if (entries.length > 128) return yield* invalid();
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) yield* walk(child, depth + 1);
      else {
        if (!entry.isFile() || files.length >= 128) return yield* invalid();
        const content = yield* readRegular(`${home}/${child}`, CODEX_SAVED_STATE_MAX_BYTES - bytes);
        bytes += new TextEncoder().encode(content).length;
        files.push({ path: child, content });
      }
    }
  });
  yield* walk("sessions", 0);
  const state = yield* decodeState({
    version: 1,
    nativeVersion: CODEX_VERSION,
    history,
    files,
  }).pipe(Effect.mapError(invalid));
  yield* validateNative(state);
  const body = JSON.stringify(state);
  if (new TextEncoder().encode(body).length > CODEX_SAVED_STATE_MAX_BYTES) return yield* invalid();
  const directory = `${workspace}/.scotty`;
  yield* io(() => fs.mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* regularDirectory(directory);
  const staging = yield* io(() => fs.mkdtemp(`${directory}/codex-save-`));
  yield* Effect.acquireUseRelease(
    Effect.succeed(staging),
    Effect.fnUntraced(function* (staging) {
      const path = `${staging}/state.json`;
      yield* io(() => fs.writeFile(path, body, { flag: "wx", mode: 0o600 }));
      yield* io(() => fs.rename(path, codexSavedStatePath(workspace)));
    }),
    // oxlint-disable-next-line scotty/no-effect-escape-hatch -- boundary: native staging-directory release is an infallible scope finalizer; failed cleanup must prevent success
    (staging) => io(() => fs.rm(staging, { recursive: true, force: true })).pipe(Effect.orDie),
  );
  return { threadId: history.threadId, initialTurnId: history.initialTurnId };
});
