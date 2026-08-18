import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  barePackageImports,
  collectBarePackageImports,
  collectExportClassNames,
  isPrebuiltWorkerDeploymentRoot,
  MAIN_WORKER_EXPORTS,
  missingPrebuiltWorkerEntries,
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
  remainingRunnerStackPlaceholders,
  replaceRunnerStackPlaceholders,
  rewritePrebuiltRunnerStackPlaceholders,
  RUNNER_WORKER_EXPORTS,
} from "../src/prebuilt-worker-bundles.ts";
import { DEPLOYMENT_INPUTS } from "../src/deployment-packaging.ts";
import { bundleDeploymentWorkers } from "../../scripts/bundle-deployment-workers.mjs";
import { listPackagedFiles, materializeProjectInputs } from "../src/deployment-packaging.mjs";

describe("prebuilt worker bundle helpers", () => {
  it("replaces runner stack placeholders with installation identity", () => {
    const source = `name: "${PREBUILT_STACK_NAME_PLACEHOLDER}", stage: "${PREBUILT_STACK_STAGE_PLACEHOLDER}"`;
    expect(replaceRunnerStackPlaceholders(source, "Scotty-demo", "production")).toBe(
      'name: "Scotty-demo", stage: "production"',
    );
  });

  it("escapes user-supplied stack identity as JavaScript string content", () => {
    const source = `name: "${PREBUILT_STACK_NAME_PLACEHOLDER}", stage: \`${PREBUILT_STACK_STAGE_PLACEHOLDER}\``;
    const rewritten = replaceRunnerStackPlaceholders(
      source,
      "Scotty-\"double\"'single'\\path\nnext",
      "prod`${unsafe}\\path\nnext",
    );
    expect(rewritten).toContain('\\"double\\"');
    expect(rewritten).toContain("\\u0027single\\u0027");
    expect(rewritten).toContain("\\\\path\\nnext");
    expect(rewritten).toContain("\\u0060\\u0024{unsafe}");
    expect(remainingRunnerStackPlaceholders(rewritten)).toEqual([]);
  });

  it("rewrites runner placeholders on the filesystem and verifies their removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "scotty-runner-rewrite-"));
    try {
      const runnerDirectory = join(root, PREBUILT_RUNNER_WORKER_DIR);
      await mkdir(runnerDirectory, { recursive: true });
      const entry = join(root, PREBUILT_RUNNER_WORKER_ENTRY);
      await writeFile(
        entry,
        `name: "${PREBUILT_STACK_NAME_PLACEHOLDER}", stage: "${PREBUILT_STACK_STAGE_PLACEHOLDER}"`,
      );
      await rewritePrebuiltRunnerStackPlaceholders(
        root,
        'Scotty-"quoted"\\path\nnext',
        "production",
      );
      const rewritten = await readFile(entry, "utf8");
      expect(remainingRunnerStackPlaceholders(rewritten)).toEqual([]);
      expect(rewritten).toContain('Scotty-\\"quoted\\"\\\\path\\nnext');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports empty required prebuilt entries by relative name", async () => {
    const root = await mkdtemp(join(tmpdir(), "scotty-prebuilt-empty-"));
    try {
      await Promise.all([
        mkdir(join(root, PREBUILT_MAIN_WORKER_DIR), { recursive: true }),
        mkdir(join(root, PREBUILT_RUNNER_WORKER_DIR), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, PREBUILT_MAIN_WORKER_ENTRY), "main"),
        writeFile(join(root, PREBUILT_RUNNER_WORKER_ENTRY), "runner"),
        writeFile(join(root, PREBUILT_WORKER_MARKER), ""),
      ]);

      expect(missingPrebuiltWorkerEntries(root)).toEqual([PREBUILT_WORKER_MARKER]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts non-empty required entries projected into an archive root", async () => {
    const root = await mkdtemp(join(tmpdir(), "scotty-prebuilt-projected-"));
    try {
      await Promise.all([
        mkdir(join(root, PREBUILT_MAIN_WORKER_DIR), { recursive: true }),
        mkdir(join(root, PREBUILT_RUNNER_WORKER_DIR), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, PREBUILT_MAIN_WORKER_ENTRY), "main"),
        writeFile(join(root, PREBUILT_RUNNER_WORKER_ENTRY), "runner"),
        writeFile(join(root, PREBUILT_WORKER_MARKER), "prebuilt"),
      ]);
      const archiveRoot = join(root, "archive");
      await materializeProjectInputs(root, archiveRoot, [PREBUILT_WORKER_ROOT]);

      expect(missingPrebuiltWorkerEntries(archiveRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects exported durable object class names", () => {
    const names = collectExportClassNames(`
      export class ScottyRunner extends DurableObjectBridge {}
      export { ScottySandbox, ScottyAuthRegistry as Auth };
    `);
    expect(names).toEqual(expect.arrayContaining(["ScottyRunner", "ScottySandbox", "Auth"]));
  });

  it("rejects every bare package import form while allowing platform specifiers", () => {
    expect(
      collectBarePackageImports(`
        import x from "effect";
        export * from "pkg-export";
        import "pkg-side";
        const dynamic = import("pkg-dynamic");
        const required = require("pkg-require");
        const text = 'import "not-an-import"';
        const template = \`from "also-not-an-import"\`;
        // require("commented-package")
        /* import("block-comment-package") */
        import y from "cloudflare:workers";
        import z from "node:fs";
        import local from "./local.js";
        import absolute from "/absolute.js";
        import path from "path";
      `),
    ).toEqual(["effect", "pkg-export", "pkg-side", "pkg-dynamic", "pkg-require"]);
    expect(barePackageImports(['import x from "effect";'])).toEqual(["effect"]);
  });

  it("reports missing runner stack placeholders before deploy-time substitution", () => {
    expect(missingRunnerStackPlaceholders("no placeholders here")).toEqual([
      PREBUILT_STACK_NAME_PLACEHOLDER,
      PREBUILT_STACK_STAGE_PLACEHOLDER,
    ]);
    expect(
      missingRunnerStackPlaceholders(
        `${PREBUILT_STACK_NAME_PLACEHOLDER}${PREBUILT_STACK_STAGE_PLACEHOLDER}`,
      ),
    ).toEqual([]);
  });

  it("reports missing durable object export names in bundled sources", () => {
    expect(
      missingWorkerBundleExports(["export class ScottySandbox {}"], MAIN_WORKER_EXPORTS),
    ).toEqual(["ScottyAuthRegistry", "ScottyRunnerRegistry", "ScottySandboxConfig"]);
    expect(
      missingWorkerBundleExports(
        [
          "export class ScottySandbox {}",
          "export class ScottyAuthRegistry {}",
          "export class ScottyRunnerRegistry {}",
          "export class ScottySandboxConfig {}",
        ],
        MAIN_WORKER_EXPORTS,
      ),
    ).toEqual([]);
    expect(
      missingWorkerBundleExports(["export class ScottyRunner {}"], RUNNER_WORKER_EXPORTS),
    ).toEqual([]);
  });
});

describe("standalone deployment archive prebuilt workers", () => {
  it("packages prebuilt worker bundles without node_modules and passes bundle assertions", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "scotty-prebuilt-archive-"));
    try {
      await bundleDeploymentWorkers({ projectRoot });
      expect(isPrebuiltWorkerDeploymentRoot(projectRoot)).toBe(true);
      expect(missingPrebuiltWorkerEntries(projectRoot)).toEqual([]);
      expect(DEPLOYMENT_INPUTS).toContain("worker/prebuilt");

      const archiveRoot = join(projectRoot, "archive");
      await materializeProjectInputs(projectRoot, archiveRoot, [PREBUILT_WORKER_ROOT]);
      expect(isPrebuiltWorkerDeploymentRoot(archiveRoot)).toBe(true);
      expect(missingPrebuiltWorkerEntries(archiveRoot)).toEqual([]);

      const mainDirectory = join(archiveRoot, PREBUILT_MAIN_WORKER_DIR);
      const runnerDirectory = join(archiveRoot, PREBUILT_RUNNER_WORKER_DIR);
      const mainSources = await Promise.all(
        (await readdir(mainDirectory))
          .filter((name) => name.endsWith(".js"))
          .map((name) => readFile(join(mainDirectory, name), "utf8")),
      );
      const runnerSources = await Promise.all(
        (await readdir(runnerDirectory))
          .filter((name) => name.endsWith(".js"))
          .map((name) => readFile(join(runnerDirectory, name), "utf8")),
      );
      expect(
        missingWorkerBundleExports(
          [await readFile(join(archiveRoot, PREBUILT_MAIN_WORKER_ENTRY), "utf8")],
          MAIN_WORKER_EXPORTS,
        ),
      ).toEqual([]);
      expect(
        missingWorkerBundleExports(
          [await readFile(join(archiveRoot, PREBUILT_RUNNER_WORKER_ENTRY), "utf8")],
          RUNNER_WORKER_EXPORTS,
        ),
      ).toEqual([]);
      expect(missingRunnerStackPlaceholders(runnerSources.join("\n"))).toEqual([]);
      expect(barePackageImports(mainSources)).toEqual([]);
      expect(barePackageImports(runnerSources)).toEqual([]);

      await rm(join(archiveRoot, "node_modules"), { recursive: true, force: true });
      expect(await readFile(join(archiveRoot, PREBUILT_WORKER_MARKER), "utf8")).toContain(
        "prebuilt",
      );
      const packaged = await listPackagedFiles(archiveRoot, [PREBUILT_WORKER_ROOT]);
      expect(packaged.some((path) => path.startsWith("worker/prebuilt/"))).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
