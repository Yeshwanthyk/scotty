import { assert, describe, it } from "vitest";
import { ALLOWED_HOSTS, makeEnvironmentOutbound, makeOutboundByHost } from "../src/egress";

/** The session DO contract: resolves to the binding itself, or null when unmapped. */
type ResolverResponse = {
  readonly name: string;
  readonly scheme: "bearer" | "basic-x-access-token";
  readonly value: string;
} | null;

const runEnvironmentOutbound = (
  request: Request,
  resolveResponse: ResolverResponse,
): Promise<{ status: number; outgoingAuth: string | null }> => {
  const outgoing: Array<Request> = [];
  const nativeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);
    outgoing.push(request);
    return Promise.resolve(new Response("upstream-ok", { status: 200 }));
  }) as typeof globalThis.fetch;
  const handler = makeEnvironmentOutbound(nativeFetch);
  // lint-allow-cast: boundary: focused-test-binding-adapter
  const env = {
    SANDBOX: {
      idFromString: () => "id",
      get: () =>
        ({
          resolveCredentialForOrigin: () => Promise.resolve(resolveResponse),
        }) as never,
    },
  } as never;
  return handler(request, env, { containerId: "id" } as never).then((response: Response) => ({
    status: response.status,
    outgoingAuth: outgoing[0]?.headers.get("authorization") ?? null,
  }));
};

describe("Egress policy", () => {
  it("builds exactly the pass-through host table", () => {
    const handlers = makeOutboundByHost(() => Promise.resolve(new Response()));
    assert.deepEqual(Object.keys(handlers), [...ALLOWED_HOSTS]);
  });

  it("forwards clean pass-through requests and denies credential headers", async () => {
    const handlers = makeOutboundByHost(() =>
      Promise.resolve(new Response("pkg", { status: 200 })),
    );
    const passthrough = handlers["registry.npmjs.org"] as (
      request: Request,
      env: unknown,
      context: unknown,
    ) => Promise<Response>;
    const forwarded = await passthrough(
      new Request("https://registry.npmjs.org/pkg"),
      {},
      { containerId: "id", className: "Sandbox" },
    );
    assert.equal(forwarded.status, 200);

    const denied = await passthrough(
      new Request("https://pypi.org/x", { headers: { authorization: "Bearer token" } }),
      {},
      { containerId: "id", className: "Sandbox" },
    );
    assert.equal(denied.status, 403);
  });

  it("injects mapped bearer credentials for opencode.ai", async () => {
    const result = await runEnvironmentOutbound(
      new Request("https://opencode.ai/zen/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer scotty-injected" },
        body: "{}",
      }),
      { name: "OPENCODE_API_KEY", scheme: "bearer", value: "real-key" },
    );
    assert.equal(result.status, 200);
    assert.equal(result.outgoingAuth, "Bearer real-key");
  });

  it("injects basic-x-access-token credentials for github.com", async () => {
    const sentinel = "scotty-injected";
    const expected = `Basic ${btoa(`x-access-token:real-github-token`)}`;
    const result = await runEnvironmentOutbound(
      new Request("https://github.com/Yeshwanthyk/scotty.git/info/refs?service=git-upload-pack", {
        headers: {
          authorization: `Basic ${btoa(`x-access-token:${sentinel}`)}`,
          "user-agent": "git/2.34.1",
        },
      }),
      { name: "GH_TOKEN", scheme: "basic-x-access-token", value: "real-github-token" },
    );
    assert.equal(result.status, 200);
    assert.equal(result.outgoingAuth, expected);
  });

  it("denies unmapped origins and resolver failures", async () => {
    const request = new Request("https://evil.example/exfil");
    const unmapped = await runEnvironmentOutbound(request, null);
    assert.equal(unmapped.status, 403);

    // lint-allow-double-cast: boundary: the rejection stub intentionally bypasses typing to exercise the resolver catch path
    const rejected = Promise.reject(new Error("rpc boom")) as unknown as ResolverResponse;
    const failed = await runEnvironmentOutbound(request, rejected);
    assert.equal(failed.status, 403);
  });
});
