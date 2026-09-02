import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as Effect from "effect/Effect";
import { makeWorkerRuntimeContext } from "../node_modules/alchemy/lib/Cloudflare/Workers/WorkerRuntimeContext.js";
import { parseContainerControlPlaneSnapshot } from "./container-control-plane.mjs";
import {
  assessContainerSettlement,
  auditProductionHatchEvidenceTopology,
  assertContainerPlanAuthorized,
  assertSettledContainerBaseline,
  assertProductionCredentialWrappingKeyBinding,
  CONTAINER_ROLLOUT_ABSENCE_QUIET_MS,
  createProductionDeploymentProgressReporter,
  executeProductionDeploySteps,
  parseProductionDeployOptions,
  persistProductionDeploymentFailureDiagnostic,
  PRODUCTION_DEPLOY_DIAGNOSTIC_PATH,
  PRODUCTION_DEPLOY_STEPS,
  productionDeploymentFailureHint,
  projectAlchemyDeploymentOutput,
  readAlchemyContainerAction,
  readAlchemyContainerPlanAction,
  redactProductionDeploymentOutput,
  resolveProductionDockerEnvironment,
  resolveProductionTopology,
  runCommand,
  runProductionDeployStep,
  waitForProductionContainerRollout,
} from "./deploy-production.mjs";
import { dedupeBindings, diffBindings, stripEffects } from "../node_modules/alchemy/lib/Diff.js";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const INSTALLATION_ENVIRONMENT = { SCOTTY_INSTALLATION_NAME: "test" };
const PRODUCTION_TOPOLOGY_ENVIRONMENT = {
  ...INSTALLATION_ENVIRONMENT,
  SCOTTY_PREVIEW_BASE: "preview.scotty.example",
  SCOTTY_PREVIEW_ZONE_ID: "0123456789abcdef0123456789abcdef",
  GH_TOKEN: "legacy-github-secret",
  PI_AUTH_JSON: "legacy-pi-secret",
  CREDENTIAL_WRAPPING_KEY: "installation-wrapping-secret",
};
const CONTAINER_APPLICATION_ID = "application-id";
const CONTAINER_APPLICATION_NAME = "scotty-test-sandbox";

const application = (overrides = {}) => ({
  id: CONTAINER_APPLICATION_ID,
  name: CONTAINER_APPLICATION_NAME,
  version: 5,
  updatedAt: "2026-07-23T01:18:50.795Z",
  activeRolloutId: null,
  configurationDigest: "configuration-v5",
  health: {
    active: 0,
    assigned: 0,
    healthy: 7,
    stopped: 0,
    failed: 0,
    scheduling: 0,
    starting: 0,
  },
  ...overrides,
});

const rollout = (overrides = {}) => ({
  id: "rollout-v6",
  status: "progressing",
  createdAt: "2026-07-23T11:47:51.502Z",
  lastUpdatedAt: "2026-07-23T11:47:51.502Z",
  currentVersion: 5,
  targetVersion: 6,
  health: {
    healthy: 0,
    failed: 0,
    scheduling: 0,
    starting: 7,
  },
  progress: {
    totalSteps: 1,
    currentStep: 1,
    updatedInstances: 0,
    totalInstances: 7,
  },
  ...overrides,
});

const snapshot = ({ application: applicationOverrides = {}, rollouts = [] } = {}) => ({
  application: application(applicationOverrides),
  rollouts,
});

