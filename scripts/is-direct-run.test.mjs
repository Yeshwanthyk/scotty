import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { isDirectRun } from "./is-direct-run.mjs";

const execute = promisify(execFile);
const helperUrl = new URL("./is-direct-run.mjs", import.meta.url).href;

const withFixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "scotty-direct-run-"));
  const entry = join(root, "entry.mjs");
  await writeFile(
    entry,
    `import { isDirectRun } from ${JSON.stringify(helperUrl)};\n` +
      `if (isDirectRun(import.meta.url, process.argv[1])) process.stdout.write("direct\\n");\n`,
  );
  try {
    await run({ root, entry });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("isDirectRun", () => {
  it("recognizes direct Node execution by filesystem identity", async () => {
    await withFixture(async ({ root, entry }) => {
      const direct = await execute(process.execPath, [entry]);
      assert.equal(direct.stdout, "direct\n");

      const linked = join(root, "linked-entry.mjs");
      await symlink(entry, linked);
      const throughSymlink = await execute(process.execPath, [linked]);
      assert.equal(throughSymlink.stdout, "direct\n");

      const hardLinked = join(root, "hard-linked-entry.mjs");
      await link(entry, hardLinked);
      const throughHardLink = await execute(process.execPath, [hardLinked]);
      assert.equal(throughHardLink.stdout, "direct\n");
    });
  });

  it("does not run an imported Node module", async () => {
    await withFixture(async ({ entry }) => {
      const imported = await execute(process.execPath, [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
      ]);
      assert.equal(imported.stdout, "");
    });
  });

  it("returns false for virtual, missing, and non-file module URLs", () => {
    assert.equal(isDirectRun("file:///$bunfs/root/scripts/task.mjs", process.execPath), false);
    assert.equal(
      isDirectRun(pathToFileURL("/definitely/missing/task.mjs").href, process.execPath),
      false,
    );
    assert.equal(isDirectRun("https://example.test/task.mjs", process.execPath), false);
    assert.equal(isDirectRun(import.meta.url, undefined), false);
  });

  it("does not self-run from a Bun compiled module", async () => {
    await withFixture(async ({ root, entry }) => {
      await copyFile(
        new URL("./is-direct-run.mjs", import.meta.url),
        join(root, "is-direct-run.mjs"),
      );
      await writeFile(
        entry,
        `import { isDirectRun } from "./is-direct-run.mjs";\n` +
          `if (isDirectRun(import.meta.url, process.argv[1])) process.stdout.write("direct\\n");\n`,
      );
      const binary = join(root, process.platform === "win32" ? "compiled.exe" : "compiled");
      await execute("bun", ["build", entry, "--compile", "--outfile", binary]);
      const compiled = await execute(binary, []);
      assert.equal(compiled.stdout, "");
    });
  });
});
