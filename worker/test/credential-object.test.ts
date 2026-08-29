import { assert, describe, it } from "@effect/vitest";
import { ScottyCredentialRegistry } from "../src/credential-object";

const registryWithEmptyStorage = () => {
  let value: unknown;
  const storage = {
    transaction: async <A>(operation: (transaction: unknown) => Promise<A>) =>
      operation({
        get: async () => structuredClone(value),
        put: async (_key: string, next: unknown) => {
          value = structuredClone(next);
        },
      }),
  };
  // oxlint-disable-next-line scotty/no-double-cast -- boundary: the test supplies only the storage capability used by the native host state
  const ctx = { storage } as unknown as DurableObjectState;
  const env = {
    CREDENTIAL_WRAPPING_KEY: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
    SCOTTY_INSTALLATION_NAME: "test-installation",
  } as ConstructorParameters<typeof ScottyCredentialRegistry>[1];
  return new ScottyCredentialRegistry(ctx, env);
};

describe("ScottyCredentialRegistry", () => {
  it("returns the registry list through the Durable Object RPC envelope", async () => {
    const registry = registryWithEmptyStorage();

    assert.deepStrictEqual(await registry.list(), { ok: true, value: [] });
  });

  it("returns typed errors through the Durable Object RPC envelope", async () => {
    const registry = registryWithEmptyStorage();

    assert.deepStrictEqual(await registry.issueGrants({ version: 1 }), {
      ok: false,
      error: {
        reason: "invalid_input",
        message: "Credential registry input is invalid",
      },
    });
  });
  it("confirms an already-released Session grant on RPC retry", async () => {
    const registry = registryWithEmptyStorage();

    await registry.sync({
      version: 1,
      credentials: [{ name: "github", kind: "github-cli", scope: "global", token: "token" }],
    });
    const issued = await registry.issueGrants({
      version: 1,
      sessionId: "a0b1c2d3e4f5",
      repository: "owner/repo",
    });
    assert.strictEqual(issued.ok, true);
    if (!issued.ok) return;

    const input = {
      version: 1 as const,
      sessionId: "a0b1c2d3e4f5",
      grants: issued.value.grants,
    };
    const first = await registry.release(input);
    const retry = await registry.release(input);
    assert.deepStrictEqual(first, {
      ok: true,
      value: { version: 1, sessionId: "a0b1c2d3e4f5", released: true },
    });
    assert.deepStrictEqual(retry, first);
  });

  it("returns a structured-cloneable credential wire payload, never Redacted", async () => {
    const registry = registryWithEmptyStorage();
    const secret = "registry-rpc-secret";

    assert.deepStrictEqual(
      await registry.sync({
        version: 1,
        credentials: [{ name: "github", kind: "github-cli", scope: "global", token: secret }],
      }),
      {
        ok: true,
        value: {
          version: 1,
          credentials: [{ name: "github", kind: "github-cli", scope: "global", configured: true }],
        },
      },
    );
    const result = await registry.resolveGithubCliCredential({
      version: 1,
      repository: "owner/repo",
    });

    assert.deepStrictEqual(result, { ok: true, value: { version: 1, value: secret } });
    // Native structuredClone models the structured-clone transport used by workerd DO RPC.
    assert.deepStrictEqual(structuredClone(result), {
      ok: true,
      value: { version: 1, value: secret },
    });
  });
});
