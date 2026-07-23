import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  executeProductionDeploySteps,
  PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
  PRODUCTION_DEPLOY_STEPS,
  PRODUCTION_SCOTTY_HOST,
  runCommand,
} from "./deploy-production.mjs";
import { PRODUCTION_CONTAINER_APPLICATION_NAME } from "./reconcile-containers.mjs";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("production deployment ownership", () => {
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
    assert.equal(PRODUCTION_CLOUDFLARE_ACCOUNT_ID, "9953c9d9989f69068510072b215beab9");
    assert.deepEqual(
      PRODUCTION_DEPLOY_STEPS.map(({ name }) => name),
      [
        "Check repository",
        "Audit current runtime inventory",
        "Deploy production through Alchemy",
        "Audit deployed runtime inventory",
      ],
    );
    const commands = PRODUCTION_DEPLOY_STEPS.map(
      ({ command, args }) => `${command} ${args.join(" ")}`,
    );
    assert.equal(
      commands[2],
      "npx --no-install alchemy deploy alchemy.run.ts --stage production --yes",
    );
    assert.equal(commands.filter((command) => command === "npm run audit:containers").length, 2);
    assert.equal(
      commands.some((command) => /wrangler\s+deploy/u.test(command)),
      false,
    );
  });

  it("audits the deployed inventory after an Alchemy failure", async () => {
    const executed = [];
    const environments = new Map();
    const deployFailure = new Error("simulated partial Alchemy failure");
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
      ),
      deployFailure,
    );
    assert.deepEqual(executed, [
      "Check repository",
      "Audit current runtime inventory",
      "Revalidate release state",
      "Deploy production through Alchemy",
      "Audit deployed runtime inventory",
    ]);
    const verificationEnv = environments.get("Check repository").env;
    assert.equal(verificationEnv.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(verificationEnv.SCOTTY_TOKEN, undefined);
    assert.equal(verificationEnv.SCOTTY_E2E_EXPLICIT, undefined);
    for (const name of [
      "Audit current runtime inventory",
      "Deploy production through Alchemy",
      "Audit deployed runtime inventory",
    ]) {
      const { env } = environments.get(name);
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, PRODUCTION_CLOUDFLARE_ACCOUNT_ID);
      assert.equal(env.SCOTTY_HOST, PRODUCTION_SCOTTY_HOST);
      assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(env.SCOTTY_TOKEN, undefined);
    }
    assert.deepEqual(environments.get("Audit deployed runtime inventory").options, {
      allowAfterSignal: true,
    });
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

  it("pins the live Container application identity in infrastructure and audit code", () => {
    const infrastructure = read("spikes/infra/monolith-greenfield.ts");
    assert.match(infrastructure, new RegExp(PRODUCTION_CONTAINER_APPLICATION_NAME, "u"));
    assert.match(infrastructure, /name: MONOLITH_GREENFIELD_TOPOLOGY\.container\.name/u);
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
