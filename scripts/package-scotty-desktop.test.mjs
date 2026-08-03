import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/package-scotty-desktop.mjs");

const run = (output) =>
  spawnSync(process.execPath, [script, output], {
    cwd: root,
    encoding: "utf8",
  });

test(
  "desktop packager rejects destructive and symlinked outputs before building",
  { skip: process.platform !== "darwin" },
  async () => {
    const repositoryOutput = run(".");
    assert.notEqual(repositoryOutput.status, 0);
    assert.match(repositoryOutput.stderr, /must be a direct \.app child/u);

    const link = join(root, "dist", `Scotty-Package-Test-${process.pid}.app`);
    const target = join(tmpdir(), `scotty-package-target-${process.pid}`);
    await mkdir(target, { recursive: true });
    await rm(link, { force: true });
    await symlink(target, link);
    try {
      const linkedOutput = run(`dist/${basename(link)}`);
      assert.notEqual(linkedOutput.status, 0);
      assert.match(linkedOutput.stderr, /must not be a symbolic link/u);
    } finally {
      await rm(link, { force: true });
      await rm(target, { recursive: true, force: true });
    }
  },
);
