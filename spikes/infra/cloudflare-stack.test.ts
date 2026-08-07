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
import { readOwnedPreviewTopologyDeletion } from "../../infra/preview-ownership.ts";

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
const installationDeploymentSource = readFileSync(
  new URL("../../cli/src/installation-deployment.ts", import.meta.url),
  "utf8",
);
const installation = makeInstallationTopology("home");
const previewInstallation = makeInstallationTopology("home", undefined, {
  base: "preview.scotty.example",
  zoneId: "0123456789abcdef0123456789abcdef",
});
const enabledPreviewInstallation = makeInstallationTopology(
  "home",
  undefined,
  {
    base: "preview.scotty.example",
    zoneId: "0123456789abcdef0123456789abcdef",
  },
  true,
);
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

  it("includes the exact user-supplied preview topology in deployment confirmation", () => {
    assert.strictEqual(
      expectedCloudflareResourceConfirmation(previewInstallation),
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
        "previewBase=preview.scotty.example",
        "previewZone=0123456789abcdef0123456789abcdef",
      ].join(":"),
    );
    assert.doesNotThrow(() =>
      assertCloudflareStackConfig({
        ...approvedConfig(),
        installation: previewInstallation,
        resourceConfirmation: expectedCloudflareResourceConfirmation(previewInstallation),
        approval: expectedCloudflareStackApproval(previewInstallation),
      }),
    );
  });

  it("requires explicit preview authority when evidence is enabled", () => {
    const enabledWithoutPreview = makeInstallationTopology("home", undefined, undefined, true);
    assert.throws(
      () =>
        assertCloudflareStackConfig({
          ...approvedConfig(),
          installation: enabledWithoutPreview,
          resourceConfirmation: expectedCloudflareResourceConfirmation(enabledWithoutPreview),
        }),
      /explicit preview topology/u,
    );
    assert.include(
      expectedCloudflareResourceConfirmation(enabledPreviewInstallation),
      "evidence=enabled",
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
    assert.strictEqual(topology.assets.runWorkerFirst, true);
    assert.deepEqual(topology.outputKeys, ["url", "accountId", "workerName"]);
  });

  it("uses only explicit preview base and zone configuration", () => {
    const topology = makeCloudflareStackTopology(previewInstallation);
    assert.deepEqual(topology.preview, {
      base: "preview.scotty.example",
      zoneId: "0123456789abcdef0123456789abcdef",
      dns: {
        logicalId: "EvidencePreviewWildcardDns",
        name: "*.preview.scotty.example",
        type: "AAAA",
        content: "100::",
        proxied: true,
      },
      route: {
        logicalId: "EvidencePreviewWorkerRoute",
        pattern: "*.preview.scotty.example/*",
      },
    });
    assert.deepEqual(topology.vars, {
      SANDBOX_TRANSPORT: "rpc",
      BACKUP_BUCKET_NAME: "scotty-home-backups",
      SCOTTY_PREVIEW_BASE: "preview.scotty.example",
    });
    assert.notProperty(topology.vars, "SCOTTY_PREVIEW_ZONE_ID");
    assert.notProperty(topology.vars, "SCOTTY_EVIDENCE_ENABLED");
    assert.notProperty(topology.vars, "CLOUDFLARE_ACCOUNT_ID");
  });

  it("enables evidence only through the explicit runtime gate", () => {
    const topology = makeCloudflareStackTopology(enabledPreviewInstallation);
    assert.strictEqual(topology.vars.SCOTTY_EVIDENCE_ENABLED, "true");
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

  it("guards before every Resource Effect and retains stateful and compute resources", () => {
    const guard = source.indexOf("assertCloudflareStackConfig(config)");
    const resource = source.indexOf("Cloudflare.KV.Namespace");
    assert.isAtLeast(guard, 0);
    assert.isAbove(resource, guard);
    assert.match(source, /const removalPolicy = RemovalPolicy\.retain\(\)/u);
    assert.strictEqual(
      source.match(/(?:\.pipe\(removalPolicy\)|^\s+removalPolicy,$)/gmu)?.length,
      6,
    );
    assert.strictEqual(source.match(/\.pipe\(RemovalPolicy\.destroy\(\)\)/gu)?.length, 2);
    assert.notMatch(source, /lifecycleRules/u);
  });

  it("uses Alchemy public wildcard DNS and WorkerRoute resources without a parallel reconciler", () => {
    assert.match(source, /Cloudflare\.DNS\.Record\(topology\.preview\.dns\.logicalId/u);
    assert.match(source, /Cloudflare\.Workers\.WorkerRoute\(topology\.preview\.route\.logicalId/u);
    assert.match(source, /name: topology\.preview\.dns\.name/u);
    assert.match(source, /pattern: topology\.preview\.route\.pattern/u);
    assert.match(source, /script: worker\.workerName/u);
    assert.notMatch(source, /wrangler|cloudflare\.com\/client\/v4/u);
  });

  it("deletes preview topology only by identifiers proved by Alchemy state", () => {
    const uninstallSource = installationDeploymentSource.slice(
      installationDeploymentSource.indexOf("export async function uninstallInstallation"),
      installationDeploymentSource.indexOf("const piAuthTargetProgram"),
    );
    const routeDelete = uninstallSource.indexOf("Workers.deleteRoute({");
    const dnsDelete = uninstallSource.indexOf("DNS.deleteRecord({");
    const workerDelete = uninstallSource.indexOf(
      "scriptName: installation.workerName",
      Math.max(routeDelete, dnsDelete),
    );
    assert.isAtLeast(routeDelete, 0);
    assert.isAtLeast(dnsDelete, 0);
    assert.isAbove(workerDelete, routeDelete);
    assert.isAbove(workerDelete, dnsDelete);
    assert.match(uninstallSource, /ownedPreviewDeletion\.routeId/u);
    assert.match(uninstallSource, /ownedPreviewDeletion\.dnsRecordId/u);
    assert.notMatch(uninstallSource, /listRoutes|listRecords/u);
  });

  it("fails closed when preview identifiers are not present in Alchemy deletion state", () => {
    const preview = enabledPreviewInstallation.preview;
    assert.isDefined(preview);
    const route = {
      resource: { Type: "Cloudflare.Workers.Route" },
      state: {
        resourceType: "Cloudflare.Workers.Route",
        logicalId: "EvidencePreviewWorkerRoute",
        props: {
          zoneId: preview.zoneId,
          pattern: `*.${preview.base}/*`,
          script: enabledPreviewInstallation.workerName,
        },
        attr: {
          routeId: "alchemy-route-id",
          zoneId: preview.zoneId,
          pattern: `*.${preview.base}/*`,
          script: enabledPreviewInstallation.workerName,
        },
      },
    };
    const dns = {
      resource: { Type: "Cloudflare.DNS.Record" },
      state: {
        resourceType: "Cloudflare.DNS.Record",
        logicalId: "EvidencePreviewWildcardDns",
        props: {
          zoneId: preview.zoneId,
          name: `*.${preview.base}`,
          type: "AAAA",
          content: "100::",
          proxied: true,
        },
        attr: {
          recordId: "alchemy-dns-id",
          zoneId: preview.zoneId,
          name: `*.${preview.base}`,
          type: "AAAA",
          content: "100::",
          proxied: true,
        },
      },
    };

    assert.deepEqual(
      readOwnedPreviewTopologyDeletion(
        [route, dns],
        preview,
        enabledPreviewInstallation.workerName,
      ),
      { routeId: "alchemy-route-id", dnsRecordId: "alchemy-dns-id" },
    );
    assert.isUndefined(
      readOwnedPreviewTopologyDeletion(
        [route, { ...dns, state: { ...dns.state, attr: { ...dns.state.attr, recordId: "" } } }],
        preview,
        enabledPreviewInstallation.workerName,
      ),
    );
    assert.isUndefined(
      readOwnedPreviewTopologyDeletion(
        [
          { id: "matching-live-route", pattern: `*.${preview.base}/*` },
          { id: "matching-live-dns", name: `*.${preview.base}` },
        ],
        preview,
        enabledPreviewInstallation.workerName,
      ),
    );
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
