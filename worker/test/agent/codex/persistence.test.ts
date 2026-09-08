import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { CODEX_VERSION } from "../../../../protocol/codex-app-server";
import {
  readCodexSavedState,
  writeCodexSavedState,
  importCodexSavedState,
} from "../../../src/agent/codex/persistence";
import {
  codexSavedStatePath,
  type CodexSavedHistory,
} from "../../../src/agent/codex/persistence-format";

const history: typeof CodexSavedHistory.Type = {
  threadId: "thread",
  initialTurnId: "first",
  prompt: { status: "terminal", turnId: "second", outcome: "completed", text: "second answer" },
  turns: [
    { id: "first", state: "completed", user: "first prompt", assistant: "first answer", tools: [] },
    {
      id: "second",
      state: "completed",
      user: "second prompt",
      assistant: "second answer",
      tools: [],
    },
  ],
  turnsTruncated: false,
  operations: [
    {
      id: "message-2",
      mode: "message",
      text: "second prompt",
      status: "accepted",
      turnId: "second",
    },
  ],
};
const rollout = "sessions/2026/09/08/rollout-example.jsonl";
const content = `${JSON.stringify({ type: "session_meta", payload: { id: "thread" } })}\n${JSON.stringify({ type: "response_item", payload: { text: "conversation" } })}\n`;
const fixture = Effect.fnUntraced(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(`${tmpdir()}/scotty-persistence-`)),
    (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
  );
  const workspace = `${root}/workspace`,
    home = `${root}/private`,
    restored = `${root}/fresh-private`;
  yield* Effect.promise(async () => {
    await fs.mkdir(workspace);
    await fs.mkdir(`${home}/sessions/2026/09/08`, { recursive: true });
    await fs.writeFile(`${home}/${rollout}`, content);
    await fs.mkdir(restored);
    for (const path of [
      "config.toml",
      "auth.json",
      "state_5.sqlite",
      "logs_2.sqlite",
      "control.token",
    ])
      await fs.writeFile(`${home}/${path}`, "excluded-secret-sentinel");
  });
  return { root, workspace, home, restored };
});

describe("Codex allowlisted saved-state production filesystem adapter", () => {
  it.effect(
    "exports nested JSONL and canonical receipts, then restores into a clean home without private configuration",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.deepStrictEqual(yield* writeCodexSavedState(f.workspace, f.home, history), {
          threadId: "thread",
          initialTurnId: "first",
        });
        const saved = yield* readCodexSavedState(f.workspace, history);
        assert.equal(saved.nativeVersion, CODEX_VERSION);
        assert.deepStrictEqual(saved.history, history);
        assert.deepStrictEqual(saved.files, [{ path: rollout, content }]);
        assert.equal(JSON.stringify(saved).includes("excluded-secret-sentinel"), false);
        yield* importCodexSavedState(f.restored, saved);
        assert.deepStrictEqual(yield* Effect.promise(() => fs.readdir(f.restored)), ["sessions"]);
        assert.equal(
          yield* Effect.promise(() => fs.readFile(`${f.restored}/${rollout}`, "utf8")),
          content,
        );
      }),
  );
  it.effect("rejects missing, wrong-thread and malformed saved state", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.ok(Result.isFailure(yield* Effect.result(readCodexSavedState(f.workspace, history))));
      yield* writeCodexSavedState(f.workspace, f.home, history);
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            readCodexSavedState(f.workspace, { threadId: "another", initialTurnId: "first" }),
          ),
        ),
      );
      yield* Effect.promise(() => fs.writeFile(codexSavedStatePath(f.workspace), "{}"));
      assert.ok(Result.isFailure(yield* Effect.result(readCodexSavedState(f.workspace, history))));
    }),
  );
  it.effect(
    "rejects symlinked native rollouts and archive files without copying their contents",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.promise(async () => {
          await fs.unlink(`${f.home}/${rollout}`);
          await fs.symlink(`${f.home}/auth.json`, `${f.home}/${rollout}`);
        });
        assert.ok(
          Result.isFailure(
            yield* Effect.result(writeCodexSavedState(f.workspace, f.home, history)),
          ),
        );
        yield* Effect.promise(async () => {
          await fs.mkdir(`${f.workspace}/.scotty`);
          await fs.symlink(`${f.home}/auth.json`, codexSavedStatePath(f.workspace));
        });
        assert.ok(
          Result.isFailure(yield* Effect.result(readCodexSavedState(f.workspace, history))),
        );
      }),
  );
  it.effect("rejects traversal and truncated JSONL in archive data", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* writeCodexSavedState(f.workspace, f.home, history);
      const saved = yield* readCodexSavedState(f.workspace, history);
      for (const file of [
        { path: "../auth.json", content },
        { path: rollout, content: content.slice(0, -1) },
      ]) {
        yield* Effect.promise(() =>
          fs.writeFile(
            codexSavedStatePath(f.workspace),
            JSON.stringify({ ...saved, files: [file] }),
          ),
        );
        assert.ok(
          Result.isFailure(yield* Effect.result(readCodexSavedState(f.workspace, history))),
        );
      }
    }),
  );
});
