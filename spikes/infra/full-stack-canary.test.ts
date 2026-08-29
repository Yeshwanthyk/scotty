import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import {
  assertFullStackCanaryConfig,
  expectedFullStackCanaryApprovals,
  fullStackCanaryAssetHash,
  fullStackCanaryNames,
} from "./full-stack-canary.ts";

const stage = `scotty-e2e-${"a".repeat(32)}`;
const canarySource = readFileSync(new URL("./full-stack-canary.ts", import.meta.url), "utf8");
const canaryRunSource = readFileSync(
  new URL("./full-stack-canary.run.ts", import.meta.url),
  "utf8",
);
const canaryWorkerSource = readFileSync(
  new URL("./full-stack-canary-worker.ts", import.meta.url),
  "utf8",
);

const approved = () => {
  const approvals = expectedFullStackCanaryApprovals(stage);
  return {
    stage,
    deployApproval: approvals.deploy,
    cleanupApproval: approvals.cleanup,
    telemetryDisabled: true,
  };
};

describe("full-stack canary safety", () => {
  it("accepts only a random disposable stage with exact deploy and cleanup approvals", () => {
    assert.doesNotThrow(() => assertFullStackCanaryConfig(approved()));
    for (const rejected of ["", "production", "scotty-e2e-main", `scotty-e2e-${"A".repeat(32)}`]) {
      assert.throws(
        () => assertFullStackCanaryConfig({ ...approved(), stage: rejected }),
        /refuses stage/u,
      );
    }
    assert.throws(
      () => assertFullStackCanaryConfig({ ...approved(), deployApproval: "yes" }),
      /deployment requires/u,
    );
    assert.throws(
      () => assertFullStackCanaryConfig({ ...approved(), cleanupApproval: "yes" }),
      /cleanup requires/u,
    );
  });

  it("derives every physical resource name from the isolated stage", () => {
    const names = fullStackCanaryNames(stage);
    assert.match(names.installationName, /^scotty-e2e-a{18}$/u);
    for (const name of Object.values(names).filter((value) => value !== names.installationName)) {
      assert.match(
        name,
        /^scotty-e2e-a{24}-(?:worker|container|sessions|backups|sandbox-bundles)$/u,
      );
      assert.ok(name.length <= 63);
    }
    assert.strictEqual(new Set(Object.values(names)).size, 6);
  });

  it("keeps disposable secret values out of Worker props and persisted Action data", () => {
    const workerSource = canarySource.slice(
      canarySource.indexOf("const worker ="),
      canarySource.indexOf("}).pipe(removalPolicy);", canarySource.indexOf("const worker =")) +
        "}).pipe(removalPolicy);".length,
    );
    assert.notMatch(workerSource, /SCOTTY_TOKEN|CREDENTIAL_WRAPPING_KEY/u);
    assert.notMatch(canarySource, /Config\.redacted/u);
    assert.match(canarySource, /worker\.bind\("InheritedWorkerSecrets"/u);
    assert.match(canarySource, /type: "inherit", name: "CREDENTIAL_WRAPPING_KEY"/u);
    assert.match(canarySource, /type: "inherit", name: "SCOTTY_TOKEN"/u);
    assert.match(canarySource, /Alchemy\.Action/u);
    assert.match(canarySource, /workerName: worker\.workerName/u);
    assert.match(canarySource, /return \{ status: "secrets-installed" \}/u);
    assert.match(canarySource, /Workers\.putScriptSecret[\s\S]*?DistilledRetry\.none/u);
    assert.notMatch(canaryRunSource, /(?:SCOTTY_TOKEN|CREDENTIAL_WRAPPING_KEY)\s*:/u);
  });

  it("namespaces the asset digest so initial creation cannot skip the manifest upload", () => {
    const digest = "a".repeat(64);
    const token = fullStackCanaryAssetHash(digest);

    assert.strictEqual(token, `scotty-assets-v1:${digest}`);
    assert.notStrictEqual(token, digest);
  });

  it("keeps the canary subclass on the production Sandbox egress identity", () => {
    assert.match(
      canaryWorkerSource,
      /export const ScottySandbox = class Sandbox extends ProductionSandbox/u,
    );
  });

  it("keeps deployed credential proof at layered boundaries", () => {
    assert.notMatch(canaryWorkerSource, /e2eSecurityProbe|CanarySecurity|__e2e\/security/u);
    assert.notMatch(canaryWorkerSource, /scanCanaryR2Bucket|readBoundedBytes/u);
    assert.notMatch(
      canaryWorkerSource,
      /containerProcessArgsNonSecret|containerProcessEnvNonSecret/u,
    );
    assert.notMatch(canaryWorkerSource, /credentialRegistryStorageInspected/u);
    assert.notMatch(canaryWorkerSource, /containerLogsNonSecret|ownedBackupIds/u);
  });
});
