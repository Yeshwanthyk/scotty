import type { OutboundHandlerContext } from "@cloudflare/containers";
import { assert, describe, it, vi } from "@effect/vitest";
import type { Bindings } from "../src/bindings";
import type { StoredCredential } from "../src/contracts";
import { proxyGitHub } from "../src/egress";
import type { Sandbox } from "../src/session";

const GITHUB_SENTINEL = "scotty-github-session-sentinel";

const storedCredential: StoredCredential = {
  codex: {
    OPENAI_API_KEY: "codex-secret",
    tokens: undefined,
    account_id: null,
    last_refresh: null,
  },
  githubToken: "authority-github-token",
  codexSentinel: "scotty-codex-session-sentinel",
  githubSentinel: GITHUB_SENTINEL,
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("GitHub egress credential lookup", () => {
  it("injects the DO-authoritative GitHub token instead of the Worker seed", async () => {
    const stub = Object.assign(Object.create(null) as DurableObjectStub<Sandbox>, {
      readCredentialForProxy: async () => storedCredential,
    });
    const namespace = Object.assign(Object.create(null) as DurableObjectNamespace<Sandbox>, {
      idFromString: () => undefined,
      get: () => stub,
    });
    const env = Object.assign(Object.create(null) as Bindings, {
      SANDBOX: namespace,
      GH_TOKEN: "changed-worker-seed",
    });
    const context = {
      containerId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    } as OutboundHandlerContext<unknown>;
    let forwarded: Request | undefined;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      forwarded = request instanceof Request ? request : new Request(request);
      return new Response("ok");
    });

    const response = await proxyGitHub(
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${GITHUB_SENTINEL}` },
      }),
      env,
      context,
    );

    fetch.mockRestore();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(forwarded?.headers.get("authorization"), "Bearer authority-github-token");
    assert.ok(!forwarded?.headers.get("authorization")?.includes("changed-worker-seed"));
  });

  it("injects the DO-authoritative token into Git Basic authentication", async () => {
    const stub = Object.assign(Object.create(null) as DurableObjectStub<Sandbox>, {
      readCredentialForProxy: async () => storedCredential,
    });
    const namespace = Object.assign(Object.create(null) as DurableObjectNamespace<Sandbox>, {
      idFromString: () => undefined,
      get: () => stub,
    });
    const env = Object.assign(Object.create(null) as Bindings, {
      SANDBOX: namespace,
      GH_TOKEN: "changed-worker-seed",
    });
    const context = {
      containerId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    } as OutboundHandlerContext<unknown>;
    let forwarded: Request | undefined;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      forwarded = request instanceof Request ? request : new Request(request);
      return new Response("ok");
    });

    const response = await proxyGitHub(
      new Request("https://github.com/owner/repo.git", {
        headers: {
          authorization: `Basic ${btoa(`x-access-token:${GITHUB_SENTINEL}`)}`,
        },
      }),
      env,
      context,
    );

    fetch.mockRestore();
    assert.strictEqual(response.status, 200);
    const authorization = forwarded?.headers.get("authorization") ?? "";
    assert.ok(authorization.startsWith("Basic "));
    assert.strictEqual(atob(authorization.slice(6)), "x-access-token:authority-github-token");
    assert.ok(!authorization.includes("changed-worker-seed"));
  });

  it("rejects a Codex sentinel at the GitHub credential boundary", async () => {
    const stub = Object.assign(Object.create(null) as DurableObjectStub<Sandbox>, {
      readCredentialForProxy: async () => storedCredential,
    });
    const namespace = Object.assign(Object.create(null) as DurableObjectNamespace<Sandbox>, {
      idFromString: () => undefined,
      get: () => stub,
    });
    const env = Object.assign(Object.create(null) as Bindings, {
      SANDBOX: namespace,
      GH_TOKEN: "changed-worker-seed",
    });
    const context = {
      containerId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    } as OutboundHandlerContext<unknown>;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unexpected"));

    const response = await proxyGitHub(
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${storedCredential.codexSentinel}` },
      }),
      env,
      context,
    );

    assert.strictEqual(response.status, 403);
    assert.strictEqual(fetch.mock.calls.length, 0);
    fetch.mockRestore();
  });
});
