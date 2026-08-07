import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import {
  assertCloudflareStackConfig,
  CLOUDFLARE_STAGE,
  CLOUDFLARE_WORKER_SECRETS,
  expectedCloudflareResourceConfirmation,
  expectedCloudflareStackApproval,
  makeCloudflareStackTopology,
  type CloudflareStackConfig,
} from "../../infra/cloudflare-stack.ts";
import { makeInstallationTopology, type AdoptionManifest } from "../../infra/installation.ts";

const source = readFileSync(new URL("../../infra/cloudflare-stack.ts", import.meta.url), "utf8");
const workerPackageSource = readFileSync(
  new URL("../../worker/package.json", import.meta.url),
  "utf8",
);
const packageLockSource = readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8");
const entrypointSource = readFileSync(new URL("../../alchemy.run.ts", import.meta.url), "utf8");
const externalWorkerSource = readFileSync(
  new URL("../../worker/src/index.ts", import.meta.url),
  "utf8",
);
const runnerWorkerSource = readFileSync(
  new URL("../../worker/src/runner-worker.ts", import.meta.url),
  "utf8",
);
const installation = makeInstallationTopology("home");

const approvedConfig = (): CloudflareStackConfig => ({
  stage: "production",
  telemetryDisabled: true,
  installation,
  resourceConfirmation: expectedCloudflareResourceConfirmation(installation),
  approval: expectedCloudflareStackApproval(installation),
});

describe("Cloudflare stack guard", () => {
  it("accepts only exact installation-scoped approval", () => {
    assert.doesNotThrow(() => assertCloudflareStackConfig(approvedConfig()));
    assert.strictEqual(
      expectedCloudflareStackApproval(installation),
      "deploy:home:scotty-home-worker",
    );
    assert.strictEqual(
      expectedCloudflareResourceConfirmation(installation),
      [
        "confirmed",
        "home",
        "worker=scotty-home-worker",
        "runnerWorker=scotty-home-runner",
        "durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunnerRegistry,ScottyRunner",
        "container=scotty-home-sandbox",
        "kv=scotty-home-sessions",
        "r2=scotty-home-backups",
        "artifacts=scotty-home-artifacts",
      ].join(":"),
    );
  });

  it("rejects stage, telemetry, resource, and approval drift", () => {
    assert.throws(
      () => assertCloudflareStackConfig({ ...approvedConfig(), stage: "Production" }),
      /exact stage production/u,
    );
    assert.throws(
      () => assertCloudflareStackConfig({ ...approvedConfig(), telemetryDisabled: false }),
      /telemetry/u,
    );
    assert.throws(
      () => assertCloudflareStackConfig({ ...approvedConfig(), resourceConfirmation: undefined }),
      /resource confirmation/u,
    );
    assert.throws(
      () => assertCloudflareStackConfig({ ...approvedConfig(), approval: undefined }),
      /installation-scoped approval/u,
    );
  });
});

