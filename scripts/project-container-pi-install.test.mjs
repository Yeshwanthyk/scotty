import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  PI_ONLY_BACKEND_NAMES,
  PI_ONLY_RUNTIME_BACKENDS,
  PI_SUBAGENTS_OMITTED_PACKAGES,
  PI_SUBAGENTS_PROMPT_REWRITES,
  UPSTREAM_BACKEND_NAMES,
  UPSTREAM_RUNTIME_BACKENDS,
  UPSTREAM_RUNTIME_IMPORTS,
  UPSTREAM_SKILL_PI_DEFAULT,
  UPSTREAM_SKILL_SPAWN,
  UPSTREAM_SKILL_UNAVAILABLE_HARNESSES,
  UPSTREAM_SUBAGENTS_README,
  canonicalizeNpmLock,
  isPiSubagentsProjected,
  parseProjectContainerPiInstallArgs,
  parentLockPackagePath,
  pruneNpmLockPackages,
  projectPiSubagentsInstall,
  replaceExact,
  resolveLockDependency,
} from "./project-container-pi-install.mjs";

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

describe("container Pi install projection", () => {
  it("prunes unreferenced lock packages after root dependency changes", () => {
    assert.equal(parentLockPackagePath("node_modules/@scope/pkg"), "");
    assert.equal(
      parentLockPackagePath("node_modules/@scope/pkg/node_modules/nested"),
      "node_modules/@scope/pkg",
    );
    const lock = {
      packages: {
        "": {
          dependencies: {
            keep: "1.0.0",
            drop: "1.0.0",
          },
        },
        "node_modules/keep": {
          dependencies: { shared: "1.0.0" },
        },
        "node_modules/drop": {
          dependencies: { onlyDrop: "1.0.0" },
        },
        "node_modules/shared": {},
        "node_modules/onlyDrop": {},
        "node_modules/drop/node_modules/nested": {},
      },
    };
    assert.equal(resolveLockDependency(lock, "", "keep"), "node_modules/keep");
    const pruned = pruneNpmLockPackages(lock, {
      dependencies: { keep: "1.0.0" },
    });
    assert.deepEqual(Object.keys(pruned.packages).sort(), [
      "",
      "node_modules/keep",
      "node_modules/shared",
    ]);
    assert.deepEqual(pruned.packages[""].dependencies, { keep: "1.0.0" });
  });

  it("makes pi-subagents Pi-only without installing Claude Agent SDK", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-pi-subagents-project-"));
    try {
      const packageRoot = join(directory, "sources/pi-subagents");
      await writeJson(join(packageRoot, "package.json"), {
        name: "pi-subagents",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "^0.3.207",
          effect: "4.0.0-beta.98",
        },
      });
      await writeJson(join(packageRoot, "package-lock.json"), {
        packages: {
          "": {
            dependencies: {
              "@anthropic-ai/claude-agent-sdk": "^0.3.207",
              effect: "4.0.0-beta.98",
            },
          },
          "node_modules/@anthropic-ai/claude-agent-sdk": {
            optionalDependencies: {
              "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.210",
            },
          },
          "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64": {},
          "node_modules/effect": {},
        },
      });
      await mkdir(join(packageRoot, "extensions/subagents/src"), { recursive: true });
      await writeFile(
        join(packageRoot, "extensions/subagents/src/runtime.ts"),
        `import { piBackend } from "./backends/pi.ts";\n${UPSTREAM_RUNTIME_IMPORTS}${UPSTREAM_RUNTIME_BACKENDS}\n`,
      );
      await writeFile(
        join(packageRoot, "extensions/subagents/src/domain.ts"),
        `${UPSTREAM_BACKEND_NAMES}\n`,
      );
      await writeFile(
        join(packageRoot, "extensions/subagents/src/prompt.ts"),
        `${PI_SUBAGENTS_PROMPT_REWRITES.map(({ search }) => search).join("\n")}\n`,
      );
      await mkdir(join(packageRoot, "skills/subagents"), { recursive: true });
      await writeFile(
        join(packageRoot, "skills/subagents/SKILL.md"),
        `${UPSTREAM_SKILL_PI_DEFAULT}\n\n${UPSTREAM_SKILL_UNAVAILABLE_HARNESSES}${UPSTREAM_SKILL_SPAWN}\n`,
      );
      await writeFile(join(packageRoot, "README.md"), `${UPSTREAM_SUBAGENTS_README}\n`);

      await projectPiSubagentsInstall(packageRoot);
      await projectPiSubagentsInstall(packageRoot);

      const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      const lock = JSON.parse(await readFile(join(packageRoot, "package-lock.json"), "utf8"));
      assert.equal(isPiSubagentsProjected(packageJson), true);
      for (const name of PI_SUBAGENTS_OMITTED_PACKAGES) {
        assert.equal(packageJson.dependencies[name], undefined);
      }
      assert.equal(packageJson.dependencies.effect, "4.0.0-beta.98");
      assert.equal(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"], undefined);
      assert.equal(
        lock.packages["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"],
        undefined,
      );
      assert.ok(lock.packages["node_modules/effect"]);
      assert.match(
        await readFile(join(packageRoot, "extensions/subagents/src/runtime.ts"), "utf8"),
        new RegExp(PI_ONLY_RUNTIME_BACKENDS.replaceAll("[", "\\[").replaceAll("]", "\\]"), "u"),
      );
      assert.doesNotMatch(
        await readFile(join(packageRoot, "extensions/subagents/src/runtime.ts"), "utf8"),
        /claudeBackend|codexBackend|claude-agent-sdk/u,
      );
      assert.equal(
        (await readFile(join(packageRoot, "extensions/subagents/src/domain.ts"), "utf8")).trim(),
        PI_ONLY_BACKEND_NAMES,
      );
      assert.match(
        await readFile(join(packageRoot, "extensions/subagents/src/prompt.ts"), "utf8"),
        /Scotty's prepared pi-subagents package is Pi-only|It runs on pi/u,
      );
      assert.doesNotMatch(
        await readFile(join(packageRoot, "extensions/subagents/src/prompt.ts"), "utf8"),
        /Codex CLI|Claude Code/u,
      );
      const skill = await readFile(join(packageRoot, "skills/subagents/SKILL.md"), "utf8");
      assert.match(skill, /This prepared package is Pi-only/u);
      assert.match(skill, /Always spawn with harness/u);
      assert.doesNotMatch(skill, /## Claude Code Harness|## Codex Harness|Requires the Codex CLI/u);
      assert.match(
        await readFile(join(packageRoot, "README.md"), "utf8"),
        /This prepared package is Pi-only/u,
      );
      assert.doesNotMatch(
        await readFile(join(packageRoot, "README.md"), "utf8"),
        /Claude Code|Codex CLI|Codex subagents/u,
      );
      await assert.throws(
        () =>
          replaceExact(
            "already projected runtime",
            "missing-upstream-snippet",
            "not-already-projected-replacement",
            "mutated runtime",
          ),
        /expected upstream or already-projected form/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when an expected rewrite snippet is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-pi-rewrite-miss-"));
    try {
      const packageRoot = join(directory, "sources/pi-subagents");
      await writeJson(join(packageRoot, "package.json"), {
        name: "pi-subagents",
        dependencies: { effect: "4.0.0-beta.98" },
      });
      await mkdir(join(packageRoot, "extensions/subagents/src"), { recursive: true });
      await writeFile(
        join(packageRoot, "extensions/subagents/src/runtime.ts"),
        `import { piBackend } from "./backends/pi.ts";\n${UPSTREAM_RUNTIME_IMPORTS}${UPSTREAM_RUNTIME_BACKENDS}\n`,
      );
      await writeFile(
        join(packageRoot, "extensions/subagents/src/domain.ts"),
        `${UPSTREAM_BACKEND_NAMES.replace("claude", "mutated")}\n`,
      );
      await writeFile(
        join(packageRoot, "extensions/subagents/src/prompt.ts"),
        `${PI_SUBAGENTS_PROMPT_REWRITES.map(({ search }) => search).join("\n")}\n`,
      );
      await assert.rejects(projectPiSubagentsInstall(packageRoot), /pi-subagents backend names/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes lock package order and keeps prune deterministic", () => {
    const lock = {
      packages: {
        "node_modules/z": {},
        "": { dependencies: { a: "1.0.0", z: "1.0.0" } },
        "node_modules/a": {},
      },
    };
    const first = pruneNpmLockPackages(lock, { dependencies: { a: "1.0.0", z: "1.0.0" } });
    const second = pruneNpmLockPackages(first, { dependencies: { a: "1.0.0", z: "1.0.0" } });
    assert.deepEqual(Object.keys(first.packages), ["", "node_modules/a", "node_modules/z"]);
    assert.deepEqual(first, second);
    assert.deepEqual(canonicalizeNpmLock(lock).packages, first.packages);
  });

  it("keeps npm lock regeneration opt-in for a local package", async () => {
    assert.deepEqual(parseProjectContainerPiInstallArgs([]), {});
    assert.deepEqual(parseProjectContainerPiInstallArgs(["--regenerate-lock"]), {
      regenerateLock: true,
    });
    assert.deepEqual(
      parseProjectContainerPiInstallArgs(["--package", "/tmp/pi-subagents", "--check"]),
      {
        packageRoot: "/tmp/pi-subagents",
        check: true,
      },
    );
    const source = await readFile(
      new URL("./project-container-pi-install.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /--regenerate-lock/u);
    assert.doesNotMatch(source, /regenerateLock:\s*true,\s*\.\.\.parsed/u);
    const packaging = await readFile(
      new URL("../cli/src/deployment-packaging.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(packaging, /projectContainerPiInstall|projectPiInstall/u);
  });

  it("does not call npm when projecting locks by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-pi-lock-default-"));
    try {
      const packageRoot = join(directory, "sources/pi-subagents");
      await writeJson(join(packageRoot, "package.json"), {
        name: "pi-subagents",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "^0.3.207",
          effect: "4.0.0-beta.98",
        },
      });
      await writeJson(join(packageRoot, "package-lock.json"), {
        packages: {
          "": {
            dependencies: {
              "@anthropic-ai/claude-agent-sdk": "^0.3.207",
              effect: "4.0.0-beta.98",
            },
          },
          "node_modules/@anthropic-ai/claude-agent-sdk": {},
          "node_modules/effect": {},
        },
      });
      const calls = [];
      await projectPiSubagentsInstall(packageRoot, {
        regenerateNpmPackageLock: async (cwd) => {
          calls.push(cwd);
        },
      });
      assert.deepEqual(calls, []);
      const lock = JSON.parse(await readFile(join(packageRoot, "package-lock.json"), "utf8"));
      assert.equal(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"], undefined);
      assert.ok(lock.packages["node_modules/effect"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("regenerates locks through npm then prunes the production closure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-pi-lock-npm-"));
    try {
      const packageRoot = join(directory, "sources/pi-subagents");
      await writeJson(join(packageRoot, "package.json"), {
        name: "pi-subagents",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "^0.3.207",
          effect: "4.0.0-beta.98",
        },
      });
      await writeJson(join(packageRoot, "package-lock.json"), {
        packages: {
          "": {
            dependencies: {
              "@anthropic-ai/claude-agent-sdk": "^0.3.207",
              effect: "4.0.0-beta.98",
            },
          },
          "node_modules/@anthropic-ai/claude-agent-sdk": {},
          "node_modules/effect": {},
        },
      });
      const calls = [];
      await projectPiSubagentsInstall(packageRoot, {
        regenerateLock: true,
        regenerateNpmPackageLock: async (cwd) => {
          calls.push(cwd);
        },
      });
      assert.deepEqual(calls, [packageRoot]);
      const lock = JSON.parse(await readFile(join(packageRoot, "package-lock.json"), "utf8"));
      assert.equal(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"], undefined);
      assert.ok(lock.packages["node_modules/effect"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
