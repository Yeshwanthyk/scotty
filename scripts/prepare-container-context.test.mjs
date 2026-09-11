import assert from "node:assert/strict";
import {
  copyFile,
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  CODEX_BUNDLE_SMOKE,
  CODEX_SERVER_PROOF,
  CODEX_FAKE_CHILD,
  codexFixtureLaunch,
} from "./check-container-image.mjs";
import {
  CONTAINER_CONTEXT_PATH,
  CONTAINER_CONTEXT_BUDGET,
  CONTAINER_IMAGE_BUDGET,
  CONTAINER_INPUTS,
  CONTAINER_STATIC_INPUTS,
  assertContainerCopyInputs,
  assertContainerContextBudget,
  assertContainerImageBudget,
  assertRootDockerignoreInputs,
  assertSafeProjectPath,
  discoverContainerCliInputs,
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

test("prepared contexts fail before Docker when a COPY source is missing", async () => {
  const context = await mkdtemp(join(tmpdir(), "scotty-missing-copy-input-"));
  try {
    await writeTree(context, {
      "worker/container/Dockerfile":
        "FROM scratch\nCOPY worker/container/notices.txt /notices.txt\n",
    });
    await assert.rejects(
      assertContainerCopyInputs(context),
      /missing Docker COPY inputs: worker\/container\/notices\.txt/u,
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("root Docker ignore rules fail closed when a required input is excluded", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-dockerignore-input-"));
  try {
    await writeFile(join(root, ".dockerignore"), "**\n!package.json\n");
    await assert.rejects(
      assertRootDockerignoreInputs(root, ["package.json", "patches/required.patch"]),
      /excludes required container inputs: patches\/required\.patch/u,
    );
    await writeFile(
      join(root, ".dockerignore"),
      "**\n!package.json\n!patches/\n!patches/required.patch\n",
    );
    assert.deepEqual(
      await assertRootDockerignoreInputs(root, ["package.json", "patches/required.patch"]),
      ["package.json", "patches/required.patch"],
    );
    await writeFile(
      join(root, ".dockerignore"),
      "**\n!package.json\n!patches/\n!patches/required.patch\npatches/required.patch\n",
    );
    await assert.rejects(
      assertRootDockerignoreInputs(root, ["package.json", "patches/required.patch"]),
      /excludes required container inputs: patches\/required\.patch/u,
    );
    await writeFile(join(root, ".dockerignore"), "**\n!package.json\npackage.json\n");
    await assert.rejects(
      assertRootDockerignoreInputs(root, ["package.json"]),
      /excludes required container inputs: package\.json/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared contexts validate required copied leaves against final ignore rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-dockerignore-leaves-"));
  try {
    await writeTree(root, {
      ".dockerignore":
        "**\n!worker/\n!worker/container/\n!worker/container/pi-packages/\n!worker/container/pi-packages/settings.json\nworker/container/pi-packages/settings.json\n",
      "worker/container/pi-packages/settings.json": "{}\n",
    });
    await assert.rejects(
      prepareContainerContext(root, { inputs: ["worker/container"] }),
      /excludes required container inputs: worker\/container\/pi-packages\/settings\.json/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root Docker ignore validation applies ordinary wildcard exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-dockerignore-wildcard-"));
  try {
    await writeFile(
      join(root, ".dockerignore"),
      "**\n!worker/container/**\nworker/container/pi-packages/*.json\n",
    );
    await assert.rejects(
      assertRootDockerignoreInputs(root, ["worker/container/pi-packages/settings.json"]),
      /excludes required container inputs: worker\/container\/pi-packages\/settings\.json/u,
    );
    await writeFile(join(root, ".dockerignore"), "*.tmp\n");
    assert.deepEqual(await assertRootDockerignoreInputs(root, ["package.json"]), ["package.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared contexts validate discovered Codex leaves against final ignore rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-dockerignore-codex-"));
  const source = "worker/src/agent/codex/main.ts";
  try {
    await writeTree(root, {
      ".dockerignore": `**\n!worker/\n!worker/src/\n!worker/src/agent/\n!worker/src/agent/codex/\n!${source}\n${source}\n`,
      [source]: "export {};\n",
    });
    await assert.rejects(
      prepareContainerContext(root, { inputs: [source] }),
      /excludes required container inputs: worker\/src\/agent\/codex\/main\.ts/u,
    );
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
      "patches/alchemy+2.0.0-beta.76.patch",
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
  assert.equal(CONTAINER_IMAGE_BUDGET.metric, "visible root filesystem apparent size (du -sbx /)");
  assert.equal(CONTAINER_IMAGE_BUDGET.baselineBytes, 3_119_833_948);
  assert.equal(CONTAINER_IMAGE_BUDGET.maxBytes, 3_250 * 1024 * 1024);
  assertContainerImageBudget(CONTAINER_IMAGE_BUDGET.baselineBytes);
  assert.throws(
    () => assertContainerImageBudget(CONTAINER_IMAGE_BUDGET.maxBytes + 1),
    /visible root filesystem apparent size/u,
  );
  assert.equal(
    await inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => ({ stdout: "3119833948\t/\n" }),
    }),
    3_119_833_948,
  );
  await assert.rejects(
    inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => {
        throw new Error("Error: No such object: scotty-container:ci");
      },
    }),
    /Failed to visible root filesystem apparent size.*for scotty-container:ci/u,
  );
  await assert.rejects(
    inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => ({ stdout: "not-a-size\n" }),
    }),
    /was not an integer/u,
  );
  await assert.rejects(
    inspectContainerImageBudget("scotty-container:ci", {
      exec: async () => ({ stdout: `${CONTAINER_IMAGE_BUDGET.maxBytes + 1}\t/\n` }),
    }),
    /visible root filesystem apparent size.*is \d+ bytes; budget is/u,
  );
});

test("discovery follows transitive container-only source imports without including dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-container-graph-"));
  try {
    await writeTree(root, {
      "cli/scotty.ts": "console.log('cli');",
      "worker/src/agent/codex/server.ts": "export { value } from './server-only.ts';",
      "worker/src/agent/codex/server-only.ts": "export const value = 1;",
      "worker/src/agent/codex/main.ts":
        "export { value } from '../../../../protocol/codex-app-server.ts';",
      "worker/src/sandbox/skill-commands.ts": "export const value = 1;",
      "protocol/codex-app-server.ts": "export { value } from './codex-dependency.ts';",
      "protocol/codex-dependency.ts": "export { value } from './nested/value.ts';",
      "protocol/nested/value.ts": "export const value = 42;",
      "protocol/unrelated.ts": "export const ignored = true;",
    });
    assert.deepEqual(await discoverContainerCliInputs(root), [
      "cli/scotty.ts",
      "protocol/codex-app-server.ts",
      "protocol/codex-dependency.ts",
      "protocol/nested/value.ts",
      "worker/src/agent/codex/main.ts",
      "worker/src/agent/codex/server-only.ts",
      "worker/src/agent/codex/server.ts",
      "worker/src/sandbox/skill-commands.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real discovery prepares and bundles the Effect Codex host for standalone native Node", async (t) => {
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "scotty-real-container-context-"));
  try {
    const discovered = await discoverContainerCliInputs(checkout);
    assert.ok(discovered.includes("protocol/codex-app-server.ts"));
    for (const module of [
      "main",
      "process",
      "session",
      "framing",
      "errors",
      "server",
      "runtime",
      "token-file",
    ]) {
      assert.ok(discovered.includes(`worker/src/agent/codex/${module}.ts`));
    }
    assert.ok(discovered.includes("cli/scotty.ts"));
    assert.ok(discovered.every((path) => !path.split("/").includes("node_modules")));
    await materializeProjectInputs(checkout, root, [...CONTAINER_STATIC_INPUTS, ...discovered]);
    await prepareContainerContext(root, { discoverCliInputs: async () => discovered });
    const context = join(root, CONTAINER_CONTEXT_PATH);
    const measured = await assertContainerContextBudget(context);
    t.diagnostic(`Prepared context: ${measured.fileCount} files, ${measured.bytes} bytes`);
    assert.equal(
      await readFile(join(context, "protocol/codex-app-server.ts"), "utf8"),
      await readFile(join(checkout, "protocol/codex-app-server.ts"), "utf8"),
    );
    const lock = JSON.parse(await readFile(join(context, "package-lock.json"), "utf8"));
    const installed = JSON.parse(
      await readFile(join(checkout, "node_modules/effect/package.json"), "utf8"),
    );
    assert.equal(installed.version, lock.packages["node_modules/effect"].version);
    assert.equal(installed.version, "4.0.0-rc.112");
    for (const name of ["platform-node", "platform-node-shared"]) {
      const dependency = JSON.parse(
        await readFile(join(checkout, `node_modules/@effect/${name}/package.json`), "utf8"),
      );
      assert.equal(dependency.version, lock.packages[`node_modules/@effect/${name}`].version);
      assert.equal(dependency.version, "4.0.0-rc.112");
    }
    // Reuse locked local dependencies only after proving the pre-install context exclusions.
    await symlink(join(checkout, "node_modules"), join(context, "node_modules"), "dir");
    const output = join(root, "native");
    await mkdir(output);
    const dockerfile = await readFile(join(context, "worker/container/Dockerfile"), "utf8");
    const build = dockerfile
      .split("\n")
      .find((line) => line.startsWith("RUN bun build worker/src/agent/codex/main.ts "));
    assert.ok(build, "Dockerfile must build the Effect host bundle");
    execFileSync(
      "bun",
      build
        .slice("RUN bun ".length)
        .split(" ")
        .map((arg) =>
          arg === "--outfile=/out/scotty-codex-host.mjs"
            ? `--outfile=${join(output, "scotty-codex-host.mjs")}`
            : arg,
        ),
      { cwd: context, stdio: "pipe" },
    );
    const serverBuild = dockerfile
      .split("\n")
      .find((line) => line.startsWith("RUN bun build worker/src/agent/codex/server.ts "));
    assert.ok(serverBuild);
    execFileSync(
      "bun",
      serverBuild
        .slice("RUN bun ".length)
        .split(" ")
        .map((arg) =>
          arg === "--outfile=/out/scotty-codex-server.mjs"
            ? `--outfile=${join(output, "scotty-codex-server.mjs")}`
            : arg,
        ),
      { cwd: context, stdio: "pipe" },
    );
    await copyFile(
      join(context, "worker/container/scotty-codex-server.mjs"),
      join(output, "scotty-codex-server"),
    );
    await chmod(join(output, "scotty-codex-server"), 0o755);
    await t.test(
      "installed private server authenticates, admits, reads, and stops without claiming teardown",
      () => {
        execFileSync(process.execPath, ["--input-type=module", "-e", CODEX_SERVER_PROOF], {
          cwd: output,
          stdio: "pipe",
          env: { PATH: process.env.PATH },
          timeout: 30_000,
        });
      },
    );
    execFileSync(process.execPath, ["--input-type=module", "-e", CODEX_BUNDLE_SMOKE], {
      cwd: output,
      stdio: "pipe",
      env: { PATH: process.env.PATH },
    });

    await t.test("stages the actual native host beside its bundle", async () => {
      const host = join(context, "worker/container/scotty-codex-session.mjs");
      const source = await readFile(host, "utf8");
      assert.match(source, /from ["']\.\/scotty-codex-host\.mjs["']/u);
      await copyFile(host, join(output, "scotty-codex-session"));
      execFileSync(process.execPath, ["--check", join(output, "scotty-codex-session")], {
        stdio: "pipe",
      });
      const fake = join(output, "fake-codex");
      await writeFile(fake, `#!${process.execPath}\n${CODEX_FAKE_CHILD}`);
      await chmod(fake, 0o755);
      const workspace = join(root, "parent-workspace");
      await mkdir(workspace);
      const transcript = execFileSync(
        process.execPath,
        [
          join(output, "scotty-codex-session"),
          JSON.stringify(codexFixtureLaunch(fake, join(root, "isolated"), workspace)),
        ],
        {
          input: "",
          encoding: "utf8",
          env: {},
          timeout: 10000,
        },
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(
        transcript.map((record) => record.type),
        ["ready", "stopped"],
      );
      assert.equal(transcript[0].settings.reasoningEffort, "high");
      assert.equal(transcript[1].shutdown, "eof");
      assert.equal(transcript[1].parent, "exited");
      assert.equal(transcript[1].descendants, "unverified");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