describe("Cloudflare stack topology", () => {
  it("derives every physical name from the required installation name", () => {
    assert.strictEqual(CLOUDFLARE_STAGE, "production");
    assert.deepEqual(installation, {
      installationName: "home",
      stackName: "Scotty-home",
      stage: "production",
      workerName: "scotty-home-worker",
      runnerWorkerName: "scotty-home-runner",
      containerName: "scotty-home-sandbox",
      kvTitle: "scotty-home-sessions",
      backupBucketName: "scotty-home-backups",
      artifactBucketName: "scotty-home-artifacts",
      workerLogicalId: "Worker",
    });
    assert.deepEqual(CLOUDFLARE_WORKER_SECRETS, ["GH_TOKEN", "PI_AUTH_JSON", "SCOTTY_TOKEN"]);
    const topology = makeCloudflareStackTopology(installation);
    assert.strictEqual(topology.worker.name, "scotty-home-worker");
    assert.strictEqual(topology.runnerDurableObject.workerName, "scotty-home-runner");
    assert.strictEqual(topology.container.name, "scotty-home-sandbox");
    assert.strictEqual(topology.kv.title, "scotty-home-sessions");
    assert.strictEqual(topology.r2.name, "scotty-home-backups");
    assert.deepEqual(topology.artifactR2, {
      logicalId: "ArtifactBucket",
      bindingName: "ARTIFACT_BUCKET",
      name: "scotty-home-artifacts",
    });
    assert.deepEqual(topology.vars, {
      SANDBOX_TRANSPORT: "rpc",
      BACKUP_BUCKET_NAME: "scotty-home-backups",
    });
    assert.deepEqual(topology.outputKeys, ["url", "accountId", "workerName"]);
  });

  it("supports private legacy adoption without committed production identity", () => {
    const adoption = {
      schemaVersion: 1,
      installationName: "home",
      stackName: "Legacy",
      resources: {
        workerName: "legacy-worker",
        runnerWorkerName: "legacy-runner",
        containerName: "legacy-container-generated-name",
        kvTitle: "legacy-sessions",
        backupBucketName: "legacy-backups",
        artifactBucketName: "legacy-artifacts",
      },
      logicalIds: { worker: "LegacyWorker" },
    } satisfies AdoptionManifest;
    assert.deepEqual(makeInstallationTopology("home", adoption), {
      installationName: "home",
      stackName: "Legacy",
      stage: "production",
      workerName: "legacy-worker",
      runnerWorkerName: "legacy-runner",
      containerName: "legacy-container-generated-name",
      kvTitle: "legacy-sessions",
      backupBucketName: "legacy-backups",
      artifactBucketName: "legacy-artifacts",
      workerLogicalId: "LegacyWorker",
    });
  });
});

describe("Cloudflare stack source contract", () => {
  it("pins the exact Kitesurf client and declares the native browser binding", () => {
    assert.match(workerPackageSource, /"@cloudflare\/playwright": "1\.3\.5"/u);
    assert.match(
      packageLockSource,
      /"node_modules\/@cloudflare\/playwright": \{[\s\S]*?"version": "1\.3\.5"/u,
    );
    assert.match(source, /BROWSER: Cloudflare\.Browser\("BROWSER"\)/u);
    assert.match(source, /ARTIFACT_BUCKET: artifacts/u);
  });

  it("has no committed account, hostname, container UUID, or runner instance name", () => {
    const combined = `${source}\n${entrypointSource}`;
    assert.notMatch(combined, /workers\.dev|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f-]{27}/u);
    assert.notMatch(combined, /example-runner|yeshwanth|MonolithWorker/u);
    assert.match(entrypointSource, /required\("SCOTTY_INSTALLATION_NAME"\)/u);
    assert.match(entrypointSource, /SCOTTY_ADOPTION_MANIFEST/u);
  });

  it("guards before every Resource Effect and retains all resources", () => {
    const guard = source.indexOf("assertCloudflareStackConfig(config)");
    const resource = source.indexOf("Cloudflare.KV.Namespace");
    assert.isAtLeast(guard, 0);
    assert.isAbove(resource, guard);
    assert.match(source, /const removalPolicy = RemovalPolicy\.retain\(\)/u);
    assert.strictEqual(
      source.match(/(?:\.pipe\(removalPolicy\)|^\s+removalPolicy,$)/gmu)?.length,
      6,
    );
    assert.notMatch(source, /RemovalPolicy\.destroy|lifecycleRules/u);
  });

  it("keeps credentials out of Alchemy props and state", () => {
    assert.notMatch(source, /SecretsStore|WriteOnlySecret|secret_text|\bvalue\s*:/u);
    assert.match(source, /worker\.bind\("InheritedWorkerSecrets"/u);
    assert.match(source, /type: "inherit", name/u);
  });

  it("hosts the Effect Runner only in the private cross-script Worker", () => {
    assert.notMatch(externalWorkerSource, /(?:import|export).*\bScottyRunner\b/u);
    assert.match(runnerWorkerSource, /Worker<[\s\S]*ScottyRunner/u);
    assert.match(runnerWorkerSource, /makeScottyRunnerWorker/u);
    assert.match(runnerWorkerSource, /workersDev: false/u);
  });
});
