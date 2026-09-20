import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTAINER_STATIC_INPUTS,
  DEPLOYMENT_INPUTS,
  discoverContainerBuildInputs,
} from "../cli/src/deployment-packaging.mjs";
import { classifyCiPaths, detectChangedPaths } from "./ci-path-gates.mjs";

const flags = (paths) => {
  const decision = classifyCiPaths(paths);
  return {
    cli_clean_room: decision.cli_clean_room,
    cli_standalone: decision.cli_standalone,
    container_image: decision.container_image,
    codex_native: decision.codex_native,
  };
};

const representativePath = (input) => (input.includes(".") ? input : `${input}/changed.ts`);

describe("PR CI path gates", () => {
  it("skips expensive proofs for unrelated documentation and ordinary UI tests", () => {
    assert.deepEqual(flags(["docs/architecture.md", "ui/src/view.test.tsx"]), {
      cli_clean_room: false,
      cli_standalone: true,
      container_image: false,
      codex_native: false,
    });
    assert.deepEqual(flags(["docs/architecture.md"]), {
      cli_clean_room: false,
      cli_standalone: false,
      container_image: false,
      codex_native: false,
    });
  });

  it("decouples ordinary CLI source and version inputs from the container image", () => {
    for (const path of ["cli/src/commands.ts", "package.json", "package-lock.json"]) {
      assert.deepEqual(flags([path]), {
        cli_clean_room: true,
        cli_standalone: true,
        container_image: false,
        codex_native: false,
      });
    }
    const runtimeManifest = classifyCiPaths(["protocol/runtime-cli-manifest.ts"]);
    assert.equal(runtimeManifest.container_image, false);
    assert.equal(runtimeManifest.codex_native, true);
    assert.equal(classifyCiPaths(["worker/src/agent/codex/process.ts"]).container_image, true);
    assert.equal(classifyCiPaths(["worker/container/Dockerfile"]).container_image, true);
    assert.equal(
      classifyCiPaths(["worker/container/pi-packages/settings.json"]).container_image,
      true,
    );
  });

  it("covers every declared static container and standalone archive input", () => {
    for (const input of CONTAINER_STATIC_INPUTS) {
      assert.equal(classifyCiPaths([representativePath(input)]).container_image, true, input);
    }
    for (const input of DEPLOYMENT_INPUTS) {
      assert.equal(classifyCiPaths([representativePath(input)]).cli_standalone, true, input);
    }
  });

  it("covers every current Bun-discovered container build input", async () => {
    for (const path of await discoverContainerBuildInputs()) {
      assert.equal(classifyCiPaths([path]).container_image, true, path);
    }
  });

  it("runs native proof for runtime callbacks outside the baked image graph", () => {
    const decision = classifyCiPaths([
      "worker/src/session-actor/transitions/create-sandbox.ts",
      "worker/src/runtime-cli/materializer.ts",
    ]);
    assert.equal(decision.codex_native, true);
    assert.equal(decision.container_image, false);
  });

  it("changes to owning workflows and gate logic cannot skip proof", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/release-cli.yml",
      "scripts/ci-path-gates.mjs",
    ]) {
      assert.deepEqual(flags([path]), {
        cli_clean_room: true,
        cli_standalone: true,
        container_image: true,
        codex_native: true,
      });
    }
    for (const path of ["package.json", "package-lock.json", ".nvmrc", ".bun-version"]) {
      assert.deepEqual(flags([path]), {
        cli_clean_room: true,
        cli_standalone: true,
        container_image: false,
        codex_native: false,
      });
    }
  });

  it("fails open when the workflow cannot establish a trustworthy diff", () => {
    const root = mkdtempSync(join(tmpdir(), "scotty-ci-path-gates-"));
    const output = join(root, "output");
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/ci-path-gates.mjs", "--base", "unknown", "--head", "unknown"],
        { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /failed open/u);
      const written = readFileSync(output, "utf8");
      for (const name of ["cli_clean_room", "cli_standalone", "container_image", "codex_native"]) {
        assert.match(written, new RegExp(`^${name}=true$`, "mu"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a rename-safe diff and rejects uncertain detection", () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const calls = [];
    assert.deepEqual(
      detectChangedPaths(base, head, (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "cli/src/main.ts\nworker/src/agent/codex/process.ts\n" };
      }),
      ["cli/src/main.ts", "worker/src/agent/codex/process.ts"],
    );
    assert.deepEqual(calls[0].args.slice(0, 3), ["diff", "--name-only", "--no-renames"]);
    assert.throws(
      () => detectChangedPaths(base, head, () => ({ status: 128, stderr: "missing base" })),
      /git diff failed/u,
    );
    assert.throws(
      () => detectChangedPaths(base, head, () => ({ status: 0, stdout: "" })),
      /no changed paths/u,
    );
    assert.throws(() => detectChangedPaths("main", head), /full base and head/u);
  });
});