describe("production deployment ownership", () => {
  it("preserves an explicit Docker host and resolves the active context otherwise", async () => {
    const explicit = { DOCKER_HOST: "unix:///explicit/docker.sock" };
    assert.equal(await resolveProductionDockerEnvironment(explicit), explicit);

    const resolved = await resolveProductionDockerEnvironment(
      { PATH: "/usr/bin" },
      async (command, args) => {
        assert.equal(command, "docker");
        assert.deepEqual(args, [
          "context",
          "inspect",
          "--format",
          "{{json .Endpoints.docker.Host}}",
        ]);
        return '"unix:///Users/test/.colima/default/docker.sock"\n';
      },
    );
    assert.equal(resolved.DOCKER_HOST, "unix:///Users/test/.colima/default/docker.sock");
  });

  it("keeps the pinned Alchemy deployment backports installed and deterministic", async () => {
    const rootPackage = JSON.parse(read("package.json"));
    const patch = read("patches/alchemy+2.0.0-beta.76.patch");
    const installedApply = read("node_modules/alchemy/lib/Apply.js");
    const installedWorkerProvider = read(
      "node_modules/alchemy/lib/Cloudflare/Workers/WorkerProvider.js",
    );
    const installedWorkerRuntimeContext = read(
      "node_modules/alchemy/lib/Cloudflare/Workers/WorkerRuntimeContext.js",
    );
    const installedContainerProvider = read(
      "node_modules/alchemy/lib/Cloudflare/Containers/ContainerProvider.js",
    );
    const installedDocker = read("node_modules/alchemy/lib/Docker/Docker.js");

    assert.equal(rootPackage.dependencies.alchemy, "2.0.0-beta.76");
    assert.equal(rootPackage.scripts.postinstall, "node scripts/apply-dependency-patches.mjs");
    assert.match(patch, /const oldDoBindings = oldBindings\.flatMap/u);
    assert.doesNotMatch(patch, /bindings: bindingOutputs/u);
    assert.match(installedApply, /bindings: bindingOutputs/u);
    assert.match(installedApply, /bindings: stripUnresolved\(newBindings\)/u);
    assert.match(installedWorkerProvider, /const news = stripEffects\(desired\)/u);
    assert.match(installedWorkerProvider, /const oldDoBindings = oldBindings\.flatMap/u);
    assert.match(
      installedWorkerProvider,
      /getExpectedDurableObjectClassNames\(\s*oldDoBindings,\s*oldWorkerName/u,
    );
    assert.doesNotMatch(installedWorkerProvider, /scriptName: old\.scriptName/u);
    assert.match(patch, /Context is cyclic in Effect v4/u);
    assert.match(installedWorkerRuntimeContext, /if \(phase === "plan"\)/u);

    // Registry credentials are minted for a short window and Docker authenticates
    // only through a scoped temporary DOCKER_CONFIG. Credentials are written to
    // that isolated config, never argv, logs, or the shared credential helper.
    assert.match(installedContainerProvider, /expirationMinutes: 15/u);
    assert.doesNotMatch(installedContainerProvider, /expirationMinutes: 60/u);
    assert.match(installedDocker, /makeTempDirectoryScoped/u);
    assert.match(installedDocker, /auths:/u);
    assert.match(installedDocker, /writeFileString\(path\.join\(dir, "config\.json"\), config\)/u);
    assert.match(installedDocker, /DOCKER_CONFIG: dir/u);
    assert.doesNotMatch(installedDocker, /"--password",/u);
    assert.doesNotMatch(installedDocker, /"login",\s*"--username",/u);
    assert.doesNotMatch(installedDocker, /wrangler/u);
    // The backported provider pushes through Docker; neither it nor the Scotty
    // deployment steps hand the release to `wrangler deploy`.
    assert.doesNotMatch(installedContainerProvider, /"wrangler"/u);
    const deploymentCommands = PRODUCTION_DEPLOY_STEPS.map(
      ({ command, args }) => `${command} ${args.join(" ")}`,
    ).join("\n");
    assert.doesNotMatch(deploymentCommands, /wrangler\s+deploy/u);

    const runtimeContext = makeWorkerRuntimeContext("deployment-props-probe");
    const services = {};
    services.cacheRoot = services;
    await Effect.runPromise(
      runtimeContext.export("Probe", {
        kind: "durableObject",
        constructor: Effect.void,
        services,
      }),
    );
    const deploymentExports = await Effect.runPromise(runtimeContext.exports);
    assert.deepEqual(deploymentExports, { Probe: { kind: "durableObject" } });
    assert.doesNotThrow(() => JSON.stringify(deploymentExports));

    assert.deepEqual(stripEffects({ stable: 1, effect: Effect.succeed(2) }), {
      stable: 1,
      effect: undefined,
    });

    const bindings = [
      { sid: "zeta", data: { value: 1 } },
      { sid: "alpha", data: { value: 2 } },
      { sid: "zeta", data: { value: 3 } },
    ];
    assert.deepEqual(
      dedupeBindings(bindings).map(({ sid, data }) => [sid, data.value]),
      [
        ["alpha", 2],
        ["zeta", 3],
      ],
    );
    assert.deepEqual(
      diffBindings([], bindings).map(({ sid }) => sid),
      ["alpha", "zeta"],
    );
  });

  it("has one guarded local Alchemy production command", () => {
    const rootPackage = JSON.parse(read("package.json"));
    const workerPackage = JSON.parse(read("worker/package.json"));
    const commands = [
      ...Object.values(rootPackage.scripts),
      ...Object.values(workerPackage.scripts),
      read("README.md"),
      read("scripts/deploy-production.mjs"),
    ].join("\n");
    assert.doesNotMatch(commands, /wrangler\s+deploy(?!\s+--dry-run)/u);
    assert.equal(rootPackage.scripts["deploy:production"], "node scripts/deploy-production.mjs");
    assert.equal(workerPackage.scripts.deploy, undefined);
    assert.equal(
      existsSync(new URL("../.github/workflows/deploy-production.yml", import.meta.url)),
      false,
    );
    const readme = read("README.md");
    assert.match(readme, /ARM Mac/u);
    assert.match(readme, /exit code 139/u);
    assert.match(readme, /rerun the same guarded command once/u);
    assert.match(readme, /There is no automatic retry/u);
    assert.match(readme, /npm run deploy:production -- --container/u);
    assert.match(readme, /does not open Docker/u);
  });

  it("checks, audits, deploys through Alchemy, and audits again", () => {
    assert.deepEqual(resolveProductionTopology(PRODUCTION_TOPOLOGY_ENVIRONMENT), {
      installationName: "test",
      workerName: "scotty-test-worker",
      runnerWorkerName: "scotty-test-runner",
      containerName: "scotty-test-sandbox",
      kvTitle: "scotty-test-sessions",
      backupBucketName: "scotty-test-backups",
      artifactBucketName: "scotty-test-artifacts",
      sandboxBundleBucketName: "scotty-test-sandbox-bundles",
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true,
    });
    assert.deepEqual(
      PRODUCTION_DEPLOY_STEPS.map(({ name }) => name),
      [
        "Check repository",
        "Audit current runtime inventory",
        "Prepare isolated Container context",
        "Check Worker credential binding",
        "Plan production through Alchemy",
        "Deploy production through Alchemy",
        "Audit deployed runtime inventory",
      ],
    );
    const commands = PRODUCTION_DEPLOY_STEPS.map(
      ({ command, args }) => `${command} ${args.join(" ")}`,
    );
    assert.equal(
      commands[3],
      "npx --no-install wrangler secret list --name ${workerName} --format json",
    );
    assert.equal(commands[4], "npx --no-install alchemy plan alchemy.run.ts --stage production");
    assert.equal(
      commands[5],
      "npx --no-install alchemy deploy alchemy.run.ts --stage production --yes",
    );
    assert.equal(commands.filter((command) => command === "npm run audit:containers").length, 2);
    assert.equal(
      commands.some((command) => /wrangler\s+deploy/u.test(command)),
      false,
    );
    assert.equal(commands[2], `${process.execPath} scripts/prepare-container-context.mjs`);
    assert.equal(PRODUCTION_DEPLOY_STEPS[1].redact, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[3].capture, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[3].redact, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[4].capture, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[4].tee, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[4].projectOutput, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[5].capture, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[5].tee, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[5].projectOutput, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[5].reportProgress, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[5].explainFailure, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[5].failureDiagnostic, true);
    assert.match(PRODUCTION_DEPLOY_DIAGNOSTIC_PATH, /scotty-production-deploy-failure\.log$/u);
    assert.equal(PRODUCTION_DEPLOY_STEPS[6].redact, true);
    assert.equal(readAlchemyContainerAction("[SandboxContainer] updated\n"), "updated");
    assert.equal(
      readAlchemyContainerAction("\u001B[32m[SandboxContainer] noop\u001B[0m\n"),
      "noop",
    );
  });

  it("requires the Worker wrapping-key binding by name before planning", () => {
    assert.doesNotThrow(() =>
      assertProductionCredentialWrappingKeyBinding(
        JSON.stringify([{ name: "CREDENTIAL_WRAPPING_KEY", type: "secret_text" }]),
      ),
    );
    assert.throws(
      () =>
        assertProductionCredentialWrappingKeyBinding(JSON.stringify([{ name: "SCOTTY_TOKEN" }])),
      /installation_fresh_required.*fresh Scotty installation/u,
    );
    assert.throws(
      () => assertProductionCredentialWrappingKeyBinding(JSON.stringify({ result: [] })),
      /installation_fresh_required/u,
    );
  });

  it("requires an explicit complete preview topology and never derives account identity", () => {
    assert.deepEqual(resolveProductionTopology(PRODUCTION_TOPOLOGY_ENVIRONMENT), {
      installationName: "test",
      workerName: "scotty-test-worker",
      runnerWorkerName: "scotty-test-runner",
      containerName: "scotty-test-sandbox",
      kvTitle: "scotty-test-sessions",
      backupBucketName: "scotty-test-backups",
      artifactBucketName: "scotty-test-artifacts",
      sandboxBundleBucketName: "scotty-test-sandbox-bundles",
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true,
    });
    assert.throws(
      () =>
        resolveProductionTopology({
          ...PRODUCTION_TOPOLOGY_ENVIRONMENT,
          SCOTTY_EVIDENCE_ENABLED: "true",
        }),
      /no longer configurable/u,
    );
    assert.throws(
      () => resolveProductionTopology(INSTALLATION_ENVIRONMENT),
      /requires an explicit Hatch and Evidence preview topology/u,
    );
    for (const environment of [
      { ...INSTALLATION_ENVIRONMENT, SCOTTY_PREVIEW_BASE: "preview.scotty.example" },
      {
        ...INSTALLATION_ENVIRONMENT,
        SCOTTY_PREVIEW_ZONE_ID: "0123456789abcdef0123456789abcdef",
      },
      {
        ...INSTALLATION_ENVIRONMENT,
        SCOTTY_PREVIEW_BASE: "PREVIEW.scotty.example",
        SCOTTY_PREVIEW_ZONE_ID: "0123456789abcdef0123456789abcdef",
      },
    ]) {
      assert.throws(() => resolveProductionTopology(environment), /explicit preview topology/u);
    }
  });

  it("proves active Worker bindings and the wildcard deny route after deployment", async () => {
    const topology = resolveProductionTopology(PRODUCTION_TOPOLOGY_ENVIRONMENT);
    const commands = [];
    const execute = async (_command, args) => {
      commands.push(args);
      if (args.includes("deployments")) {
        return JSON.stringify({ versions: [{ version_id: "version-1", percentage: 100 }] });
      }
      return JSON.stringify({
        resources: {
          bindings: [
            { name: "SCOTTY_EVIDENCE_ENABLED", type: "plain_text", text: "true" },
            {
              name: "SCOTTY_PREVIEW_BASE",
              type: "plain_text",
              text: "preview.scotty.example",
            },
            {
              name: "ARTIFACT_BUCKET",
              type: "r2_bucket",
              bucket_name: "scotty-test-artifacts",
            },
            {
              name: "SANDBOX_BUNDLE_BUCKET",
              type: "r2_bucket",
              bucket_name: "scotty-test-sandbox-bundles",
            },
          ],
        },
      });
    };
    const request = async (url) => {
      assert.equal(url, "https://scotty-topology-probe.preview.scotty.example/");
      return new Response("Not found", {
        status: 404,
        headers: {
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow, noarchive",
        },
      });
    };

    await auditProductionHatchEvidenceTopology(topology, {}, { execute, request });
    assert.equal(commands.length, 2);

    await assert.rejects(
      auditProductionHatchEvidenceTopology(
        topology,
        {},
        {
          execute: async (_command, args) =>
            args.includes("deployments")
              ? JSON.stringify({ versions: [{ version_id: "version-1", percentage: 100 }] })
              : JSON.stringify({ resources: { bindings: [] } }),
          request,
        },
      ),
      /missing required Hatch or Evidence bindings/u,
    );
  });

  it("redacts production identity while keeping useful deployment progress", () => {
    const environment = {
      SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED: [
        "confirmed",
        "test",
        "worker=scotty-test-worker",
        "runnerWorker=scotty-test-runner",
        "container=scotty-test-sandbox",
        "kv=scotty-test-sessions",
        "r2=scotty-test-backups",
        "artifacts=scotty-test-artifacts",
        "sandboxBundles=scotty-test-sandbox-bundles",
      ].join(":"),
    };
    const privateOutput = [
      "accountId: '0123456789abcdef0123456789abcdef'",
      "url: 'https://scotty-test-worker.example.workers.dev/private'",
      "application: a030af24-612c-4eb0-81cd-873740807d1d",
      "building scotty-test-sandbox and scotty-test-backups",
    ].join("\n");
    const redacted = redactProductionDeploymentOutput(privateOutput, environment);
    assert.doesNotMatch(redacted, /0123456789abcdef0123456789abcdef/u);
    assert.doesNotMatch(redacted, /workers\.dev/u);
    assert.doesNotMatch(redacted, /a030af24-612c-4eb0-81cd-873740807d1d/u);
    assert.doesNotMatch(
      redacted,
      /scotty-test-(?:worker|sandbox|backups|artifacts|sandbox-bundles)/u,
    );
    assert.match(redacted, /\[redacted-account-id\]/u);
    assert.match(redacted, /\[redacted-worker-url\]/u);
    assert.match(redacted, /\[redacted-resource-id\]/u);

    const projected = privateOutput
      .split("\n")
      .map((line) => projectAlchemyDeploymentOutput(`${line}\n`))
      .join("");
    assert.equal(projected, "");
    assert.equal(
      projectAlchemyDeploymentOutput("\u001B[32m[SandboxContainer] updated\u001B[0m\n"),
      "[SandboxContainer] updated\n",
    );
    assert.equal(
      projectAlchemyDeploymentOutput("Plan: 2 to update, 3 to noop\n"),
      "Plan: 2 to update, 3 to noop\n",
    );
    assert.equal(projectAlchemyDeploymentOutput("Done: 2 succeeded\n"), "Done: 2 succeeded\n");

    const progress = [];
    const report = createProductionDeploymentProgressReporter((message) => progress.push(message));
    report("[SandboxContainer] Building cont");
    report("ainer image private\n[MonolithWorker] Uploading worker");
    report("\n[SandboxContainer] Pushing container image private\n");
    report("[SandboxContainer] Updating container application private\n");
    report("[SandboxContainer] Building container image duplicate\n");
    assert.deepEqual(progress, [
      "Deployment progress: building Container image.",
      "Deployment progress: uploading Worker.",
      "Deployment progress: uploading Container image.",
      "Deployment progress: applying Cloudflare update.",
    ]);
  });

  it("redacts secret env values before overlapping resource names and matches secret keys case-insensitively", () => {
    const overlapping = "scotty-test-worker";
    const redacted = redactProductionDeploymentOutput(
      `token ${overlapping} building scotty-test-sandbox`,
      {
        SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED:
          "worker=scotty-test-worker:container=scotty-test-sandbox",
        cloudflare_api_token: overlapping,
      },
    );
    assert.equal(redacted.includes(overlapping), false);
    assert.equal(redacted.includes("scotty-test-sandbox"), false);
    assert.match(redacted, /\[redacted-secret\]/u);
    assert.match(redacted, /\[redacted-container\]/u);
    assert.doesNotMatch(redacted, /\[redacted-worker\]/u);
  });

  it("persists only a redacted mode-0600 diagnostic for failed Alchemy deploys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-deploy-diagnostic-"));
    const diagnosticPath = join(directory, "failure.log");
    const environment = {
      SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED:
        "confirmed:test:worker=scotty-test-worker:container=scotty-test-sandbox",
      CLOUDFLARE_API_TOKEN: "synthetic-environment-secret",
    };
    const successStep = {
      name: "Synthetic successful Alchemy deploy",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("[SandboxContainer] noop\\n")'],
      capture: true,
      projectOutput: true,
      failureDiagnostic: true,
    };
    const failureStep = {
      ...successStep,
      name: "Synthetic failed Alchemy deploy",
      args: [
        "-e",
        [
          'process.stdout.write("image push failed for scotty-test-worker account 0123456789abcdef0123456789abcdef\\n")',
          'process.stderr.write("{\\\"authorization\\\":\\\"Bearer synthetic-bearer-secret\\\"}\\n")',
          'process.stderr.write("SCOTTY_GITHUB_TOKEN=synthetic-namespaced-secret\\n")',
          'process.stderr.write("CLOUDFLARE_API_TOKEN=synthetic-environment-secret\\n")',
          'process.stderr.write("resource a030af24-612c-4eb0-81cd-873740807d1d\\n")',
          "process.exit(1)",
        ].join(";"),
      ],
    };

    try {
      await writeFile(diagnosticPath, "stale", { mode: 0o644 });
      await runProductionDeployStep(successStep, environment, {
        failureDiagnosticPath: diagnosticPath,
      });
      assert.equal(existsSync(diagnosticPath), false);

      await assert.rejects(
        runProductionDeployStep(failureStep, environment, {
          failureDiagnosticPath: diagnosticPath,
        }),
        (error) => {
          assert.match(error.message, /failed with exit code 1/u);
          assert.match(error.message, /Diagnostic:/u);
          assert.match(error.message, new RegExp(diagnosticPath.replaceAll("/", "\\/"), "u"));
          return true;
        },
      );
      const diagnostic = await readFile(diagnosticPath, "utf8");
      assert.equal((await stat(diagnosticPath)).mode & 0o777, 0o600);
      assert.match(diagnostic, /stdout \(captured tail\)/u);
      assert.match(diagnostic, /stderr \(captured tail\)/u);
      assert.match(diagnostic, /image push failed/u);
      assert.doesNotMatch(diagnostic, /scotty-test-worker/u);
      assert.doesNotMatch(diagnostic, /0123456789abcdef0123456789abcdef/u);
      assert.doesNotMatch(diagnostic, /synthetic-(?:bearer|environment|namespaced)-secret/u);
      assert.doesNotMatch(diagnostic, /a030af24-612c-4eb0-81cd-873740807d1d/u);
      assert.match(diagnostic, /\[redacted-worker\]/u);
      assert.match(diagnostic, /\[redacted-account-id\]/u);
      assert.match(diagnostic, /\[redacted-secret\]/u);
      assert.match(diagnostic, /\[redacted-resource-id\]/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds each persisted failure stream to the captured tail limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scotty-deploy-diagnostic-tail-"));
    const diagnosticPath = join(directory, "failure.log");
    try {
      await persistProductionDeploymentFailureDiagnostic(
        {
          stdout: `${"discarded".repeat(10_000)}stdout-tail`,
          stderr: `${"discarded".repeat(10_000)}stderr-tail`,
        },
        {},
        diagnosticPath,
      );
      const diagnostic = await readFile(diagnosticPath, "utf8");
      assert.match(diagnostic, /stdout-tail/u);
      assert.match(diagnostic, /stderr-tail/u);
      assert.ok(diagnostic.length < 132_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("explains transient emulated Container build crashes without adding automatic retries", async () => {
    assert.match(
      productionDeploymentFailureHint({
        stderr: "npm error Segmentation fault (core dumped)\nprocess exited with code: 139",
      }),
      /rerun this same guarded command once/u,
    );
    assert.equal(productionDeploymentFailureHint({ stderr: "ordinary failure" }), "");
    assert.doesNotMatch(read("scripts/deploy-production.mjs"), /retryProductionDeploy/u);

    const rawOutput = await runCommand(
      process.execPath,
      [
        "-e",
        'process.stdout.write("accountId: 0123456789abcdef"); process.stdout.write("0123456789abcdef\\n[SandboxContainer] updated\\n")',
      ],
      {
        capture: true,
        sanitizeOutput: projectAlchemyDeploymentOutput,
      },
    );
    assert.match(rawOutput, /0123456789abcdef0123456789abcdef/u);
    assert.equal(readAlchemyContainerAction(rawOutput), "updated");

    await assert.rejects(
      runCommand(
        process.execPath,
        [
          "-e",
          'process.stderr.write("Segmentation "); process.stderr.write("fault (core dumped)\\nexit code: 139\\n"); process.exit(1)',
        ],
        {
          sanitizeOutput: projectAlchemyDeploymentOutput,
          failureHint: productionDeploymentFailureHint,
        },
      ),
      /failed with exit code 1[\s\S]*rerun this same guarded command once/u,
    );
  });

  it("waits for Container settlement and audits after an Alchemy failure", async () => {
    const executed = [];
    const environments = new Map();
    let resolvedDockerEnvironment = false;
    const deployFailure = new Error("simulated partial Alchemy failure");
    const controlPlaneBeforeDeploy = snapshot();
    await assert.rejects(
      executeProductionDeploySteps(
        async (step, env, options) => {
          executed.push(step.name);
          environments.set(step.name, { env, options, args: step.args });
          if (step.name === "Check Worker credential binding") {
            return JSON.stringify([{ name: "CREDENTIAL_WRAPPING_KEY", type: "secret_text" }]);
          }
          if (step.name === "Plan production through Alchemy") {
            return "[SandboxContainer] noop\n";
          }
          if (step.name === "Deploy production through Alchemy") throw deployFailure;
        },
        async () => {
          executed.push("Revalidate release state");
        },
        {
          environment: PRODUCTION_TOPOLOGY_ENVIRONMENT,
          readControlPlane: async (env) => {
            executed.push("Read Container baseline");
            environments.set("Read Container baseline", { env });
            return controlPlaneBeforeDeploy;
          },
          waitForRollout: async (before, env, options) => {
            executed.push("Wait for Container rollout");
            environments.set("Wait for Container rollout", { before, env, options });
          },
          auditTopology: async (topology, env) => {
            executed.push("Audit deployed Hatch and Evidence topology");
            environments.set("Audit deployed Hatch and Evidence topology", { topology, env });
          },
          resolveDockerEnvironment: async () => {
            resolvedDockerEnvironment = true;
            assert.fail("Container no-op must not require Docker.");
          },
        },
      ),
      deployFailure,
    );
    assert.deepEqual(executed, [
      "Check repository",
      "Audit current runtime inventory",
      "Prepare isolated Container context",
      "Revalidate release state",
      "Check Worker credential binding",
      "Plan production through Alchemy",
      "Read Container baseline",
      "Deploy production through Alchemy",
      "Wait for Container rollout",
      "Audit deployed runtime inventory",
      "Audit deployed Hatch and Evidence topology",
    ]);
    assert.equal(executed.filter((name) => name === "Deploy production through Alchemy").length, 1);
    assert.deepEqual(environments.get("Check Worker credential binding").args, [
      "--no-install",
      "wrangler",
      "secret",
      "list",
      "--name",
      "scotty-test-worker",
      "--format",
      "json",
    ]);
    const verificationEnv = environments.get("Check repository").env;
    assert.equal(verificationEnv.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(verificationEnv.SCOTTY_RUNNER_TOKEN, undefined);
    assert.equal(verificationEnv.SCOTTY_TOKEN, undefined);
    assert.equal(verificationEnv.GH_TOKEN, undefined);
    assert.equal(verificationEnv.PI_AUTH_JSON, undefined);
    assert.equal(verificationEnv.CREDENTIAL_WRAPPING_KEY, undefined);
    assert.equal(verificationEnv.SCOTTY_E2E_EXPLICIT, undefined);
    for (const name of [
      "Audit current runtime inventory",
      "Plan production through Alchemy",
      "Deploy production through Alchemy",
      "Read Container baseline",
      "Check Worker credential binding",
      "Wait for Container rollout",
      "Audit deployed runtime inventory",
      "Audit deployed Hatch and Evidence topology",
    ]) {
      const { env } = environments.get(name);
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, undefined);
      assert.equal(env.SCOTTY_HOST, undefined);
      assert.equal(env.SCOTTY_INSTALLATION_NAME, "test");
      assert.equal(env.SCOTTY_CONTAINER_APPLICATION_NAME, CONTAINER_APPLICATION_NAME);
      assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(env.SCOTTY_RUNNER_TOKEN, undefined);
      assert.equal(env.SCOTTY_TOKEN, undefined);
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.PI_AUTH_JSON, undefined);
      assert.equal(env.CREDENTIAL_WRAPPING_KEY, undefined);
      assert.equal(env.DOCKER_HOST, undefined);
      assert.equal(
        env.SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED,
        [
          "confirmed",
          "test",
          "worker=scotty-test-worker",
          "runnerWorker=scotty-test-runner",
          "durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunnerRegistry,ScottyRunner,ScottySandboxConfig,ScottyCredentialRegistry",
          `container=${CONTAINER_APPLICATION_NAME}`,
          "kv=scotty-test-sessions",
          "r2=scotty-test-backups",
          "artifacts=scotty-test-artifacts",
          "sandboxBundles=scotty-test-sandbox-bundles",
          "previewBase=preview.scotty.example",
          "previewZone=0123456789abcdef0123456789abcdef",
          "evidence=enabled",
        ].join(":"),
      );
      assert.equal(env.SCOTTY_PREVIEW_BASE, "preview.scotty.example");
      assert.equal(env.SCOTTY_PREVIEW_ZONE_ID, "0123456789abcdef0123456789abcdef");
      assert.equal(env.SCOTTY_EVIDENCE_ENABLED, "true");
      assert.equal(env.SCOTTY_CLOUDFLARE_DEPLOY_APPROVAL, "deploy:test:scotty-test-worker");
    }
    assert.deepEqual(environments.get("Audit deployed runtime inventory").options, {
      allowAfterSignal: true,
    });
    assert.equal(environments.get("Wait for Container rollout").before, controlPlaneBeforeDeploy);
    assert.equal(environments.get("Wait for Container rollout").options.containerAction, "unknown");
    assert.equal(resolvedDockerEnvironment, false);
  });

  it("resolves Docker only for an explicitly authorized Container release", async () => {
    let resolvedDockerEnvironment = false;
    let deployEnvironment;
    await executeProductionDeploySteps(
      async (step, env) => {
        if (step.name === "Check Worker credential binding") {
          return JSON.stringify([{ name: "CREDENTIAL_WRAPPING_KEY", type: "secret_text" }]);
        }
        if (step.name === "Plan production through Alchemy") {
          return "[SandboxContainer] update\n";
        }
        if (step.name === "Deploy production through Alchemy") {
          deployEnvironment = env;
          return "[SandboxContainer] updated\n";
        }
      },
      async () => {},
      {
        environment: PRODUCTION_TOPOLOGY_ENVIRONMENT,
        allowContainerRollout: true,
        readControlPlane: async () => snapshot(),
        waitForRollout: async () => {},
        auditTopology: async () => {},
        resolveDockerEnvironment: async (env) => {
          resolvedDockerEnvironment = true;
          return { ...env, DOCKER_HOST: "unix:///test/docker.sock" };
        },
      },
    );
    assert.equal(resolvedDockerEnvironment, true);
    assert.equal(deployEnvironment.DOCKER_HOST, "unix:///test/docker.sock");
  });

  it("requires the exact new rollout to complete and converge", () => {
    const before = snapshot({
      rollouts: [rollout({ id: "old-rollout", status: "replaced", targetVersion: 5 })],
    });
    assert.deepEqual(
      assessContainerSettlement(
        before,
        snapshot({
          application: {
            version: 6,
            updatedAt: "2026-07-23T11:49:32.185Z",
            configurationDigest: "configuration-v6",
          },
          rollouts: [
            rollout({ id: "old-rollout", status: "replaced", targetVersion: 5 }),
            rollout({
              status: "completed",
              health: {
                healthy: 7,
                failed: 0,
                scheduling: 0,
                starting: 0,
              },
              progress: {
                totalSteps: 1,
                currentStep: 1,
                updatedInstances: 7,
                totalInstances: 7,
              },
            }),
          ],
        }),
        "updated",
      ),
      {
        status: "settled",
        outcome: "rollout",
        message: "Container rollout completed at version 6.",
      },
    );
  });

  it("counts active instances as healthy when Cloudflare separates the health buckets", () => {
    const before = snapshot({
      application: {
        health: { ...application().health, active: 1, healthy: 6 },
      },
    });
    const current = snapshot({
      application: {
        version: 6,
        updatedAt: "2026-07-30T00:39:11.323Z",
        configurationDigest: "configuration-v6",
        health: { ...application().health, active: 1, healthy: 6 },
      },
      rollouts: [
        rollout({
          status: "completed",
          health: {
            healthy: 6,
            failed: 0,
            scheduling: 0,
            starting: 0,
          },
          progress: {
            totalSteps: 1,
            currentStep: 1,
            updatedInstances: 7,
            totalInstances: 7,
          },
        }),
      ],
    });
    assert.deepEqual(assessContainerSettlement(before, current, "updated"), {
      status: "settled",
      outcome: "rollout",
      message: "Container rollout completed at version 6.",
    });
  });

  it("polls the rollout resource through progressing to completed", async () => {
    const before = snapshot();
    const observations = [
      snapshot({
        application: {
          updatedAt: "2026-07-23T11:47:50.102Z",
          activeRolloutId: "rollout-v6",
          configurationDigest: "configuration-v6",
          health: { ...application().health, healthy: 1, starting: 6 },
        },
        rollouts: [rollout()],
      }),
      snapshot({
        application: {
          version: 6,
          updatedAt: "2026-07-23T11:49:32.185Z",
          configurationDigest: "configuration-v6",
        },
        rollouts: [
          rollout({
            status: "completed",
            health: {
              healthy: 7,
              failed: 0,
              scheduling: 0,
              starting: 0,
            },
            progress: {
              totalSteps: 1,
              currentStep: 1,
              updatedInstances: 7,
              totalInstances: 7,
            },
          }),
        ],
      }),
    ];
    let now = 0;
    const settled = await waitForProductionContainerRollout(
      before,
      {},
      {
        containerAction: "updated",
        readControlPlane: async () => observations.shift(),
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        now: () => now,
        timeoutMs: 100,
        pollMs: 5,
      },
    );
    assert.equal(settled.application.version, 6);
    assert.equal(observations.length, 0);
  });

  it("accepts only Alchemy-proven no-op or application-only updates without a rollout", () => {
    const before = snapshot();
    assert.deepEqual(assessContainerSettlement(before, before, "noop"), {
      status: "settled",
      outcome: "noop",
      message: "Alchemy reported a Container no-op at version 5.",
    });
    assert.equal(
      assessContainerSettlement(
        before,
        snapshot({ application: { updatedAt: "2026-07-23T11:47:50.102Z" } }),
        "updated",
      ).status,
      "waiting",
    );
    assert.deepEqual(
      assessContainerSettlement(
        before,
        snapshot({ application: { updatedAt: "2026-07-23T11:47:50.102Z" } }),
        "updated",
        { quietMs: CONTAINER_ROLLOUT_ABSENCE_QUIET_MS },
      ),
      {
        status: "settled",
        outcome: "application-only",
        message: "Container application metadata updated without a rollout at version 5.",
      },
    );
    assert.equal(assessContainerSettlement(before, before, "updated").status, "waiting");
  });

  it("fails closed on failed, reverted, replaced, ambiguous, or unconverged rollouts", () => {
    const before = snapshot();
    for (const status of ["failed", "reverted", "replaced", "unexpected"]) {
      assert.equal(
        assessContainerSettlement(before, snapshot({ rollouts: [rollout({ status })] }), "updated")
          .status,
        "failed",
      );
    }
    assert.equal(
      assessContainerSettlement(
        before,
        snapshot({ rollouts: [rollout(), rollout({ id: "concurrent-rollout" })] }),
        "updated",
      ).status,
      "failed",
    );
    assert.equal(
      assessContainerSettlement(
        before,
        snapshot({
          application: {
            version: 6,
            configurationDigest: "configuration-v6",
            health: { ...application().health, starting: 1 },
          },
          rollouts: [rollout({ status: "completed" })],
        }),
        "updated",
      ).status,
      "waiting",
    );
    assert.equal(
      assessContainerSettlement(
        before,
        snapshot({
          application: { version: 6, configurationDigest: "configuration-v6" },
          rollouts: [
            rollout({
              status: "completed",
              health: {
                healthy: 0,
                failed: 0,
                scheduling: 0,
                starting: 0,
              },
              progress: {
                totalSteps: 1,
                currentStep: 1,
                updatedInstances: 7,
                totalInstances: 7,
              },
            }),
          ],
        }),
        "updated",
      ).status,
      "waiting",
    );
    assert.equal(
      assessContainerSettlement(before, snapshot({ rollouts: [rollout()] }), "noop").status,
      "failed",
    );
  });

  it("fails closed on application identity replacement or version regression", () => {
    const before = snapshot();
    for (const applicationOverrides of [{ id: "replacement" }, { version: 4 }]) {
      assert.equal(
        assessContainerSettlement(before, snapshot({ application: applicationOverrides }), "noop")
          .status,
        "failed",
      );
    }
  });

  it("rejects ambiguous or missing terminal Alchemy actions", () => {
    assert.throws(() => readAlchemyContainerAction(""), /one terminal/u);
    assert.throws(
      () => readAlchemyContainerAction("[SandboxContainer] noop\n[SandboxContainer] updated\n"),
      /one terminal/u,
    );
    assert.throws(
      () => readAlchemyContainerAction("[SandboxContainer] created\n"),
      /one terminal/u,
    );
  });

  it("requires explicit authorization before an Alchemy plan may change the Container", () => {
    assert.equal(readAlchemyContainerPlanAction("[SandboxContainer] noop\n"), "noop");
    assert.equal(readAlchemyContainerPlanAction("[SandboxContainer] update\n"), "update");
    assert.doesNotThrow(() => assertContainerPlanAuthorized("[SandboxContainer] noop\n", false));
    assert.throws(
      () => assertContainerPlanAuthorized("[SandboxContainer] update\n", false),
      /--container/u,
    );
    assert.doesNotThrow(() => assertContainerPlanAuthorized("[SandboxContainer] update\n", true));
    assert.throws(
      () => assertContainerPlanAuthorized("[SandboxContainer] delete\n", true),
      /refuses to delete/u,
    );
    assert.deepEqual(parseProductionDeployOptions([]), { allowContainerRollout: false });
    assert.deepEqual(parseProductionDeployOptions(["--container"]), {
      allowContainerRollout: true,
    });
    assert.throws(() => parseProductionDeployOptions(["--force"]), /Unknown/u);
  });

  it("decodes only the allow-listed Container control-plane snapshot", async () => {
    const input = snapshot({ rollouts: [rollout()] });
    assert.deepEqual(await parseContainerControlPlaneSnapshot(JSON.stringify(input)), input);
    await assert.rejects(
      parseContainerControlPlaneSnapshot(
        JSON.stringify({
          ...input,
          application: { ...input.application, health: { healthy: "seven" } },
        }),
      ),
    );
  });

  it("requires a quiet absence proof after a failed deploy", () => {
    assert.equal(assessContainerSettlement(snapshot(), snapshot(), "unknown").status, "waiting");
    assert.deepEqual(
      assessContainerSettlement(snapshot(), snapshot(), "unknown", {
        quietMs: CONTAINER_ROLLOUT_ABSENCE_QUIET_MS,
      }),
      {
        status: "settled",
        outcome: "failed-deploy-no-rollout",
        message: "The failed Alchemy deployment created no Container rollout.",
      },
    );
  });

  it("restarts the failed-deploy quiet period when the application changes", async () => {
    const before = snapshot();
    const changed = snapshot({
      application: { updatedAt: "2026-07-23T11:47:50.102Z" },
    });
    const observations = [before, changed, changed, changed];
    let now = 0;
    const settled = await waitForProductionContainerRollout(
      before,
      {},
      {
        containerAction: "unknown",
        readControlPlane: async () => observations.shift(),
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        now: () => now,
        timeoutMs: 100_000,
        pollMs: 30_000,
      },
    );
    assert.equal(settled.application.updatedAt, changed.application.updatedAt);
    assert.equal(now, 90_000);
    assert.equal(observations.length, 0);
  });

  it("rejects a deployment while an earlier Container rollout is active", () => {
    for (const before of [
      snapshot({ application: { activeRolloutId: "rollout-v6" } }),
      snapshot({ rollouts: [rollout()] }),
    ]) {
      assert.throws(() => assertSettledContainerBaseline(before), /already has an active rollout/u);
    }
    assert.doesNotThrow(() => assertSettledContainerBaseline(snapshot()));
  });

  it(
    "kills the complete subprocess tree on timeout",
    { skip: process.platform === "win32" },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "scotty-deploy-process-tree-"));
      const marker = join(directory, "survived");
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 300)`;
      const parent = [
        'const { spawn } = require("node:child_process");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      try {
        await assert.rejects(
          runCommand(process.execPath, ["-e", parent], { timeoutMs: 50 }),
          /timed out/u,
        );
        await delay(400);
        assert.equal(existsSync(marker), false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects CI and unsafe git state while holding a local lock", () => {
    const runner = read("scripts/deploy-production.mjs");
    assert.match(runner, /process\.env\.CI/u);
    assert.match(runner, /scotty-production-deploy\.lock/u);
    assert.match(runner, /branch !== "main"/u);
    assert.match(runner, /\["status", "--porcelain=v1"\]/u);
    assert.match(runner, /\["fetch", "--quiet", "origin", "main"\]/u);
    assert.match(runner, /localHead !== remoteHead/u);
    assert.match(runner, /localHead !== expectedHead/u);
    assert.match(runner, /child\.on\("close"/u);
    assert.match(runner, /process\.kill\(-child\.pid/u);
    assert.match(runner, /finally \{[\s\S]*?rm\(DEPLOY_LOCK_PATH/u);
  });

  it("derives Container identity without committing an account-specific ID", () => {
    const infrastructure = read("infra/cloudflare-stack.ts");
    assert.doesNotMatch(infrastructure, /workers\.dev|[0-9a-f]{32}/u);
    assert.match(infrastructure, /name: topology\.container\.name/u);
    assert.doesNotMatch(
      read("scripts/deploy-production.mjs"),
      /PRODUCTION_CONTAINER_APPLICATION_ID/u,
    );
  });

  it("tracks every scheduled session callback in the cancellation inventory", () => {
    const session = read("worker/src/session/object.ts");
    const lifecycle = read("worker/src/session/lifecycle.ts");
    const scheduled = [...session.matchAll(/this\.schedule\([\s\S]{0,120}?"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    const inventoryBlock =
      /SESSION_SCHEDULE_CALLBACKS = \[([\s\S]*?)\] as const/u.exec(lifecycle)?.[1] ?? "";
    const inventoried = [...inventoryBlock.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual([...new Set(scheduled)].sort(), [...new Set(inventoried)].sort());
  });
});
