import { assert, describe, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { PREBUILT_MAIN_WORKER_ENTRY } from "../../cli/src/prebuilt-worker-bundles.ts";
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
        "durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunnerRegistry,ScottyRunner,ScottySandboxConfig,ScottyCredentialRegistry",
        "container=scotty-home-sandbox",
        "kv=scotty-home-sessions",
        "r2=scotty-home-backups",
        "artifacts=scotty-home-artifacts",
        "sandboxBundles=scotty-home-sandbox-bundles",
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
        "durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunnerRegistry,ScottyRunner,ScottySandboxConfig,ScottyCredentialRegistry",
        "container=scotty-home-sandbox",
        "kv=scotty-home-sessions",
        "r2=scotty-home-backups",
        "artifacts=scotty-home-artifacts",
        "sandboxBundles=scotty-home-sandbox-bundles",
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
  it("switches worker entrypoints to prebuilt bundles for embedded deployment", () => {
    const topology = makeCloudflareStackTopology(installation, true);
    assert.strictEqual(topology.worker.main, PREBUILT_MAIN_WORKER_ENTRY);
    assert.strictEqual(topology.worker.bundle, false);
  });

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
      sandboxBundleBucketName: "scotty-home-sandbox-bundles",
      workerLogicalId: "Worker",
    });
    assert.deepEqual(CLOUDFLARE_WORKER_SECRETS, ["SCOTTY_TOKEN", "CREDENTIAL_WRAPPING_KEY"]);
    const topology = makeCloudflareStackTopology(installation);
    assert.strictEqual(topology.worker.name, "scotty-home-worker");
    assert.strictEqual(topology.worker.main, "worker/src/index.ts");
    assert.notProperty(topology.worker, "bundle");
    assert.strictEqual(topology.runnerDurableObject.workerName, "scotty-home-runner");
    assert.strictEqual(topology.container.name, "scotty-home-sandbox");
    assert.strictEqual(topology.kv.title, "scotty-home-sessions");
    assert.strictEqual(topology.r2.name, "scotty-home-backups");
    assert.deepEqual(topology.artifactR2, {
      logicalId: "ArtifactBucket",
      bindingName: "ARTIFACT_BUCKET",
      name: "scotty-home-artifacts",
    });
    assert.deepEqual(topology.sandboxBundleR2, {
      logicalId: "SandboxBundleBucket",
      bindingName: "SANDBOX_BUNDLE_BUCKET",
      name: "scotty-home-sandbox-bundles",
    });
    assert.deepEqual(topology.sandboxConfigDurableObject, {
      logicalId: "SandboxConfig",
      bindingName: "SANDBOX_CONFIG",
      className: "ScottySandboxConfig",
    });
    assert.deepEqual(topology.credentialRegistryDurableObject, {
      logicalId: "CredentialRegistry",
      bindingName: "CREDENTIALS",
      className: "ScottyCredentialRegistry",
    });
    assert.deepEqual(topology.vars, {
      SCOTTY_INSTALLATION_NAME: "home",
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
      SCOTTY_INSTALLATION_NAME: "home",
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
        sandboxBundleBucketName: "legacy-sandbox-bundles",
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
      sandboxBundleBucketName: "legacy-sandbox-bundles",
      workerLogicalId: "LegacyWorker",
    });
  });
});

