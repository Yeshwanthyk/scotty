import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CLOUDFLARE_BINDING_TOPOLOGY,
  EXCLUDED_RUNNER_BINDING,
  EXCLUDED_RUNNER_CLASS,
  EXCLUDED_TOPOLOGY_DO_FIELDS,
  REQUIRED_TOPOLOGY_DO_FIELDS,
  WRANGLER_BINDINGS_INSTALLATION_NAME,
  WRANGLER_CONFIG_PATH,
  assertWranglerBindingsCoverTopology,
  checkWranglerBindings,
  collectWranglerBindings,
  parseJsonc,
  requiredWranglerBindingSubset,
} from "./check-wrangler-bindings.mjs";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const localTopology = () => CLOUDFLARE_BINDING_TOPOLOGY;

const wranglerWith = (overrides = {}) => {
  const config = parseJsonc(read(WRANGLER_CONFIG_PATH));
  return {
    ...config,
    durable_objects: {
      bindings: [...(config.durable_objects?.bindings ?? [])],
    },
    kv_namespaces: [...(config.kv_namespaces ?? [])],
    r2_buckets: [...(config.r2_buckets ?? [])],
    ...overrides,
  };
};

describe("Wrangler binding coverage", () => {
  it("covers the local topology Durable Objects, R2 buckets, and KV without RUNNERS or preview DNS", () => {
    const result = checkWranglerBindings({
      read: (relativePath) => read(relativePath),
    });
    const topology = localTopology();

    assert.deepEqual(
      result.required.durableObjects.map((entry) => entry.className),
      ["ScottySandbox", "ScottyAuthRegistry", "ScottyRunnerRegistry", "ScottySandboxConfig"],
    );
    assert.deepEqual(
      result.required.durableObjects.map((entry) => entry.bindingName),
      ["SANDBOX", "AUTH", "RUNNER_REGISTRY", "SANDBOX_CONFIG"],
    );
    assert.deepEqual(result.required.r2Bindings, [
      "BACKUP_BUCKET",
      "ARTIFACT_BUCKET",
      "SANDBOX_BUNDLE_BUCKET",
    ]);
    assert.deepEqual(result.required.kvBindings, ["SESSIONS"]);
    assert.equal(topology.runnerDurableObject.bindingName, EXCLUDED_RUNNER_BINDING);
    assert.equal(topology.runnerDurableObject.className, EXCLUDED_RUNNER_CLASS);
    assert.equal(
      result.required.durableObjects.some(
        (entry) =>
          entry.bindingName === EXCLUDED_RUNNER_BINDING ||
          entry.className === EXCLUDED_RUNNER_CLASS,
      ),
      false,
    );
    assert.deepEqual([...EXCLUDED_TOPOLOGY_DO_FIELDS], ["runnerDurableObject"]);
    assert.deepEqual(
      [...REQUIRED_TOPOLOGY_DO_FIELDS],
      [
        "durableObject",
        "authDurableObject",
        "runnerRegistryDurableObject",
        "sandboxConfigDurableObject",
      ],
    );
    assert.equal(WRANGLER_BINDINGS_INSTALLATION_NAME, "local");
    assert.equal(
      collectWranglerBindings(parseJsonc(read(WRANGLER_CONFIG_PATH))).durableObjects.some(
        (entry) => entry.bindingName === EXCLUDED_RUNNER_BINDING,
      ),
      false,
    );
    assert.doesNotMatch(read(WRANGLER_CONFIG_PATH), /preview|\*\.|100::/u);
  });

  it("keeps the required subset independent of runner worker and preview topology", () => {
    const topology = {
      ...localTopology(),
      preview: {
        dns: {
          logicalId: "EvidencePreviewWildcardDns",
          name: "*.preview.scotty.example",
          type: "AAAA",
          content: "100::",
          proxied: true,
        },
      },
    };
    const required = requiredWranglerBindingSubset(topology);
    assert.equal(
      required.durableObjects.some((entry) => entry.bindingName === EXCLUDED_RUNNER_BINDING),
      false,
    );
    assert.equal("preview" in required, false);
    assert.doesNotThrow(() =>
      assertWranglerBindingsCoverTopology({
        wrangler: wranglerWith(),
        topology,
      }),
    );
  });

  it("fails closed when a required Durable Object, R2 bucket, or KV binding is missing", () => {
    const topology = localTopology();
    assert.throws(
      () =>
        assertWranglerBindingsCoverTopology({
          wrangler: wranglerWith({
            durable_objects: {
              bindings: wranglerWith().durable_objects.bindings.filter(
                (binding) => binding.class_name !== "ScottySandboxConfig",
              ),
            },
          }),
          topology,
        }),
      /durable object SANDBOX_CONFIG \(ScottySandboxConfig\)/u,
    );
    assert.throws(
      () =>
        assertWranglerBindingsCoverTopology({
          wrangler: wranglerWith({
            r2_buckets: wranglerWith().r2_buckets.filter(
              (bucket) => bucket.binding !== "ARTIFACT_BUCKET",
            ),
          }),
          topology,
        }),
      /R2 ARTIFACT_BUCKET/u,
    );
    assert.throws(
      () =>
        assertWranglerBindingsCoverTopology({
          wrangler: wranglerWith({ kv_namespaces: [] }),
          topology,
        }),
      /KV SESSIONS/u,
    );
  });

  it("is invoked from the shared check script", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(
      pkg.scripts["check:wrangler-bindings"],
      "node scripts/check-wrangler-bindings.mjs",
    );
    assert.match(pkg.scripts.check, /check:wrangler-bindings/u);
    assert.match(pkg.scripts.check, /check:pi-packages/u);
    assert.match(pkg.scripts.check, /check:patches/u);
  });

  it("uses the same plain topology data as the Alchemy stack", () => {
    const stack = read("infra/cloudflare-stack.ts");
    assert.match(stack, /from "\.\.\/scripts\/cloudflare-topology-data\.mjs"/u);
    assert.doesNotMatch(read("scripts/check-wrangler-bindings.mjs"), /cloudflare-stack\.ts/u);
  });
});
