import { assert, describe, it } from "@effect/vitest";
import { rejects } from "node:assert/strict";
import { vi } from "vitest";
import { managedPiAccessToken } from "../../src/credentials/managed";
import { makeOutboundByHost } from "../../src/egress/worker";
import type { Bindings } from "../../src/shared/bindings";

const containerId = "a".repeat(64);
const oldContainerId = "b".repeat(64);
const handle = "scotty-managed://openai/openai-codex/access";
const sentinel = managedPiAccessToken(handle);
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const body = JSON.stringify({ model: "gpt-5.4", reasoning: { effort: "high" }, input: [] });

// Session and Registry substitutes control authorization; the real outbound handler,
// credential RPC adapter, token selection, header rewriting and transport all execute.
function fixture(status = 200) {
  const selected: string[] = [];
  const resolutions: unknown[] = [];
  const forwarded: Request[] = [];
  const registry = new Map([
    [
      "generation-1",
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "dummy-upstream-access",
          refresh: "dummy-refresh",
          accountId: "dummy-account",
          expires: Number.MAX_SAFE_INTEGER,
        },
      }),
    ],
  ]);
  let authorized = true;
  const session = (id: string) => ({
    resolveCredentialForProxy: async (access: { readonly handle: string }) => {
      resolutions.push({ id, ...access });
      return id === containerId && authorized && access.handle === handle
        ? (registry.get("generation-1") ?? null)
        : null;
    },
  });
  // Native DO bindings expose much more than this adapter consumes. These single
  // boundary assertions stand in only for idFromString/get and the one RPC method.
  const namespace = {
    idFromString: (id: string) => {
      selected.push(id);
      return { toString: () => id };
    },
    get: (id: DurableObjectId) => session(id.toString()),
  } as Bindings["SANDBOX"];
  const env = { SANDBOX: namespace } as Bindings;
  const handlers = makeOutboundByHost((input) => {
    assert.ok(input instanceof Request);
    forwarded.push(input);
    return Promise.resolve(
      new Response(status === 200 ? "data: synthetic\n\n" : "dummy unauthorized", { status }),
    );
  });
  const request = () =>
    new Request(endpoint, {
      method: "POST",
      body,
      headers: {
        authorization: `Bearer ${sentinel}`,
        "chatgpt-account-id": "untrusted-account",
        cookie: "dummy-cookie",
        "proxy-authorization": "dummy-proxy",
        "content-type": "application/json",
      },
    });
  return {
    selected,
    resolutions,
    forwarded,
    registry,
    revoke: () => {
      authorized = false;
    },
    run: (id = containerId, className = "Sandbox") =>
      handlers["chatgpt.com"](request(), env, { containerId: id, className }),
  };
}

describe("Codex managed native request shape through existing egress adapter (separate proof)", () => {
  it("reports only bounded ChatGPT egress outcome codes and HTTP status", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const upstream = fixture(401);
      assert.equal((await upstream.run()).status, 401);
      const revoked = fixture();
      revoked.revoke();
      assert.equal((await revoked.run()).status, 403);
      assert.deepEqual(warning.mock.calls, [
        ["Scotty ChatGPT egress failed", { code: "upstream_http_status", status: 401 }],
        ["Scotty ChatGPT egress failed", { code: "credential_unavailable" }],
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  it("substitutes dummy Session-pinned token/account, retaining Responses path and body", async () => {
    const f = fixture();
    const response = await f.run();
    assert.equal(response.status, 200);
    assert.deepEqual(f.selected, [containerId]);
    assert.deepEqual(f.resolutions, [{ id: containerId, handle }]);
    assert.equal(f.forwarded.length, 1);
    const request = f.forwarded[0];
    assert.equal(request.url, endpoint);
    assert.equal(request.method, "POST");
    assert.equal(await request.text(), body);
    assert.equal(request.headers.get("authorization"), "Bearer dummy-upstream-access");
    assert.equal(request.headers.get("chatgpt-account-id"), "dummy-account");
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.headers.get("proxy-authorization"), null);
    assert.equal(request.redirect, "manual");
    assert.equal(await response.text(), "data: synthetic\n\n");
  });
  it("honors stale runtime, revoked grant and missing pinned generation denials without forwarding", async () => {
    const f = fixture();
    assert.equal((await f.run(oldContainerId)).status, 403);
    f.revoke();
    assert.equal((await f.run()).status, 403);
    const missing = fixture();
    missing.registry.clear();
    assert.equal((await missing.run()).status, 403);
    assert.equal(f.forwarded.length, 0);
    assert.equal(missing.forwarded.length, 0);
  });
  it("rejects malformed container identity and wrong runtime class before credential RPC", async () => {
    for (const [id, className] of [
      ["not-an-id", "Sandbox"],
      [containerId, "Runner"],
    ]) {
      const f = fixture();
      await rejects(f.run(id, className));
      assert.deepEqual(f.selected, []);
      assert.deepEqual(f.resolutions, []);
      assert.deepEqual(f.forwarded, []);
    }
  });
  it("returns upstream 401 with no invented refresh, registry write or retry", async () => {
    const f = fixture(401);
    assert.equal((await f.run()).status, 401);
    assert.equal(f.forwarded.length, 1);
    assert.equal(f.resolutions.length, 1);
    assert.equal(f.registry.size, 1);
  });
});
