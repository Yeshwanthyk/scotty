import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import {
  assertMonolithGreenfieldConfig,
  expectedMonolithGreenfieldApproval,
  MONOLITH_GREENFIELD_BACKUP_BUCKET_NAME,
  MONOLITH_GREENFIELD_INHERITED_SECRETS,
  MONOLITH_GREENFIELD_KV_TITLE,
  MONOLITH_GREENFIELD_STAGE,
  MONOLITH_GREENFIELD_TOPOLOGY,
  MONOLITH_GREENFIELD_WORKER_NAME,
  type MonolithGreenfieldConfig,
} from "./monolith-greenfield.ts";

const accountId = "0123456789abcdef0123456789abcdef";
const source = readFileSync(new URL("./monolith-greenfield.ts", import.meta.url), "utf8");

const approvedConfig = (): MonolithGreenfieldConfig => ({
  stage: "production",
  telemetryDisabled: true,
  accountId,
  absenceEvidence: {
    accountId,
    worker: true,
    durableObject: true,
    container: true,
    kv: true,
    r2: true,
  },
  approval: `greenfield:${accountId}:scotty-worker`,
});

describe("monolith greenfield guard", () => {
  it("accepts only the approved metadata-only configuration", () => {
    const config = approvedConfig();
    assert.doesNotThrow(() => assertMonolithGreenfieldConfig(config));
    assert.deepEqual(Object.keys(config).sort(), [
      "absenceEvidence",
      "accountId",
      "approval",
      "stage",
      "telemetryDisabled",
    ]);
    assert.strictEqual(
      expectedMonolithGreenfieldApproval(accountId),
      `greenfield:${accountId}:scotty-worker`,
    );
  });

  it("rejects every non-production stage", () => {
    assert.throws(
      () => assertMonolithGreenfieldConfig({ ...approvedConfig(), stage: "Production" }),
      /exact stage production/u,
    );
  });

  it("rejects enabled telemetry", () => {
    assert.throws(
      () => assertMonolithGreenfieldConfig({ ...approvedConfig(), telemetryDisabled: false }),
      /telemetry/u,
    );
  });

  it("rejects a non-canonical account ID", () => {
    assert.throws(
      () =>
        assertMonolithGreenfieldConfig({ ...approvedConfig(), accountId: accountId.toUpperCase() }),
      /accountId/u,
    );
  });

  it("rejects absence evidence from a different account", () => {
    const config = approvedConfig();
    assert.throws(
      () =>
        assertMonolithGreenfieldConfig({
          ...config,
          absenceEvidence: {
            ...config.absenceEvidence,
            accountId: "fedcba9876543210fedcba9876543210",
          },
        }),
      /deployment account/u,
    );
  });

  it("rejects missing Worker absence evidence", () => {
    const config = approvedConfig();
    assert.throws(() =>
      assertMonolithGreenfieldConfig({
        ...config,
        absenceEvidence: { ...config.absenceEvidence, worker: false },
      }),
    );
  });

  it("rejects missing Durable Object absence evidence", () => {
    const config = approvedConfig();
    assert.throws(() =>
      assertMonolithGreenfieldConfig({
        ...config,
        absenceEvidence: { ...config.absenceEvidence, durableObject: false },
      }),
    );
  });

  it("rejects missing Container absence evidence", () => {
    const config = approvedConfig();
    assert.throws(() =>
      assertMonolithGreenfieldConfig({
        ...config,
        absenceEvidence: { ...config.absenceEvidence, container: false },
      }),
    );
  });

  it("rejects missing KV absence evidence", () => {
    const config = approvedConfig();
    assert.throws(() =>
      assertMonolithGreenfieldConfig({
        ...config,
        absenceEvidence: { ...config.absenceEvidence, kv: false },
      }),
    );
  });

  it("rejects missing R2 absence evidence", () => {
    const config = approvedConfig();
    assert.throws(() =>
      assertMonolithGreenfieldConfig({
        ...config,
        absenceEvidence: { ...config.absenceEvidence, r2: false },
      }),
    );
  });

  it("rejects approval for any other account or Worker", () => {
    assert.throws(
      () => assertMonolithGreenfieldConfig({ ...approvedConfig(), approval: undefined }),
      /account-scoped approval/u,
    );
  });
});

