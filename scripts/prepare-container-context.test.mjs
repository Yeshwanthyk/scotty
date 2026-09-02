import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  CONTAINER_CONTEXT_PATH,
  CONTAINER_CONTEXT_BUDGET,
  CONTAINER_IMAGE_BUDGET,
  CONTAINER_INPUTS,
  CONTAINER_STATIC_INPUTS,
  assertContainerContextBudget,
  assertContainerImageBudget,
  assertSafeProjectPath,
  inspectContainerImageBudget,
  isSafeProjectPath,
  listPackagedFiles,
  materializeProjectInputs,
  normalizeProjectPath,
  prepareContainerContext,
  projectContainerCliInputs,
} from "../cli/src/deployment-packaging.mjs";

const SENTINEL = "SCOTTY_IGNORED_NODE_MODULES_SENTINEL";

const writeTree = async (root, files) => {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
};

const listAllFiles = async (root) => {
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(normalizeProjectPath(relative(root, child)));
    }
  };
  await walk(root);
  return files;
};

test("prepared context does not run package preparation hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-container-context-no-npm-"));
  try {
    await writeTree(root, {
      "cli/src/index.ts": "export {};\n",
    });
    const calls = [];
    await prepareContainerContext(root, {
      inputs: ["cli/src"],
      projectPiInstall: async (context, options) => {
        calls.push({ context, options });
      },
    });
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Container context contains only static runtime assets and CLI graph inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-container-context-"));
  try {
    for (const input of CONTAINER_STATIC_INPUTS) {
      const path = join(root, input);
      if (input === "worker/container") {
        await mkdir(path, { recursive: true });
      } else {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${input}\n`);
      }
    }

    const cliInput = "cli/scotty.ts";
    const workerCliInput = "worker/src/runner/control.ts";
    const unrelatedWorkerInput = "worker/src/index.ts";
    for (const input of [cliInput, workerCliInput, unrelatedWorkerInput]) {
      await mkdir(dirname(join(root, input)), { recursive: true });
      await writeFile(join(root, input), `${input}\n`);
    }

    const sourceRoot = join(root, "worker/container/pi-packages/sources/example");
    await mkdir(join(sourceRoot, "node_modules/dependency/.git"), { recursive: true });
    await writeFile(join(sourceRoot, "index.js"), "export {};\n");
    await writeFile(join(sourceRoot, "package.json"), '{"name":"example"}\n');
    await writeFile(join(sourceRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
    await writeFile(join(sourceRoot, "node_modules/dependency/index.js"), `${SENTINEL}\n`);

    await prepareContainerContext(root, {
      discoverCliInputs: async () => [cliInput, workerCliInput],
    });

    const contextSource = join(
      root,
      CONTAINER_CONTEXT_PATH,
      "worker/container/pi-packages/sources/example",
    );
    assert.equal(await readFile(join(contextSource, "index.js"), "utf8"), "export {};\n");
    assert.equal(
      await readFile(join(contextSource, "package.json"), "utf8"),
      '{"name":"example"}\n',
    );
    assert.equal(
      await readFile(join(contextSource, "package-lock.json"), "utf8"),
      '{"lockfileVersion":3}\n',
    );
    await assert.rejects(
      readFile(join(contextSource, "node_modules/dependency/index.js"), "utf8"),
      {
        code: "ENOENT",
      },
    );
    assert.ok(CONTAINER_STATIC_INPUTS.includes("skills/scotty/SKILL.md"));
    assert.ok(CONTAINER_STATIC_INPUTS.includes("skills/scotty-live-observability/SKILL.md"));
    assert.equal(CONTAINER_STATIC_INPUTS.includes("skills"), false);
    assert.equal(
      await readFile(join(root, CONTAINER_CONTEXT_PATH, "skills/scotty/SKILL.md"), "utf8"),
      "skills/scotty/SKILL.md\n",
    );
    assert.equal(
      await readFile(
        join(root, CONTAINER_CONTEXT_PATH, "skills/scotty-live-observability/SKILL.md"),
        "utf8",
      ),
      "skills/scotty-live-observability/SKILL.md\n",
    );
    for (const input of [
      "scripts/apply-dependency-patches.mjs",
      "patches/alchemy+2.0.0-beta.72.patch",
    ]) {
      assert.equal(await readFile(join(root, CONTAINER_CONTEXT_PATH, input), "utf8"), `${input}\n`);
    }
    for (const input of [
      "tui/package.json",
      "tui/src",
      "patches/earendil-works+pi-coding-agent+0.84.0.patch",
    ]) {
      assert.equal(CONTAINER_STATIC_INPUTS.includes(input), false);
    }
    await assert.rejects(readdir(join(root, CONTAINER_CONTEXT_PATH, "tui")), { code: "ENOENT" });
    await assert.rejects(
      readFile(
        join(root, CONTAINER_CONTEXT_PATH, "patches/earendil-works+pi-coding-agent+0.84.0.patch"),
        "utf8",
      ),
      { code: "ENOENT" },
    );
    assert.equal(
      CONTAINER_STATIC_INPUTS.includes("scripts/project-container-pi-install.mjs"),
      false,
    );
    assert.equal(
      await readFile(join(root, CONTAINER_CONTEXT_PATH, workerCliInput), "utf8"),
      `${workerCliInput}\n`,
    );
    await assert.rejects(
      readFile(join(root, CONTAINER_CONTEXT_PATH, unrelatedWorkerInput), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI installation context and archive listing omit ignored node_modules sentinels", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-packaging-sentinel-"));
  try {
    await writeTree(root, {
      "cli/src/index.ts": "export {};\n",
      "cli/src/node_modules/ignored/index.js": `${SENTINEL}\n`,
      "worker/src/index.ts": "export {};\n",
      "worker/src/node_modules/ignored/index.js": `${SENTINEL}\n`,
      "worker/public/index.html": "<html></html>\n",
      "worker/public/node_modules/ignored/index.js": `${SENTINEL}\n`,
    });

    const inputs = ["cli/src", "worker/src", "worker/public"];
    const archiveFiles = await listPackagedFiles(root, inputs);
    assert.deepEqual([...archiveFiles].sort(), [
      "cli/src/index.ts",
      "worker/public/index.html",
      "worker/src/index.ts",
    ]);

    const destination = join(root, "packaged");
    await materializeProjectInputs(root, destination, inputs);
    assert.deepEqual(await listAllFiles(destination), [...archiveFiles].sort());

    await prepareContainerContext(root, {
      inputs: CONTAINER_INPUTS.filter((input) => input === "cli/src" || input === "worker/src"),
    });
    await assert.rejects(
      readFile(join(root, CONTAINER_CONTEXT_PATH, "cli/src/node_modules/ignored/index.js"), "utf8"),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(
        join(root, CONTAINER_CONTEXT_PATH, "worker/src/node_modules/ignored/index.js"),
        "utf8",
      ),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(join(root, CONTAINER_CONTEXT_PATH, "cli/src/index.ts"), "utf8"),
      "export {};\n",
    );
    await assertContainerContextBudget(join(root, CONTAINER_CONTEXT_PATH));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkout roots under node_modules or .git still copy project files and omit nested exclusions", async () => {
  for (const ancestor of ["node_modules", ".git"]) {
    const parent = await mkdtemp(join(tmpdir(), "scotty-packaging-ancestor-"));
    const root = join(parent, ancestor, "checkout");
    try {
      await writeTree(root, {
        "cli/src/index.ts": "export {};\n",
        "cli/src/keep.txt": "keep\n",
        "cli/src/node_modules/ignored/index.js": `${SENTINEL}\n`,
        "cli/src/.git/config": `${SENTINEL}\n`,
        "worker/src/index.ts": "export {};\n",
        "worker/src/node_modules/ignored/index.js": `${SENTINEL}\n`,
      });

      const inputs = ["cli/src", "worker/src"];
      const listed = await listPackagedFiles(root, inputs);
      assert.deepEqual([...listed].sort(), [
        "cli/src/index.ts",
        "cli/src/keep.txt",
        "worker/src/index.ts",
      ]);

      const destination = join(root, "packaged");
      await materializeProjectInputs(root, destination, inputs);
      assert.deepEqual(await listAllFiles(destination), [...listed].sort());
      assert.equal(await readFile(join(destination, "cli/src/index.ts"), "utf8"), "export {};\n");
      await assert.rejects(readFile(join(destination, "cli/src/node_modules/ignored/index.js")), {
        code: "ENOENT",
      });
      await assert.rejects(readFile(join(destination, "cli/src/.git/config")), { code: "ENOENT" });

      await prepareContainerContext(root, { inputs });
      assert.deepEqual(await listAllFiles(join(root, CONTAINER_CONTEXT_PATH)), [...listed].sort());
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test("CLI build metadata excludes installed dependencies and rejects paths outside the repo", () => {
  assert.deepEqual(
    projectContainerCliInputs({
      inputs: {
        "cli/scotty.ts": {},
        "worker/src/runner/control.ts": {},
        "node_modules/effect/dist/index.js": {},
        "cli/src/node_modules/ignored.js": {},
        ".git/config": {},
        "worker/src/.git/HEAD": {},
      },
    }),
    ["cli/scotty.ts", "worker/src/runner/control.ts"],
  );
  assert.equal(isSafeProjectPath("cli/src/index.ts"), true);
  assert.equal(isSafeProjectPath("../outside.ts"), false);
  assert.equal(isSafeProjectPath("/abs.ts"), false);
  assert.equal(isSafeProjectPath("cli/src/../secret.ts"), false);
  assert.equal(isSafeProjectPath("cli//src.ts"), false);
  assert.throws(() => assertSafeProjectPath("../outside.ts"), /outside the repository/u);
  assert.throws(
    () => projectContainerCliInputs({ inputs: { "../outside.ts": {} } }),
    /outside the repository/u,
  );
  assert.throws(() => projectContainerCliInputs(null), /input map/u);
  assert.throws(() => projectContainerCliInputs({ inputs: [] }), /input map/u);
});

test("container context budget rejects node_modules, preinstalled Playwright, and oversize trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-context-budget-"));
  try {
    await writeTree(root, {
      "cli/src/index.ts": "export {};\n",
      "cli/src/node_modules/ignored/index.js": `${SENTINEL}\n`,
      "worker/container/pi-packages/sources/example/node_modules/playwright-core/index.js":
        "export {};\n",
    });
    await assert.rejects(assertContainerContextBudget(root), /excluded paths/u);

    const oversized = await mkdtemp(join(tmpdir(), "scotty-context-bytes-"));
    try {
      await writeFile(
        join(oversized, "payload.bin"),
        Buffer.alloc(CONTAINER_CONTEXT_BUDGET.maxBytes + 1),
      );
      await assert.rejects(assertContainerContextBudget(oversized), /bytes/u);
    } finally {
      await rm(oversized, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("named context and image budgets sit above the current measured sizes", async () => {
  assert.equal(CONTAINER_CONTEXT_BUDGET.maxFiles, 2_000);
  assert.equal(CONTAINER_CONTEXT_BUDGET.maxBytes, 40 * 1024 * 1024);
  assert.equal(CONTAINER_IMAGE_BUDGET.metric, "docker image inspect Size");
  assert.equal(CONTAINER_IMAGE_BUDGET.maxBytes, 1_250 * 1024 * 1024);
  assertContainerImageBudget(1_038_798_880);
  assert.throws(
    () => assertContainerImageBudget(CONTAINER_IMAGE_BUDGET.maxBytes + 1),
    /docker image inspect Size/u,
  );
  assert.equal(
    await inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => ({ stdout: "1038798880\n" }),
    }),
    1_038_798_880,
  );
  await assert.rejects(
    inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => {
        throw new Error("Error: No such object: scotty-container:ci");
      },
    }),
    /Failed to docker image inspect Size for scotty-container:ci/u,
  );
  await assert.rejects(
    inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => ({ stdout: "not-a-size\n" }),
    }),
    /was not an integer/u,
  );
  await assert.rejects(
    inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => ({ stdout: `${CONTAINER_IMAGE_BUDGET.maxBytes + 1}\n` }),
    }),
    /docker image inspect Size is \d+ bytes; budget is/u,
  );
});
