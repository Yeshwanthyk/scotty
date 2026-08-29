import { assert, describe, it } from "@effect/vitest";
import { DurableObject } from "cloudflare:workers";
import { ScottyRunnerRegistry } from "../src/runner-registry-object";
import { ScottySandboxConfig } from "../src/sandbox-config-object";
import { ScottyCredentialRegistry } from "../src/credential-object";

describe("native Durable Object exports", () => {
  it("uses the Cloudflare DurableObject host base for registry and config RPC", () => {
    assert.strictEqual(
      Object.getPrototypeOf(ScottyRunnerRegistry.prototype),
      DurableObject.prototype,
    );
    assert.strictEqual(
      Object.getPrototypeOf(ScottySandboxConfig.prototype),
      DurableObject.prototype,
    );
    assert.strictEqual(
      Object.getPrototypeOf(ScottyCredentialRegistry.prototype),
      DurableObject.prototype,
    );
  });
});
