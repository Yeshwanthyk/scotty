import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CONTAINER_CONTEXT_PATH,
  CONTAINER_STATIC_INPUTS,
  prepareContainerContext,
  projectContainerCliInputs,
} from "./prepare-container-context.mjs";

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
    const workerCliInput = "worker/src/runner-control.ts";
    const unrelatedWorkerInput = "worker/src/index.ts";
    for (const input of [cliInput, workerCliInput, unrelatedWorkerInput]) {
      await mkdir(dirname(join(root, input)), { recursive: true });
      await writeFile(join(root, input), `${input}\n`);
    }

    const sourceRoot = join(root, "worker/container/pi-packages/sources/example");
    await mkdir(join(sourceRoot, "node_modules/dependency/.git"), { recursive: true });
    await writeFile(join(sourceRoot, "index.js"), "export {};\n");
    await writeFile(join(sourceRoot, "node_modules/dependency/index.js"), "ignored\n");

    await prepareContainerContext(root, {
      discoverCliInputs: async () => [cliInput, workerCliInput],
    });

    const contextSource = join(
      root,
      CONTAINER_CONTEXT_PATH,
      "worker/container/pi-packages/sources/example",
    );
    assert.equal(await readFile(join(contextSource, "index.js"), "utf8"), "export {};\n");
    await assert.rejects(
      readFile(join(contextSource, "node_modules/dependency/index.js"), "utf8"),
      {
        code: "ENOENT",
      },
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

test("CLI build metadata excludes installed dependencies and rejects paths outside the repo", () => {
  assert.deepEqual(
    projectContainerCliInputs({
      inputs: {
        "cli/scotty.ts": {},
        "worker/src/runner-control.ts": {},
        "node_modules/effect/dist/index.js": {},
      },
    }),
    ["cli/scotty.ts", "worker/src/runner-control.ts"],
  );
  assert.throws(
    () => projectContainerCliInputs({ inputs: { "../outside.ts": {} } }),
    /outside the repository/u,
  );
});
