import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as Effect from "effect/Effect";
import { parseContainerControlPlaneSnapshot } from "./container-control-plane.mjs";
import {
  assessContainerSettlement,
  assertSettledContainerBaseline,
  CONTAINER_ROLLOUT_ABSENCE_QUIET_MS,
  executeProductionDeploySteps,
  PRODUCTION_DEPLOY_STEPS,
  readAlchemyContainerAction,
  resolveProductionTopology,
  runCommand,
  waitForProductionContainerRollout,
} from "./deploy-production.mjs";
import { dedupeBindings, diffBindings, stripEffects } from "../node_modules/alchemy/lib/Diff.js";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const INSTALLATION_ENVIRONMENT = { SCOTTY_INSTALLATION_NAME: "test" };
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
  it("keeps the pinned Alchemy binding-state backport installed and deterministic", () => {
    const rootPackage = JSON.parse(read("package.json"));
    const patch = read("patches/alchemy+2.0.0-beta.67.patch");
    const installedApply = read("node_modules/alchemy/lib/Apply.js");
    const installedWorkerProvider = read(
      "node_modules/alchemy/lib/Cloudflare/Workers/WorkerProvider.js",
    );

    assert.equal(rootPackage.dependencies.alchemy, "2.0.0-beta.67");
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
  });

  it("checks, audits, deploys through Alchemy, and audits again", () => {
    assert.deepEqual(resolveProductionTopology(INSTALLATION_ENVIRONMENT), {
      installationName: "test",
      adoptionPath: undefined,
      workerName: "scotty-test-worker",
      runnerWorkerName: "scotty-test-runner",
      containerName: "scotty-test-sandbox",
      kvTitle: "scotty-test-sessions",
      backupBucketName: "scotty-test-backups",
    });
    assert.deepEqual(
      PRODUCTION_DEPLOY_STEPS.map(({ name }) => name),
      [
        "Check repository",
        "Audit current runtime inventory",
        "Prepare isolated Container context",
        "Deploy production through Alchemy",
        "Audit deployed runtime inventory",
      ],
    );
    const commands = PRODUCTION_DEPLOY_STEPS.map(
      ({ command, args }) => `${command} ${args.join(" ")}`,
    );
    assert.equal(
      commands[3],
      "npx --no-install alchemy deploy alchemy.run.ts --stage production --yes",
    );
    assert.equal(commands.filter((command) => command === "npm run audit:containers").length, 2);
    assert.equal(
      commands.some((command) => /wrangler\s+deploy/u.test(command)),
      false,
    );
    assert.equal(commands[2], `${process.execPath} scripts/prepare-container-context.mjs`);
    assert.equal(PRODUCTION_DEPLOY_STEPS[3].capture, true);
    assert.equal(PRODUCTION_DEPLOY_STEPS[3].tee, true);
    assert.equal(readAlchemyContainerAction("[SandboxContainer] updated\n"), "updated");
    assert.equal(
      readAlchemyContainerAction("\u001B[32m[SandboxContainer] noop\u001B[0m\n"),
      "noop",
    );
  });

  it("waits for Container settlement and audits after an Alchemy failure", async () => {
    const executed = [];
    const environments = new Map();
    const deployFailure = new Error("simulated partial Alchemy failure");
    const controlPlaneBeforeDeploy = snapshot();
    await assert.rejects(
      executeProductionDeploySteps(
        async (step, env, options) => {
          executed.push(step.name);
          environments.set(step.name, { env, options });
          if (step.name === "Deploy production through Alchemy") throw deployFailure;
        },
        async () => {
          executed.push("Revalidate release state");
        },
        {
          environment: INSTALLATION_ENVIRONMENT,
          readControlPlane: async (env) => {
            executed.push("Read Container baseline");
            environments.set("Read Container baseline", { env });
            return controlPlaneBeforeDeploy;
          },
          waitForRollout: async (before, env, options) => {
            executed.push("Wait for Container rollout");
            environments.set("Wait for Container rollout", { before, env, options });
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
      "Read Container baseline",
      "Deploy production through Alchemy",
      "Wait for Container rollout",
      "Audit deployed runtime inventory",
    ]);
    const verificationEnv = environments.get("Check repository").env;
    assert.equal(verificationEnv.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(verificationEnv.SCOTTY_RUNNER_TOKEN, undefined);
    assert.equal(verificationEnv.SCOTTY_TOKEN, undefined);
    assert.equal(verificationEnv.SCOTTY_E2E_EXPLICIT, undefined);
    for (const name of [
      "Audit current runtime inventory",
      "Deploy production through Alchemy",
      "Read Container baseline",
      "Wait for Container rollout",
      "Audit deployed runtime inventory",
    ]) {
      const { env } = environments.get(name);
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, undefined);
      assert.equal(env.SCOTTY_HOST, undefined);
      assert.equal(env.SCOTTY_INSTALLATION_NAME, "test");
      assert.equal(env.SCOTTY_CONTAINER_APPLICATION_NAME, CONTAINER_APPLICATION_NAME);
      assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(env.SCOTTY_RUNNER_TOKEN, undefined);
      assert.equal(env.SCOTTY_TOKEN, undefined);
      assert.equal(
        env.SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED,
        [
          "confirmed",
          "test",
          "worker=scotty-test-worker",
          "runnerWorker=scotty-test-runner",
          "durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunnerRegistry,ScottyRunner",
          `container=${CONTAINER_APPLICATION_NAME}`,
          "kv=scotty-test-sessions",
          "r2=scotty-test-backups",
        ].join(":"),
      );
      assert.equal(env.SCOTTY_CLOUDFLARE_DEPLOY_APPROVAL, "deploy:test:scotty-test-worker");
    }
    assert.deepEqual(environments.get("Audit deployed runtime inventory").options, {
      allowAfterSignal: true,
    });
    assert.equal(environments.get("Wait for Container rollout").before, controlPlaneBeforeDeploy);
    assert.equal(environments.get("Wait for Container rollout").options.containerAction, "unknown");
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
        message: "Container rollout rollout-v6 completed at version 6.",
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
      message: "Container rollout rollout-v6 completed at version 6.",
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
    const session = read("worker/src/session.ts");
    const lifecycle = read("worker/src/session-lifecycle.ts");
    const scheduled = [...session.matchAll(/this\.schedule\([\s\S]{0,120}?"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    const inventoryBlock =
      /SESSION_SCHEDULE_CALLBACKS = \[([\s\S]*?)\] as const/u.exec(lifecycle)?.[1] ?? "";
    const inventoried = [...inventoryBlock.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual([...new Set(scheduled)].sort(), [...new Set(inventoried)].sort());
  });
});
