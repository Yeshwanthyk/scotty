import { assert, describe, it } from "@effect/vitest";
import {
  assertFullStackCanaryConfig,
  expectedFullStackCanaryApprovals,
  fullStackCanaryAssetHash,
  fullStackCanaryNames,
} from "./full-stack-canary.ts";

const stage = `scotty-e2e-${"a".repeat(32)}`;

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
    for (const name of Object.values(names)) {
      assert.match(
        name,
        /^scotty-e2e-a{24}-(?:worker|container|sessions|backups|sandbox-bundles)$/u,
      );
      assert.ok(name.length <= 63);
    }
    assert.strictEqual(new Set(Object.values(names)).size, 5);
  });

  it("namespaces the asset digest so initial creation cannot skip the manifest upload", () => {
    const digest = "a".repeat(64);
    const token = fullStackCanaryAssetHash(digest);

    assert.strictEqual(token, `scotty-assets-v1:${digest}`);
    assert.notStrictEqual(token, digest);
  });
});
