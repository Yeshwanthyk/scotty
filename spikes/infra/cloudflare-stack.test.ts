import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import {
  assertCloudflareStackConfig,
  expectedCloudflareResourceConfirmation,
  expectedCloudflareStackApproval,
  CLOUDFLARE_BACKUP_BUCKET_NAME,
  CLOUDFLARE_CONTAINER_APPLICATION_NAME,
  CLOUDFLARE_WORKER_SECRETS,
  CLOUDFLARE_KV_TITLE,
  CLOUDFLARE_RUNNER_WORKER_NAME,
  CLOUDFLARE_STAGE,
  CLOUDFLARE_STACK,
  CLOUDFLARE_WORKER_NAME,
  type CloudflareStackConfig,
} from "../../infra/cloudflare-stack.ts";

const accountId = "0123456789abcdef0123456789abcdef";
const source = readFileSync(new URL("../../infra/cloudflare-stack.ts", import.meta.url), "utf8");
const entrypointSource = readFileSync(new URL("../../alchemy.run.ts", import.meta.url), "utf8");
const externalWorkerSource = readFileSync(
  new URL("../../worker/src/index.ts", import.meta.url),
  "utf8",
);
const runnerWorkerSource = readFileSync(
  new URL("../../worker/src/runner-worker.ts", import.meta.url),
  "utf8",
);

const approvedConfig = (): CloudflareStackConfig => ({
  stage: "production",
  telemetryDisabled: true,
  accountId,
  resourceConfirmation: expectedCloudflareResourceConfirmation(accountId),
  approval: `deploy:${accountId}:scotty-worker`,
});

describe("Cloudflare stack guard", () => {
  it("accepts only the approved metadata-only configuration", () => {
    const config = approvedConfig();
    assert.doesNotThrow(() => assertCloudflareStackConfig(config));
    assert.deepEqual(Object.keys(config).sort(), [
      "accountId",
      "approval",
      "resourceConfirmation",
      "stage",
      "telemetryDisabled",
    ]);
    assert.strictEqual(
      expectedCloudflareStackApproval(accountId),
      `deploy:${accountId}:scotty-worker`,
    );
  });

  it("rejects every non-production stage", () => {
    assert.throws(
      () => assertCloudflareStackConfig({ ...approvedConfig(), stage: "Production" }),
      /exact stage production/u,
    );
  });

  it("rejects enabled telemetry", () => {
    assert.throws(
      () => assertCloudflareStackConfig({ ...approvedConfig(), telemetryDisabled: false }),
      /telemetry/u,
    );
  });

  it("rejects a non-canonical account ID", () => {
    assert.throws(
      () =>
        assertCloudflareStackConfig({ ...approvedConfig(), accountId: accountId.toUpperCase() }),
      /accountId/u,
    );
  });

  it("requires an exact confirmation of the account and managed resource set", () => {
    assert.strictEqual(
      expectedCloudflareResourceConfirmation(accountId),
      [
        "confirmed",
        accountId,
        "worker=scotty-worker",
        "runnerWorker=scotty-runner",
        "durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunner",
        "container=scotty-sandboxcontainer-production-ytkhty6mswuofjo5",
        "kv=scotty-sessions",
        "r2=scotty-backups",
      ].join(":"),
    );
    for (const resourceConfirmation of [
      undefined,
      expectedCloudflareResourceConfirmation("fedcba9876543210fedcba9876543210"),
      expectedCloudflareResourceConfirmation(accountId).replace("kv=scotty-sessions", ""),
    ]) {
      assert.throws(
        () => assertCloudflareStackConfig({ ...approvedConfig(), resourceConfirmation }),
        /resource confirmation/u,
      );
    }
  });

  it("rejects approval for any other account or Worker", () => {
    assert.throws(
      () => assertCloudflareStackConfig({ ...approvedConfig(), approval: undefined }),
      /account-scoped approval/u,
    );
  });
});

describe("Cloudflare stack topology", () => {
  it("exports the exact production topology", () => {
    assert.strictEqual(CLOUDFLARE_STAGE, "production");
    assert.strictEqual(CLOUDFLARE_WORKER_NAME, "scotty-worker");
    assert.strictEqual(CLOUDFLARE_RUNNER_WORKER_NAME, "scotty-runner");
    assert.strictEqual(CLOUDFLARE_KV_TITLE, "scotty-sessions");
    assert.strictEqual(CLOUDFLARE_BACKUP_BUCKET_NAME, "scotty-backups");
    assert.strictEqual(
      CLOUDFLARE_CONTAINER_APPLICATION_NAME,
      "scotty-sandboxcontainer-production-ytkhty6mswuofjo5",
    );
    assert.deepEqual(CLOUDFLARE_WORKER_SECRETS, [
      "CODEX_AUTH_JSON",
      "GH_TOKEN",
      "SCOTTY_RUNNER_TOKEN",
      "SCOTTY_TOKEN",
    ]);
    assert.deepEqual(CLOUDFLARE_STACK, {
      worker: {
        logicalId: "MonolithWorker",
        name: "scotty-worker",
        main: "worker/src/index.ts",
        url: true,
        compatibilityDate: "2026-07-20",
        compatibilityFlags: ["nodejs_compat"],
        observability: true,
      },
      assets: {
        directory: "worker/public",
        binding: "ASSETS",
        runWorkerFirst: [
          "/api/*",
          "/s/*",
          "/sessions",
          "/providers",
          "/devices",
          "/pair",
          "/health",
        ],
        htmlHandling: "none",
        notFoundHandling: "404-page",
      },
      durableObject: {
        logicalId: "Sandbox",
        bindingName: "SANDBOX",
        className: "ScottySandbox",
      },
      authDurableObject: {
        logicalId: "AuthRegistry",
        bindingName: "AUTH",
        className: "ScottyAuthRegistry",
      },
      runnerDurableObject: {
        logicalId: "Runner",
        bindingName: "RUNNERS",
        className: "ScottyRunner",
        workerName: "scotty-runner",
      },
      container: {
        logicalId: "SandboxContainer",
        name: "scotty-sandboxcontainer-production-ytkhty6mswuofjo5",
        context: ".alchemy/scotty-container-context",
        dockerfile: ".alchemy/scotty-container-context/worker/container/Dockerfile",
        instanceType: "standard-2",
        maxInstances: 10,
      },
      kv: { logicalId: "SessionsProjection", bindingName: "SESSIONS", title: "scotty-sessions" },
      r2: { logicalId: "BackupBucket", bindingName: "BACKUP_BUCKET", name: "scotty-backups" },
      vars: {
        SANDBOX_TRANSPORT: "rpc",
        BACKUP_BUCKET_NAME: "scotty-backups",
        SCOTTY_RUNNER_NAME: "slumbers",
      },
      outputKeys: ["url"],
      removalPolicy: "retain",
    });
  });
});

