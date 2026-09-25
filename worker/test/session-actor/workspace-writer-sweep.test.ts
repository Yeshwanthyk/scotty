import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeWorkspaceWriterSweep,
  workspaceWriterSweepScript,
} from "../../src/session-actor/transitions/workspace-writer-sweep";

describe("workspace writer sweep", () => {
  it("decodes one strict result line", () => {
    const good = decodeWorkspaceWriterSweep('{"found":2,"killed":2,"survivors":0}');
    assert.isTrue(Result.isSuccess(good));
    assert.isTrue(
      Result.isFailure(decodeWorkspaceWriterSweep('{"found":1,"killed":0,"survivors":-1}')),
    );
    assert.isTrue(
      Result.isFailure(
        decodeWorkspaceWriterSweep('{"found":0,"killed":0,"survivors":0,"extra":1}'),
      ),
    );
    assert.isTrue(
      Result.isFailure(decodeWorkspaceWriterSweep('noise\n{"found":0,"killed":0,"survivors":0}')),
    );
  });

  it.skipIf(process.platform !== "linux")(
    "terminates a process holding the workspace cwd",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "scotty-sweep-"));
      const writer = spawn("bash", ["-c", "while :; do :; done"], { cwd: root, stdio: "ignore" });
      try {
        assert.isDefined(writer.pid);
        const result = spawnSync("bash", ["-c", workspaceWriterSweepScript, "scotty-sweep", root], {
          encoding: "utf8",
          timeout: 20_000,
        });
        assert.strictEqual(result.status, 0, result.stderr);
        const decoded = decodeWorkspaceWriterSweep(result.stdout.trim());
        assert.isTrue(Result.isSuccess(decoded));
        assert.isAtLeast(Result.getOrThrow(decoded).found, 1);
        assert.strictEqual(Result.getOrThrow(decoded).survivors, 0);
      } finally {
        writer.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
