import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execute = promisify(execFile);
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const guardedScripts = ["deploy-production.mjs", "container-control-plane.mjs"];

const probe = (runtime, script, args) =>
  spawnSync(runtime, [join(scriptsRoot, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });

describe("bundled script guards", () => {
  it("imports the real maintainer-script graph without output or exit side effects when compiled", async () => {
    const fixtureRoot = await mkdtemp(join(scriptsRoot, ".compiled-guards-"));
    const outputRoot = await mkdtemp(join(tmpdir(), "scotty-compiled-guards-"));
    const fixture = join(fixtureRoot, "fixture.mjs");
    const binary = join(outputRoot, process.platform === "win32" ? "fixture.exe" : "fixture");
    try {
      await writeFile(
        fixture,
        guardedScripts
          .map((path) => `import ${JSON.stringify(`../${path}`)};`)
          .concat('process.stdout.write("fixture imported\\n");', "")
          .join("\n"),
      );
      await execute("bun", ["build", fixture, "--compile", "--outfile", binary]);
      const result = spawnSync(binary, [], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "fixture imported\n");
      assert.equal(result.stderr, "");
    } finally {
      await Promise.all([
        rm(fixtureRoot, { recursive: true, force: true }),
        rm(outputRoot, { recursive: true, force: true }),
      ]);
    }
  });

  for (const runtime of [process.execPath, "bun"]) {
    const label = basename(runtime);
    it(`keeps safe direct-run probes valid under ${label}`, async () => {
      const controlPlane = probe(runtime, "container-control-plane.mjs", []);
      assert.equal(controlPlane.status, 1);
      assert.match(
        controlPlane.stderr,
        /Container control-plane read failed: Container control-plane read requires an application ID\./u,
      );

      const deploy = probe(runtime, "deploy-production.mjs", ["--safe-probe-invalid-option"]);
      assert.equal(deploy.status, 1);
      assert.match(
        deploy.stderr,
        /Production deployment failed: Unknown production deploy option: --safe-probe-invalid-option/u,
      );
    });
  }
});
