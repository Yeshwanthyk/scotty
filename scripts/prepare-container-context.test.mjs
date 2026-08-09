import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CONTAINER_CONTEXT_PATH,
  CONTAINER_INPUTS,
  prepareContainerContext,
} from "./prepare-container-context.mjs";

test("the Container context excludes local dependency and git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "scotty-container-context-"));
  try {
    for (const input of CONTAINER_INPUTS) {
      const path = join(root, input);
      if (input.endsWith(".json") || input.endsWith(".ts")) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${input}\n`);
      } else {
        await mkdir(path, { recursive: true });
      }
    }

    const sourceRoot = join(root, "worker/container/pi-packages/sources/example");
    await mkdir(join(sourceRoot, "node_modules/dependency/.git"), { recursive: true });
    await writeFile(join(sourceRoot, "index.js"), "export {};\n");
    await writeFile(join(sourceRoot, "node_modules/dependency/index.js"), "ignored\n");

    await prepareContainerContext(root);

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