describe("monolith greenfield topology", () => {
  it("exports the exact production topology", () => {
    assert.strictEqual(MONOLITH_GREENFIELD_STAGE, "production");
    assert.strictEqual(MONOLITH_GREENFIELD_WORKER_NAME, "scotty-worker");
    assert.strictEqual(MONOLITH_GREENFIELD_KV_TITLE, "scotty-sessions");
    assert.strictEqual(MONOLITH_GREENFIELD_BACKUP_BUCKET_NAME, "scotty-backups");
    assert.deepEqual(MONOLITH_GREENFIELD_INHERITED_SECRETS, [
      "CODEX_AUTH_JSON",
      "GH_TOKEN",
      "SCOTTY_TOKEN",
    ]);
    assert.deepEqual(MONOLITH_GREENFIELD_TOPOLOGY, {
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
        runWorkerFirst: ["/api/*", "/s/*", "/health"],
        notFoundHandling: "404-page",
      },
      durableObject: {
        logicalId: "Sandbox",
        bindingName: "SANDBOX",
        className: "ScottySandbox",
        scriptName: "scotty-worker",
      },
      container: {
        logicalId: "SandboxContainer",
        context: "worker/container",
        dockerfile: "worker/container/Dockerfile",
        instanceType: "standard-2",
        maxInstances: 10,
      },
      kv: { logicalId: "SessionsProjection", bindingName: "SESSIONS", title: "scotty-sessions" },
      r2: { logicalId: "BackupBucket", bindingName: "BACKUP_BUCKET", name: "scotty-backups" },
      vars: { SANDBOX_TRANSPORT: "rpc", BACKUP_BUCKET_NAME: "scotty-backups" },
      outputKeys: ["url"],
      removalPolicy: "retain",
    });
  });
});

describe("monolith greenfield source contract", () => {
  it("has no default Stack or runnable Effect entry point", () => {
    assert.notMatch(source, /export\s+default/u);
    assert.notMatch(source, /Alchemy\.Stack|Effect\.run(?:Promise|Sync|Fork)/u);
  });

  it("guards before every Resource Effect", () => {
    const guard = source.indexOf("assertMonolithGreenfieldConfig(config)");
    const resource = source.indexOf("Cloudflare.KV.Namespace");
    assert.isAtLeast(guard, 0);
    assert.isAbove(resource, guard);
  });

  it("retains every resource and omits R2 lifecycle rules", () => {
    assert.match(source, /const removalPolicy = RemovalPolicy\.retain\(\)/u);
    assert.strictEqual(source.match(/\.pipe\(removalPolicy\)/gu)?.length, 4);
    assert.notMatch(source, /RemovalPolicy\.destroy|lifecycleRules/u);
  });

  it("constructs exact bindings, vars, assets, compatibility, and container props", () => {
    assert.match(source, /assets: assetConfig/u);
    assert.notMatch(source, /readAssets|assetHash/u);
    assert.match(source, /SANDBOX: durableObject/u);
    assert.match(source, /SESSIONS: sessions/u);
    assert.match(source, /BACKUP_BUCKET: backups/u);
    assert.match(source, /\.\.\.MONOLITH_GREENFIELD_TOPOLOGY\.vars/u);
    assert.match(source, /date: MONOLITH_GREENFIELD_TOPOLOGY\.worker\.compatibilityDate/u);
    assert.match(
      source,
      /flags: \[\.\.\.MONOLITH_GREENFIELD_TOPOLOGY\.worker\.compatibilityFlags\]/u,
    );
    assert.match(source, /context: MONOLITH_GREENFIELD_TOPOLOGY\.container\.context/u);
    assert.match(source, /dockerfile: MONOLITH_GREENFIELD_TOPOLOGY\.container\.dockerfile/u);
    assert.match(source, /instanceType: MONOLITH_GREENFIELD_TOPOLOGY\.container\.instanceType/u);
    assert.match(source, /maxInstances: MONOLITH_GREENFIELD_TOPOLOGY\.container\.maxInstances/u);
    assert.match(source, /bindExternalSandboxContainer\(\{ worker, container, durableObject \}\)/u);
  });

  it("leaves credentials out of Alchemy props and state", () => {
    assert.notMatch(source, /SecretsStore|WriteOnlySecret|secret_text|\bvalue\s*:/u);
    assert.match(source, /worker\.bind\("InheritedWorkerSecrets"/u);
    assert.match(source, /type: "inherit", name/u);
  });

  it("returns only the Worker URL", () => {
    assert.match(source, /return \{ url: worker\.url \};/u);
    assert.deepEqual(MONOLITH_GREENFIELD_TOPOLOGY.outputKeys, ["url"]);
  });
});
