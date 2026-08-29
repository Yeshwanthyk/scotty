import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkCompiledCli } from "./check-cli-compiled.mjs";

describe("compiled CLI smoke", () => {
  it("is part of the shared local check gate", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.scripts["check:cli-compiled"], "node scripts/check-cli-compiled.mjs");
    assert.match(pkg.scripts.check, /check:cli-compiled/u);
  });

  it("builds to a unique temporary directory, runs the native artifact, and cleans up", async () => {
    const calls = [];
    const removed = [];
    await checkCompiledCli({
      root: "/repo",
      makeTemporaryDirectory: async () => "/tmp/scotty-cli-compiled-random",
      execute: (command, args, options) => calls.push({ command, args, options }),
      removeTemporaryDirectory: async (path) => removed.push(path),
    });

    const executable = "/tmp/scotty-cli-compiled-random/scotty";
    assert.deepEqual(calls, [
      {
        command: "bun",
        args: ["scripts/build-cli.mjs", executable],
        options: { cwd: "/repo" },
      },
      {
        command: executable,
        args: ["--version"],
        options: { cwd: "/tmp/scotty-cli-compiled-random" },
      },
    ]);
    assert.deepEqual(removed, ["/tmp/scotty-cli-compiled-random"]);
  });

  it("cleans up when a compiled-artifact probe fails", async () => {
    const removed = [];
    await assert.rejects(
      checkCompiledCli({
        makeTemporaryDirectory: async () => "/tmp/scotty-cli-compiled-failure",
        execute: (_command, args) => {
          if (args[0] === "--version") throw new Error("probe failed");
        },
        removeTemporaryDirectory: async (path) => removed.push(path),
      }),
      /probe failed/u,
    );
    assert.deepEqual(removed, ["/tmp/scotty-cli-compiled-failure"]);
  });
});