describe("Cloudflare stack source contract", () => {
  it("omits the managed browser dependency and binding", () => {
    assert.notMatch(workerPackageSource, /@cloudflare\/playwright/u);
    assert.notMatch(packageLockSource, /node_modules\/@cloudflare\/playwright/u);
    assert.notMatch(source, /Cloudflare\.Browser/u);
    assert.match(source, /ARTIFACT_BUCKET: artifacts/u);
    assert.match(source, /SANDBOX_BUNDLE_BUCKET: sandboxBundles/u);
  });

  it("bundles the Worker and full-stack canary without managed browser code or credentials", () => {
    const root = new URL("../../", import.meta.url);
    const outputDirectory = mkdtempSync(join(tmpdir(), "scotty-worker-bundle-"));
    const syntheticMaterial = randomBytes(48).toString("base64url");
    const entries = [
      ["worker/src/index.ts", "worker.js"],
      ["spikes/infra/full-stack-canary-worker.ts", "canary.js"],
    ] as const;
    for (const [entry, outputName] of entries) {
      const bundlePath = join(outputDirectory, outputName);
      execFileSync(
        "bun",
        ["build", entry, "--target=node", "--external=cloudflare:*", `--outfile=${bundlePath}`],
        {
          cwd: root,
          stdio: "pipe",
          env: {
            ...process.env,
            SCOTTY_TOKEN: syntheticMaterial,
          },
        },
      );
      const bundle = readFileSync(bundlePath, "utf8");
      assert.notMatch(bundle, /@cloudflare\/playwright/u);
      assert.notInclude(bundle, syntheticMaterial);
    }
    rmSync(outputDirectory, { recursive: true, force: true });
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
      7,
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

  it("makes a partial preview uninstall retry idempotent after route or DNS deletion", () => {
    const uninstallSource = installationDeploymentSource.slice(
      installationDeploymentSource.indexOf("export async function uninstallInstallation"),
      installationDeploymentSource.indexOf("const piAuthTargetProgram"),
    );
    assert.match(
      uninstallSource,
      /Workers\.deleteRoute\([\s\S]*?Effect\.catchTag\("RouteNotFound", \(\) => Effect\.void\)/u,
    );
    assert.match(
      installationDeploymentSource,
      /import type \{ NotFound as CloudflareNotFound \} from "@distilled\.cloud\/cloudflare\/Errors"/u,
    );
    assert.match(
      uninstallSource,
      /DNS\.deleteRecord\([\s\S]*?DNS\.DeleteRecordError \| CloudflareNotFound[\s\S]*?Effect\.catchTag\("NotFound", \(\) => Effect\.void\)/u,
    );
  });

  it("retains or exhaustively deletes both backup and artifact buckets on uninstall", () => {
    const uninstallSource = installationDeploymentSource.slice(
      installationDeploymentSource.indexOf("export async function uninstallInstallation"),
      installationDeploymentSource.indexOf("const piAuthTargetProgram"),
    );
    assert.match(
      uninstallSource,
      /const retainedBuckets = \[\s*installation\.backupBucketName,\s*installation\.artifactBucketName,\s*installation\.sandboxBundleBucketName,\s*\]/u,
    );
    assert.match(
      uninstallSource,
      /const retainedData = \[installation\.kvTitle, \.\.\.retainedBuckets\]/u,
    );
    assert.match(uninstallSource, /for \(const bucketName of retainedBuckets\)/u);
    assert.match(uninstallSource, /R2\.listObjects[\s\S]*R2\.deleteObjects/u);
    assert.match(uninstallSource, /R2\.deleteBucket\(\{ accountId, bucketName \}\)/u);
    assert.isAbove(
      uninstallSource.indexOf("yield* Apply.apply(destroyPlan)"),
      uninstallSource.indexOf("deletedData.push(bucketName)"),
    );
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
    assert.match(source, /CREDENTIAL_WRAPPING_KEY/u);
    assert.equal(/CREDENTIAL_WRAPPING_KEY\s*:/u.test(source), false);
  });

  it("uses prebuilt runner entrypoints when embedded deployment is enabled", () => {
    const runnerWorkerSource = readFileSync(
      new URL("../../worker/src/runner-worker.ts", import.meta.url),
      "utf8",
    );
    assert.match(runnerWorkerSource, /PREBUILT_RUNNER_WORKER_ENTRY/u);
    assert.match(runnerWorkerSource, /prebuiltWorkers === true/u);
    assert.match(runnerWorkerSource, /bundle: false as const/u);
  });

  it("hosts the Effect Runner only in the private cross-script Worker", () => {
    assert.notMatch(externalWorkerSource, /(?:import|export).*\bScottyRunner\b/u);
    assert.match(runnerWorkerSource, /Worker<[\s\S]*ScottyRunner/u);
    assert.match(runnerWorkerSource, /makeScottyRunnerWorker/u);
    assert.match(runnerWorkerSource, /workersDev: false/u);
  });
});