describe("Cloudflare stack source contract", () => {
  it("isolates the one persisted legacy logical ID from production vocabulary", () => {
    assert.notMatch(source, /\b(?:MONOLITH|GREENFIELD)_/iu);
    assert.strictEqual(source.match(/"MonolithWorker"/gu)?.length, 1);
    assert.match(source, /EXISTING_ALCHEMY_LOGICAL_IDS/u);
  });

  it("has no default Stack or runnable Effect entry point", () => {
    assert.notMatch(source, /export\s+default/u);
    assert.notMatch(source, /Alchemy\.Stack|Effect\.run(?:Promise|Sync|Fork)/u);
  });

  it("guards before every Resource Effect", () => {
    const guard = source.indexOf("assertCloudflareStackConfig(config)");
    const resource = source.indexOf("Cloudflare.KV.Namespace");
    assert.isAtLeast(guard, 0);
    assert.isAbove(resource, guard);
  });

  it("passes the operator confirmations through the entry point without weakening them", () => {
    assert.match(entrypointSource, /required\("SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED"\)/u);
    assert.match(entrypointSource, /approval: process\.env\.SCOTTY_CLOUDFLARE_DEPLOY_APPROVAL/u);
    assert.match(entrypointSource, /resourceConfirmation,/u);
    assert.notMatch(entrypointSource, /resourceConfirmation\s*===/u);
  });

  it("retains every resource and omits R2 lifecycle rules", () => {
    assert.match(source, /const removalPolicy = RemovalPolicy\.retain\(\)/u);
    assert.strictEqual(
      source.match(/(?:\.pipe\(removalPolicy\)|^\s+removalPolicy,$)/gmu)?.length,
      5,
    );
    assert.notMatch(source, /RemovalPolicy\.destroy|lifecycleRules/u);
  });

  it("constructs exact bindings, vars, assets, compatibility, and container props", () => {
    assert.match(source, /assets: assetConfig/u);
    assert.notMatch(source, /readAssets|assetHash/u);
    assert.match(source, /SANDBOX: durableObject/u);
    assert.match(source, /AUTH: authDurableObject/u);
    assert.match(source, /RUNNERS: runnerDurableObject/u);
    assert.match(source, /scriptName: runnerWorker\.workerName/u);
    assert.match(source, /SESSIONS: sessions/u);
    assert.match(source, /BACKUP_BUCKET: backups/u);
    assert.match(source, /\.\.\.CLOUDFLARE_STACK\.vars/u);
    assert.match(source, /date: CLOUDFLARE_STACK\.worker\.compatibilityDate/u);
    assert.match(source, /flags: \[\.\.\.CLOUDFLARE_STACK\.worker\.compatibilityFlags\]/u);
    assert.match(source, /context: CLOUDFLARE_STACK\.container\.context/u);
    assert.match(source, /name: CLOUDFLARE_STACK\.container\.name/u);
    assert.match(source, /dockerfile: CLOUDFLARE_STACK\.container\.dockerfile/u);
    assert.match(source, /instanceType: CLOUDFLARE_STACK\.container\.instanceType/u);
    assert.match(source, /maxInstances: CLOUDFLARE_STACK\.container\.maxInstances/u);
    assert.match(source, /bindExternalSandboxContainer\(\{ worker, container, durableObject \}\)/u);
  });

  it("hosts the Effect Runner only in the private cross-script Worker", () => {
    assert.notMatch(externalWorkerSource, /(?:import|export).*\bScottyRunner\b/u);
    assert.match(runnerWorkerSource, /Worker<[\s\S]*ScottyRunner/u);
    assert.match(runnerWorkerSource, /yield\* ScottyRunner/u);
    assert.match(runnerWorkerSource, /Effect\.provide\(ScottyRunnerLive\)/u);
    assert.match(runnerWorkerSource, /url: false/u);
    assert.notMatch(runnerWorkerSource, /SCOTTY_RUNNER_TOKEN|InheritedWorkerSecrets/u);
  });

  it("leaves credentials out of Alchemy props and state", () => {
    assert.notMatch(source, /SecretsStore|WriteOnlySecret|secret_text|\bvalue\s*:/u);
    assert.match(source, /worker\.bind\("InheritedWorkerSecrets"/u);
    assert.match(source, /type: "inherit", name/u);
  });

  it("returns only the Worker URL", () => {
    assert.match(source, /return \{ url: worker\.url \};/u);
    assert.deepEqual(CLOUDFLARE_STACK.outputKeys, ["url"]);
  });
});
