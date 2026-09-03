import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_INPUTS, listPackagedFiles } from "../cli/src/deployment-packaging.mjs";
import {
  PREBUILT_MAIN_WORKER_ENTRY,
  PREBUILT_RUNNER_WORKER_ENTRY,
  PREBUILT_WORKER_MARKER,
  PREBUILT_WORKER_ROOT,
} from "../cli/src/prebuilt-worker-bundles.ts";
import { DEPENDENCY_PATCHES } from "./apply-dependency-patches.mjs";
import { bundleDeploymentWorkers } from "./bundle-deployment-workers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = join(root, ".scotty-build");
const archivePath = join(buildDirectory, "scotty-deployment.tar.gz");
const entryPath = join(buildDirectory, "standalone.ts");
const output = resolve(process.argv[2] ?? join(root, "dist", "scotty"));
const compileTarget = process.env.SCOTTY_COMPILE_TARGET;

const buildBrowserAssets = () => {
  const result = spawnSync("npm", ["run", "ui:build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`UI build failed with exit code ${result.status ?? "unknown"}`);
  }
};

const CRITICAL_ARCHIVE_ENTRIES = Object.freeze([
  "package.json",
  PREBUILT_MAIN_WORKER_ENTRY,
  PREBUILT_RUNNER_WORKER_ENTRY,
  PREBUILT_WORKER_MARKER,
  "worker/container/Dockerfile",
  ...DEPENDENCY_PATCHES,
]);

const validateArchive = async () => {
  const validationRoot = await mkdtemp(join(tmpdir(), "scotty-build-archive-"));
  try {
    await new Bun.Archive(await readFile(archivePath)).extract(validationRoot);
    const invalidEntries = [];
    for (const entry of CRITICAL_ARCHIVE_ENTRIES) {
      try {
        if ((await readFile(join(validationRoot, entry))).byteLength === 0) {
          invalidEntries.push(entry);
        }
      } catch {
        invalidEntries.push(entry);
      }
    }
    if (invalidEntries.length > 0) {
      throw new Error(
        `Embedded deployment archive has missing, unreadable, or empty critical entries: ${invalidEntries.join(", ")}`,
      );
    }
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
};

await rm(buildDirectory, { recursive: true, force: true });
await mkdir(buildDirectory, { recursive: true });
// The finished output is outside these generated input roots and survives cleanup.
try {
  buildBrowserAssets();
  await bundleDeploymentWorkers({ projectRoot: root });
  const files = {};
  for (const relativePath of await listPackagedFiles(root, DEPLOYMENT_INPUTS)) {
    files[relativePath] = await readFile(join(root, relativePath));
  }
  await Bun.Archive.write(archivePath, files, { compress: "gzip", level: 9 });
  await validateArchive();

  const archiveImport = JSON.stringify(`./${relative(buildDirectory, archivePath)}`);
  const cliImport = JSON.stringify(`../cli/scotty.ts`);
  await Bun.write(
    entryPath,
    [
      `import ${archiveImport} with { type: "file" };`,
      `import { main } from ${cliImport};`,
      "process.exitCode = await main();",
      "",
    ].join("\n"),
  );
  await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    compile: {
      outfile: output,
      ...(compileTarget ? { target: compileTarget } : {}),
    },
    minify: true,
    sourcemap: "none",
  });
} finally {
  await Promise.all([
    rm(buildDirectory, { recursive: true, force: true }),
    rm(join(root, PREBUILT_WORKER_ROOT), { recursive: true, force: true }),
  ]);
}
process.stdout.write(`${output}\n`);
