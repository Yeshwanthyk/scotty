import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
// Upgrade-sensitive boundary: Alchemy 2.0.0-beta.72 exposes no public bundler API, so use
// its exact-pinned compiled WorkerBundle provider rather than maintaining a parallel bundler.
import { WorkerBundle } from "../node_modules/alchemy/lib/Cloudflare/Workers/Sources/Rolldown.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  barePackageImports,
  MAIN_WORKER_EXPORTS,
  missingRunnerStackPlaceholders,
  missingWorkerBundleExports,
  PREBUILT_MAIN_WORKER_DIR,
  PREBUILT_MAIN_WORKER_ENTRY,
  PREBUILT_RUNNER_WORKER_DIR,
  PREBUILT_RUNNER_WORKER_ENTRY,
  PREBUILT_STACK_NAME_PLACEHOLDER,
  PREBUILT_STACK_STAGE_PLACEHOLDER,
  PREBUILT_WORKER_MARKER,
  PREBUILT_WORKER_ROOT,
  RUNNER_WORKER_EXPORTS,
} from "../cli/src/prebuilt-worker-bundles.ts";

const assertNoBarePackageImports = (label, sources) => {
  const bareImports = barePackageImports(sources);
  if (bareImports.length > 0) {
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: CLI build script validates bundle shape before packaging
    throw new Error(
      `Prebuilt ${label} worker bundle retains bare package imports: ${bareImports.join(", ")}`,
    );
  }
};

const assertPrebuiltBundleChecks = (
  mainEntrySource,
  runnerEntrySource,
  mainSources,
  runnerSources,
) => {
  const missingMainExports = missingWorkerBundleExports([mainEntrySource], MAIN_WORKER_EXPORTS);
  if (missingMainExports.length > 0) {
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: CLI build script validates bundle shape before packaging
    throw new Error(`Prebuilt worker bundle is missing exports: ${missingMainExports.join(", ")}`);
  }
  const missingRunnerExports = missingWorkerBundleExports(
    [runnerEntrySource],
    RUNNER_WORKER_EXPORTS,
  );
  if (missingRunnerExports.length > 0) {
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: CLI build script validates bundle shape before packaging
    throw new Error(
      `Prebuilt worker bundle is missing exports: ${missingRunnerExports.join(", ")}`,
    );
  }
  assertNoBarePackageImports("main", mainSources);
  assertNoBarePackageImports("runner", runnerSources);
  const missingPlaceholders = missingRunnerStackPlaceholders(runnerSources.join("\n"));
  if (missingPlaceholders.length > 0) {
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: CLI build script validates bundle shape before packaging
    throw new Error(
      `Prebuilt runner worker bundle is missing stack placeholders: ${missingPlaceholders.join(", ")}`,
    );
  }
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compatibility = Object.freeze({ date: "2026-07-20", flags: ["nodejs_compat"] });

const decodeBundleContent = (content) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

const stubDurableObjectExport = Object.freeze({
  kind: "durableObject",
  constructor: Effect.succeed(Effect.succeed({})),
  services: Context.empty(),
});

const writeBundleOutput = async (outputDirectory, bundleOutput) => {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const file of bundleOutput.files) {
    if (file.path.endsWith(".map")) continue;
    const destination = join(outputDirectory, basename(file.path));
    await writeFile(destination, file.content);
  }
  const entryBasename = basename(bundleOutput.files[0].path);
  if (entryBasename !== "index.js") {
    await writeFile(
      join(outputDirectory, "index.js"),
      await readFile(join(outputDirectory, entryBasename)),
    );
  }
};

const readBundleSources = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js") || entry.name.endsWith(".map.js")) continue;
    sources.push(decodeBundleContent(await readFile(join(directory, entry.name))));
  }
  return sources;
};

const bundleWorker = (options) =>
  Effect.gen(function* () {
    const bundler = yield* WorkerBundle;
    return yield* bundler.build(options);
  }).pipe(Effect.provide(NodeServices.layer));

const bundleMainWorker = () =>
  bundleWorker({
    id: "scotty-main-worker",
    main: join(root, "worker/src/index.ts"),
    compatibility,
    entry: { kind: "external" },
    stack: { name: "scotty-prebuilt-main", stage: "production" },
    extraOptions: undefined,
  });

const bundleRunnerWorker = () =>
  bundleWorker({
    id: "scotty-runner-worker",
    main: join(root, "worker/src/runner-worker.ts"),
    compatibility,
    entry: {
      kind: "effect",
      exports: {
        ScottyRunner: stubDurableObjectExport,
      },
    },
    stack: {
      name: PREBUILT_STACK_NAME_PLACEHOLDER,
      stage: PREBUILT_STACK_STAGE_PLACEHOLDER,
    },
    extraOptions: undefined,
  });

export const bundleDeploymentWorkers = async ({ projectRoot = root } = {}) => {
  const prebuiltRoot = join(projectRoot, PREBUILT_WORKER_ROOT);
  const mainDirectory = join(projectRoot, PREBUILT_MAIN_WORKER_DIR);
  const runnerDirectory = join(projectRoot, PREBUILT_RUNNER_WORKER_DIR);

  await rm(prebuiltRoot, { recursive: true, force: true });
  await mkdir(prebuiltRoot, { recursive: true });

  const [mainOutput, runnerOutput] = await Effect.runPromise(
    Effect.all([bundleMainWorker(), bundleRunnerWorker()], { concurrency: "unbounded" }),
  );

  await writeBundleOutput(mainDirectory, mainOutput);
  await writeBundleOutput(runnerDirectory, runnerOutput);

  const mainSources = await readBundleSources(mainDirectory);
  const runnerSources = await readBundleSources(runnerDirectory);
  const mainEntrySource = decodeBundleContent(
    await readFile(join(projectRoot, PREBUILT_MAIN_WORKER_ENTRY)),
  );
  const runnerEntrySource = decodeBundleContent(
    await readFile(join(projectRoot, PREBUILT_RUNNER_WORKER_ENTRY)),
  );
  assertPrebuiltBundleChecks(mainEntrySource, runnerEntrySource, mainSources, runnerSources);

  await writeFile(join(projectRoot, PREBUILT_WORKER_MARKER), "prebuilt\n", "utf8");

  return {
    mainEntry: PREBUILT_MAIN_WORKER_ENTRY,
    runnerEntry: PREBUILT_RUNNER_WORKER_ENTRY,
  };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await bundleDeploymentWorkers();
  process.stdout.write(`${PREBUILT_WORKER_ROOT}\n`);
}
