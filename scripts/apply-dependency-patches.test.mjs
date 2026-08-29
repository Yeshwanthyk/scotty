import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEPENDENCY_PATCHES,
  assertPatchInventory,
  verifyDependencyPatches,
} from "./apply-dependency-patches.mjs";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const script = fileURLToPath(new URL("./apply-dependency-patches.mjs", import.meta.url));

describe("dependency patch verification", () => {
  it("keeps one first-party apply command and a non-mutating check mode", () => {
    assert.deepEqual(DEPENDENCY_PATCHES, [
      "patches/alchemy+2.0.0-beta.72.patch",
      "patches/@alchemy.run+cloudflare-runtime+2.0.0-beta.72.patch",
    ]);
    assert.doesNotThrow(() => assertPatchInventory());
    assert.doesNotThrow(() => verifyDependencyPatches({ mode: "check" }));
  });

  it("detects unapplied and unclean patches without mutating", () => {
    const calls = [];
    const gitApply = (args, patch) => {
      calls.push({ args, patch });
      if (args.includes("--reverse")) return { status: 1, stderr: "not reversed\n" };
      if (args.includes("--check")) return { status: 0, stderr: "" };
      return { status: 0, stderr: "" };
    };
    assert.throws(() => verifyDependencyPatches({ mode: "check", gitApply }), /is not applied/u);
    assert.equal(
      calls.some((call) => call.args.includes("--whitespace=nowarn")),
      false,
    );

    const unclean = (args) => ({ status: 1, stderr: `${args.join(" ")} failed\n` });
    assert.throws(
      () => verifyDependencyPatches({ mode: "check", gitApply: unclean }),
      /does not apply cleanly/u,
    );
  });

  it("detects patch inventory drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-patch-inventory-"));
    try {
      await mkdir(join(directory, "patches"));
      await writeFile(join(directory, "patches", "extra.patch"), "");
      assert.throws(() => assertPatchInventory(directory), /Patch inventory drifted/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes --check on the shared first-party command", () => {
    const checked = spawnSync(process.execPath, [script, "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Verified patches\/alchemy/u);
  });
});
