import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import type { Bindings } from "../src/bindings";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  decodeJsonValue,
  type CredentialRefreshLease,
  type StoredCredential,
} from "../src/contracts";
import { SCOTTY_INTERNAL_HOST } from "../src/container-session-egress";
import {
  ALLOWED_HOSTS,
  ENVIRONMENT_MAX_BODY_BYTES,
  denyOutbound,
  EgressFailure,
  EnvironmentEgressVault,
  type EnvironmentEgressVaultShape,
  EgressTransport,
  type EgressTransportShape,
  egressTransportLayer,
  EgressVault,
  type EgressVaultShape,
  makeEnvironmentOutbound,
  makeOutboundByHost,
  passThroughProgram,
  piAccessSentinel,
  proxyChatGptProgram,
  proxyOAuthRefreshProgram,
  proxyEnvironmentProgram,
  proxyOpenAIProgram,
} from "../src/egress";

const OPENAI = "scotty-pi-openai-session-sentinel";
const CODEX = "scotty-pi-openai-codex-session-sentinel";
const HONEYPOT = "never-expose-honeypot-secret";
const ENVIRONMENT_A = `scotty-env-a0b1c2d3e4f5-${"0".repeat(32)}`;
const ENVIRONMENT_B = `scotty-env-b0c1d2e3f4a5-${"1".repeat(32)}`;
const ENVIRONMENT_COMPONENT_LIMIT = 16_384;
const credential: StoredCredential = {
  providers: {
    openai: {
      credential: { type: "api_key", key: "real-openai-key" },
      sentinel: OPENAI,
    },
    "openai-codex": {
      credential: {
        type: "oauth",
        access: "real-chatgpt-token",
        refresh: "real-refresh-token",
        expires: 0,
        accountId: "account-123",
      },
      sentinel: CODEX,
    },
  },
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const lease: CredentialRefreshLease = { credential, nonce: "lease-nonce" };

describe("native egress transport", () => {
  it.effect("forwards one exact native request and returns the native response unchanged", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = new Response(null, { status: 304, statusText: "Not Modified Exactly" });
      const nativeFetch: typeof globalThis.fetch = (request) => {
        requests.push(request instanceof Request ? request : new Request(request));
        return Promise.resolve(response);
      };
      const source = new Request("https://registry.npmjs.org/pkg?a=1&a=2&b=3", {
        method: "POST",
        body: "body-value",
      });
      const returned = yield* Effect.flatMap(EgressTransport, (transport) =>
        transport.forward(source, new URL(source.url), new Headers({ "x-test": "yes" })),
      ).pipe(Effect.provide(egressTransportLayer(nativeFetch)));

      assert.strictEqual(returned, response);
      assert.equal(returned.body, null);
      assert.equal(returned.statusText, "Not Modified Exactly");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://registry.npmjs.org/pkg?a=1&a=2&b=3");
      assert.equal(requests[0].redirect, "manual");
      assert.equal(requests[0].headers.get("x-test"), "yes");
      assert.equal(yield* Effect.promise(() => requests[0].text()), "body-value");
    }),
  );

  it.effect("preserves bodyless HEAD, 204, and redirect responses", () =>
    Effect.gen(function* () {
      for (const [method, status, statusText] of [
        ["HEAD", 200, "Head Exactly"],
        ["GET", 204, "No Content Exactly"],
        ["GET", 307, "Redirect Exactly"],
      ] as const) {
        const response = new Response(null, { status, statusText });
        const nativeFetch: typeof globalThis.fetch = () => Promise.resolve(response);
        const source = new Request("https://registry.npmjs.org/pkg", { method });
        const returned = yield* Effect.flatMap(EgressTransport, (transport) =>
          transport.forward(source, new URL(source.url), new Headers()),
        ).pipe(Effect.provide(egressTransportLayer(nativeFetch)));
        assert.strictEqual(returned, response);
        assert.equal(returned.body, null);
        assert.equal(returned.statusText, statusText);
      }
    }),
  );

  it("builds the exact callback map with shared host handlers", () => {
    const nativeFetch: typeof globalThis.fetch = () => Promise.resolve(new Response());
    const handlers = makeOutboundByHost(nativeFetch);
    assert.deepEqual(Object.keys(handlers), [...ALLOWED_HOSTS]);
    assert.strictEqual(handlers["github.com"], handlers["api.github.com"]);
    assert.strictEqual(handlers["codeload.github.com"], handlers["registry.npmjs.org"]);
    assert.notStrictEqual(handlers["api.openai.com"], handlers["chatgpt.com"]);
    assert.notStrictEqual(handlers["auth.openai.com"], handlers["api.openai.com"]);
  });
});

function vault(overrides: Partial<EgressVaultShape> = {}): EgressVaultShape {
  return {
    read: () => Effect.succeed(credential),
    begin: () => Effect.succeed(lease),
    persist: () => Effect.void,
    cancel: () => Effect.void,
    ...overrides,
  };
}

function run(
  program: Effect.Effect<
    Response,
    EgressFailure,
    EgressVault | EgressTransport | HttpClient.HttpClient
  >,
  options: {
    readonly vault?: EgressVaultShape;
    readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>;
    readonly requests?: Array<HttpClientRequest.HttpClientRequest>;
    readonly nativeRespond?: (request: Request) => Effect.Effect<Response>;
    readonly nativeRequests?: Array<Request>;
  } = {},
) {
  const requests = options.requests ?? [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request);
      const response = options.respond
        ? yield* options.respond(request)
        : new Response("ok", { status: 200 });
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const transport: EgressTransportShape = {
    forward: (request, url, headers) => {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
      const init: RequestInit = {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      };
      if (body) Reflect.set(init, "duplex", "half");
      const outgoing = new Request(`https://${url.hostname}${url.pathname}${url.search}`, init);
      options.nativeRequests?.push(outgoing);
      return options.nativeRespond
        ? options.nativeRespond(outgoing)
        : Effect.succeed(new Response("ok", { status: 200 }));
    },
  };
  return program.pipe(
    Effect.provide(Layer.succeed(EgressVault)(EgressVault.of(options.vault ?? vault()))),
    Effect.provide(Layer.succeed(EgressTransport)(EgressTransport.of(transport))),
    Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)),
  );
}

function runEnvironment(
  program: Effect.Effect<Response, EgressFailure, EnvironmentEgressVault | EgressTransport>,
  options: {
    readonly resolve?: EnvironmentEgressVaultShape["resolve"];
    readonly nativeRespond?: (request: Request) => Effect.Effect<Response>;
    readonly nativeRequests?: Array<Request>;
  } = {},
) {
  const transport: EgressTransportShape = {
    forward: (request, url, headers) => {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
      const init: RequestInit = {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      };
      if (body) Reflect.set(init, "duplex", "half");
      const outgoing = new Request(url.toString(), init);
      options.nativeRequests?.push(outgoing);
      return options.nativeRespond
        ? options.nativeRespond(outgoing)
        : Effect.succeed(new Response("ok", { status: 200 }));
    },
  };
  return program.pipe(
    Effect.provide(
      Layer.succeed(EnvironmentEgressVault)(
        EnvironmentEgressVault.of({ resolve: options.resolve ?? (() => Effect.succeed(null)) }),
      ),
    ),
    Effect.provide(Layer.succeed(EgressTransport)(EgressTransport.of(transport))),
  );
}

describe("credential egress", () => {
  it.effect("injects OpenAI API keys, removes x-api-key and strips all ambient headers", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = yield* run(
        proxyOpenAIProgram(
          new Request("https://api.openai.com/v1/models", {
            headers: {
              authorization: `Bearer ${OPENAI}`,
              "x-api-key": HONEYPOT,
              cookie: HONEYPOT,
              "proxy-authorization": HONEYPOT,
              "cf-ray": HONEYPOT,
              "x-forwarded-for": HONEYPOT,
            },
          }),
        ),
        { nativeRequests: requests },
      );
      const sent = requests[0];
      assert.equal(response.status, 200);
      assert.equal(sent.headers.get("authorization"), "Bearer real-openai-key");
      for (const name of [
        "x-api-key",
        "cookie",
        "proxy-authorization",
        "cf-ray",
        "x-forwarded-for",
      ])
        assert.equal(sent.headers.get(name), null);
    }),
  );

  it.effect("uses the OpenAI token fallback", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const { openai: _openai, ...oauthOnlyProviders } = credential.providers;
      const tokenOnly = { ...credential, providers: oauthOnlyProviders };
      yield* run(
        proxyOpenAIProgram(
          new Request("https://api.openai.com/v1/models", { headers: { "x-api-key": CODEX } }),
        ),
        {
          nativeRequests: requests,
          vault: vault({ read: () => Effect.succeed(tokenOnly) }),
        },
      );
      assert.equal(requests[0].headers.get("authorization"), "Bearer real-chatgpt-token");
    }),
  );

  it.effect("injects ChatGPT token and account id and rejects an environment sentinel", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      yield* run(
        proxyChatGptProgram(
          new Request("https://chatgpt.com/backend-api/me", {
            headers: { authorization: `Bearer ${CODEX}` },
          }),
        ),
        { nativeRequests: requests },
      );
      const sent = requests[0];
      assert.equal(sent.headers.get("authorization"), "Bearer real-chatgpt-token");
      assert.equal(sent.headers.get("chatgpt-account-id"), "account-123");
      const rejected = yield* run(
        proxyChatGptProgram(
          new Request("https://chatgpt.com/backend-api/me", {
            headers: { authorization: `Bearer ${ENVIRONMENT_A}` },
          }),
        ),
      );
      assert.equal(rejected.status, 403);
    }),
  );

  it.effect("replaces generic environment sentinels in GitHub Bearer and Basic credentials", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const resolve: EnvironmentEgressVaultShape["resolve"] = (origin, sentinels) => {
        assert.ok(origin === "https://api.github.com" || origin === "https://github.com");
        assert.deepStrictEqual(sentinels, [ENVIRONMENT_A]);
        return Effect.succeed({ [ENVIRONMENT_A]: "real-github-token" });
      };
      yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request("https://api.github.com/user", {
            headers: { authorization: `Bearer ${ENVIRONMENT_A}` },
          }),
        ),
        { resolve, nativeRequests: requests },
      );
      yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request("https://github.com/o/r.git", {
            headers: { authorization: `Basic ${btoa(`x-access-token:${ENVIRONMENT_A}`)}` },
          }),
        ),
        { resolve, nativeRequests: requests },
      );
      assert.equal(requests[0].headers.get("authorization"), "Bearer real-github-token");
      const basic = requests[1].headers.get("authorization") ?? "";
      assert.equal(atob(basic.slice(6)), "x-access-token:real-github-token");
    }),
  );

  it.effect("returns credential-bearing redirects without forwarding credentials again", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = yield* run(
        proxyOpenAIProgram(
          new Request("https://api.openai.com/v1/responses", {
            headers: { authorization: `Bearer ${CODEX}` },
          }),
        ),
        {
          nativeRequests: requests,
          nativeRespond: () =>
            Effect.succeed(
              new Response(null, {
                status: 307,
                headers: { location: "https://evil.example/steal" },
              }),
            ),
        },
      );
      assert.equal(response.status, 307);
      assert.equal(response.headers.get("location"), "https://evil.example/steal");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
    }),
  );
});

describe("pass-through policy", () => {
  it.effect("allows the exact non-credential host matrix without auth headers", () =>
    Effect.gen(function* () {
      assert.deepEqual(Object.keys(makeOutboundByHost(() => Promise.resolve(new Response()))), [
        ...ALLOWED_HOSTS,
      ]);
      const passThroughHosts = ALLOWED_HOSTS.filter(
        (host) =>
          ![
            "api.openai.com",
            "chatgpt.com",
            "auth.openai.com",
            "github.com",
            "api.github.com",
            SCOTTY_INTERNAL_HOST,
          ].includes(host),
      );
      assert.deepEqual(passThroughHosts, [
        "codeload.github.com",
        "objects.githubusercontent.com",
        "raw.githubusercontent.com",
        "*.oaiusercontent.com",
        "registry.npmjs.org",
        "pypi.org",
        "files.pythonhosted.org",
        "proxy.golang.org",
        "sum.golang.org",
        "crates.io",
        "static.crates.io",
        "index.crates.io",
      ]);
      for (const host of passThroughHosts) {
        const requestHost = host === "*.oaiusercontent.com" ? "signed.oaiusercontent.com" : host;
        assert.equal(
          (yield* run(passThroughProgram(new Request(`https://${requestHost}/asset`)))).status,
          200,
        );
      }
    }),
  );

  it.effect("strips cookies/proxy and CF headers, but forbids authorization", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      yield* run(
        passThroughProgram(
          new Request("https://registry.npmjs.org/pkg", {
            headers: {
              cookie: HONEYPOT,
              "proxy-authorization": HONEYPOT,
              "cf-connecting-ip": HONEYPOT,
            },
          }),
        ),
        { nativeRequests: requests },
      );
      const sent = requests[0];
      assert.equal(sent.headers.get("cookie"), null);
      assert.equal(sent.headers.get("proxy-authorization"), null);
      assert.equal(sent.headers.get("cf-connecting-ip"), null);
      assert.equal(
        (yield* run(
          passThroughProgram(
            new Request("https://registry.npmjs.org/pkg", { headers: { authorization: HONEYPOT } }),
          ),
        )).status,
        403,
      );
      assert.equal(denyOutbound().status, 403);
    }),
  );

  it.effect("returns redirects without following or sending credentials to another host", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = yield* run(
        passThroughProgram(new Request("https://registry.npmjs.org/pkg")),
        {
          nativeRequests: requests,
          nativeRespond: () =>
            Effect.succeed(
              new Response(null, {
                status: 302,
                headers: { location: "https://evil.example/steal" },
              }),
            ),
        },
      );
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "https://evil.example/steal");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://registry.npmjs.org/pkg");
    }),
  );

  it.effect("preserves request bodies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<Request> = [];
        yield* run(
          passThroughProgram(
            new Request("https://registry.npmjs.org/pkg", {
              method: "POST",
              body: "body-value",
            }),
          ),
          { nativeRequests: requests },
        );
        const sent = requests[0];
        assert.equal(yield* Effect.promise(() => sent.text()), "body-value");
      }),
    ),
  );
});

describe("OAuth refresh", () => {
  const request = (body: unknown) =>
    new Request("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = { grant_type: "refresh_token", refresh_token: CODEX, client_id: "client" };

  it.effect("rejects malformed OAuth and reports busy or missing leases", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* run(proxyOAuthRefreshProgram(new Request("https://auth.openai.com/oauth/token"))))
          .status,
        403,
      );
      assert.equal(
        (yield* run(
          proxyOAuthRefreshProgram(
            new Request("https://auth.openai.com/not-token", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          ),
        )).status,
        403,
      );
      assert.equal(
        (yield* run(proxyOAuthRefreshProgram(request({ refresh_token: CODEX })))).status,
        403,
      );
      const busy = yield* run(proxyOAuthRefreshProgram(request(body)), {
        vault: vault({ begin: () => Effect.succeed(null) }),
      });
      assert.equal(busy.status, 409);
      assert.deepEqual(yield* Effect.promise(() => busy.json()), {
        error: { code: "oauth_refresh_busy", message: "OAuth refresh is already in progress" },
      });
      const withoutRefresh = {
        ...credential,
        providers: {
          ...credential.providers,
          "openai-codex": {
            ...credential.providers["openai-codex"],
            credential: {
              type: "oauth" as const,
              access: "real-chatgpt-token",
              refresh: "",
              expires: 0,
              accountId: "account-123",
            },
          },
        },
      };
      const missing = yield* run(proxyOAuthRefreshProgram(request(body)), {
        vault: vault({
          begin: () =>
            Effect.succeed({ credential: withoutRefresh, nonce: "missing-refresh-nonce" }),
        }),
      });
      assert.equal(missing.status, 409);
    }),
  );

  it.effect(
    "sends the real refresh token only to the exact auth URL and persists before sentinel response",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const requests: Array<HttpClientRequest.HttpClientRequest> = [];
        const response = yield* run(proxyOAuthRefreshProgram(request(body)), {
          requests,
          vault: vault({
            persist: () => Effect.sync(() => events.push("persist")).pipe(Effect.asVoid),
          }),
          respond: (upstream) =>
            Effect.gen(function* () {
              events.push("upstream");
              assert.equal(upstream.url, "https://auth.openai.com/oauth/token");
              const upstreamRequest = yield* HttpClientRequest.toWeb(upstream).pipe(Effect.orDie);
              const upstreamBody = yield* Effect.promise(() => upstreamRequest.text());
              assert.deepEqual(
                decodeJsonValue(upstreamBody),
                Option.some({
                  grant_type: "refresh_token",
                  refresh_token: "real-refresh-token",
                  client_id: "client",
                }),
              );
              return new Response(
                JSON.stringify({
                  access_token: "rotated-access",
                  refresh_token: "rotated-refresh",
                }),
                { status: 200 },
              );
            }),
        });
        events.push("response");
        assert.deepEqual(events, ["upstream", "persist", "response"]);
        const text = yield* Effect.promise(() => response.text());
        assert.ok(text.includes(CODEX));
        assert.ok(!text.includes("rotated-access") && !text.includes("real-refresh-token"));
      }),
  );

  it.effect("accepts Pi form refresh and returns a JWT-shaped sentinel with expiry", () =>
    Effect.gen(function* () {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: CODEX,
        client_id: "pi-client",
      });
      const response = yield* run(
        proxyOAuthRefreshProgram(
          new Request("https://auth.openai.com/oauth/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form,
          }),
        ),
        {
          respond: (upstream) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(upstream).pipe(Effect.orDie);
              assert.equal(web.headers.get("content-type"), "application/x-www-form-urlencoded");
              assert.deepEqual(
                Object.fromEntries(new URLSearchParams(yield* Effect.promise(() => web.text()))),
                {
                  grant_type: "refresh_token",
                  refresh_token: "real-refresh-token",
                  client_id: "pi-client",
                },
              );
              return new Response(
                JSON.stringify({
                  access_token: "rotated-access",
                  refresh_token: "rotated-refresh",
                  expires_in: 3600,
                }),
                { status: 200 },
              );
            }),
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(yield* Effect.promise(() => response.json()), {
        id_token:
          "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoic2NvdHR5LXNlbnRpbmVsIiwiY2hhdGdwdF9wbGFuX3R5cGUiOiJ1bmtub3duIn19.scotty",
        access_token: piAccessSentinel(CODEX),
        refresh_token: CODEX,
        expires_in: 3600,
      });
    }),
  );

  it.effect("preserves upstream non-2xx status/envelope/no-store and cancels", () =>
    Effect.gen(function* () {
      let cancels = 0;
      const response = yield* run(proxyOAuthRefreshProgram(request(body)), {
        vault: vault({
          cancel: () =>
            Effect.sync(() => {
              cancels += 1;
            }),
        }),
        respond: () => Effect.succeed(new Response(HONEYPOT, { status: 429 })),
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(yield* Effect.promise(() => response.json()), {
        error: { code: "oauth_refresh_failed", message: "OAuth refresh failed" },
      });
      assert.equal(cancels, 1);
    }),
  );

  it.effect("cancels malformed upstream responses", () =>
    Effect.gen(function* () {
      let cancels = 0;
      const response = yield* run(proxyOAuthRefreshProgram(request(body)), {
        vault: vault({
          cancel: () =>
            Effect.sync(() => {
              cancels += 1;
            }),
        }),
        respond: () => Effect.succeed(new Response(HONEYPOT, { status: 200 })),
      });
      assert.equal(response.status, 502);
      assert.equal(yield* Effect.promise(() => response.text()), "Invalid OAuth response");
      assert.equal(cancels, 1);
    }),
  );

  it.effect("cancels transport failures and redacts causes", () =>
    Effect.gen(function* () {
      let cancels = 0;
      const client = HttpClient.make((outgoing) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: outgoing, cause: HONEYPOT }),
          }),
        ),
      );
      const exit = yield* proxyOAuthRefreshProgram(request(body)).pipe(
        Effect.provide(
          Layer.succeed(EgressVault)(
            EgressVault.of(
              vault({
                cancel: () =>
                  Effect.sync(() => {
                    cancels += 1;
                  }),
              }),
            ),
          ),
        ),
        Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)),
        Effect.exit,
      );
      assert.equal(cancels, 1);
      assert.ok(String(exit).includes("Failure"));
      assert.ok(!String(exit).includes(HONEYPOT));
    }),
  );

  it.effect("makes exactly three immediate persistence attempts and redacts stale failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const exit = yield* run(proxyOAuthRefreshProgram(request(body)), {
        vault: vault({
          persist: () =>
            Effect.sync(() => {
              attempts += 1;
            }).pipe(
              Effect.andThen(
                Effect.fail(new EgressFailure({ reason: "persistence", message: HONEYPOT })),
              ),
            ),
        }),
        respond: () =>
          Effect.succeed(
            new Response(JSON.stringify({ access_token: "new-token" }), { status: 200 }),
          ),
      }).pipe(Effect.exit);
      assert.equal(attempts, 3);
      assert.ok(String(exit).includes("Failure"));
      assert.ok(!String(exit).includes(HONEYPOT));
      assert.ok(String(exit).includes("Failed to persist rotated OAuth credential"));
    }),
  );
});

function environmentBindings(
  authorizeEnvironmentRequest: (input: unknown) => Promise<unknown>,
): Bindings {
  const stub = { authorizeEnvironmentRequest };
  const id: DurableObjectId = {
    toString: () => "container",
    equals: () => true,
  };
  const namespace: Bindings["SANDBOX"] = {
    newUniqueId: () => id,
    idFromName: () => id,
    idFromString: () => id,
    get: () => stub as never,
    getByName: () => stub as never,
    jurisdiction: () => namespace,
  };
  return {
    AUTH: undefined as never,
    RUNNER_REGISTRY: undefined as never,
    RUNNERS: undefined as never,
    SANDBOX: namespace,
    SANDBOX_CONFIG: undefined as never,
    SESSIONS: undefined as never,
    BACKUP_BUCKET: undefined as never,
    ARTIFACT_BUCKET: undefined as never,
    SANDBOX_BUNDLE_BUCKET: undefined as never,
    ASSETS: undefined as never,
    SCOTTY_TOKEN: "unused",
    PI_AUTH_JSON: "unused",
  };
}

describe("environment secret egress", () => {
  it.effect(
    "resolves every sentinel, percent-encodes URL components, and preserves the origin",
    () =>
      Effect.gen(function* () {
        const requests: Array<Request> = [];
        const observations: Array<{
          readonly origin: string;
          readonly sentinels: ReadonlyArray<string>;
        }> = [];
        const firstSecret = "https://evil.example/a path";
        const secondSecret = "value/with?query&fragment#text";
        const response = yield* runEnvironment(
          proxyEnvironmentProgram(
            new Request(
              `https://origin.example/path/${ENVIRONMENT_A}?one=${ENVIRONMENT_B}&two=${ENVIRONMENT_A}`,
              {
                headers: {
                  authorization: `Bearer ${ENVIRONMENT_A}`,
                  "x-custom": `${ENVIRONMENT_A},${ENVIRONMENT_B}`,
                  cookie: ENVIRONMENT_A,
                  forwarded: ENVIRONMENT_B,
                  "x-forwarded-for": ENVIRONMENT_A,
                  "x-scotty-internal": ENVIRONMENT_B,
                  "cf-ray": ENVIRONMENT_A,
                  "x-envoy-attempt-count": ENVIRONMENT_B,
                },
              },
            ),
          ),
          {
            nativeRequests: requests,
            resolve: (origin, sentinels) =>
              Effect.sync(() => {
                observations.push({ origin, sentinels });
                return { [ENVIRONMENT_A]: firstSecret, [ENVIRONMENT_B]: secondSecret };
              }),
          },
        );

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(observations, [
          { origin: "https://origin.example", sentinels: [ENVIRONMENT_A, ENVIRONMENT_B] },
        ]);
        const sent = requests[0];
        assert.strictEqual(
          sent.url,
          `https://origin.example/path/${encodeURIComponent(firstSecret)}?one=${encodeURIComponent(secondSecret)}&two=${encodeURIComponent(firstSecret)}`,
        );
        assert.strictEqual(sent.headers.get("authorization"), `Bearer ${firstSecret}`);
        assert.strictEqual(sent.headers.get("x-custom"), `${firstSecret},${secondSecret}`);
        for (const name of [
          "cookie",
          "forwarded",
          "x-forwarded-for",
          "x-scotty-internal",
          "cf-ray",
          "x-envoy-attempt-count",
        ])
          assert.strictEqual(sent.headers.get(name), null);
        assert.notInclude(sent.url, ENVIRONMENT_A);
        assert.notInclude(sent.url, ENVIRONMENT_B);
      }),
  );

  it.effect("blocks pending, rejected, revoked, unknown, and unavailable authorization", () =>
    Effect.gen(function* () {
      for (const reason of [
        "pending",
        "rejected",
        "revoked",
        "unknown_sentinel",
        "session_unavailable",
      ] as const) {
        const requests: Array<Request> = [];
        const response = yield* runEnvironment(
          proxyEnvironmentProgram(new Request(`https://origin.example/path/${ENVIRONMENT_A}`)),
          {
            nativeRequests: requests,
            resolve: () => Effect.succeed(null),
          },
        );
        assert.strictEqual(response.status, 403, reason);
        assert.deepStrictEqual(requests, []);
      }
      const unavailable = yield* runEnvironment(
        proxyEnvironmentProgram(new Request(`https://origin.example/path/${ENVIRONMENT_A}`)),
        {
          resolve: () =>
            Effect.fail(new EgressFailure({ reason: "vault", message: "unavailable" })),
        },
      );
      assert.strictEqual(unavailable.status, 403);
    }),
  );

  it.effect("requires all sentinels to be known and approved before forwarding", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      let resolves = 0;
      const response = yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request(`https://origin.example/path/${ENVIRONMENT_A}/${ENVIRONMENT_B}`),
        ),
        {
          nativeRequests: requests,
          resolve: () =>
            Effect.sync(() => {
              resolves += 1;
              return { [ENVIRONMENT_A]: "only-one-secret" };
            }),
        },
      );
      assert.strictEqual(response.status, 403);
      assert.strictEqual(resolves, 1);
      assert.deepStrictEqual(requests, []);
    }),
  );

  it.effect("fails closed for malformed, truncated, and over-bound sentinels", () =>
    Effect.gen(function* () {
      const malformed = [
        ENVIRONMENT_A.slice(0, -1),
        `${ENVIRONMENT_A}-suffix`,
        `scotty-env-a0b1c2d3e4f5-${"g".repeat(32)}`,
        `${ENVIRONMENT_A} scotty-env-a0b1c2d3e4f5-truncated`,
      ];
      for (const value of malformed) {
        let resolves = 0;
        const requests: Array<Request> = [];
        const response = yield* runEnvironment(
          proxyEnvironmentProgram(new Request(`https://origin.example/path/${value}`)),
          {
            nativeRequests: requests,
            resolve: () =>
              Effect.sync(() => {
                resolves += 1;
                return { [ENVIRONMENT_A]: "must-not-forward" };
              }),
          },
        );
        assert.strictEqual(response.status, 403);
        assert.strictEqual(resolves, 0);
        assert.deepStrictEqual(requests, []);
        assert.notInclude(yield* Effect.promise(() => response.text()), "must-not-forward");
      }

      const overBound = yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request(
            `https://origin.example/${"x".repeat(ENVIRONMENT_COMPONENT_LIMIT)}${ENVIRONMENT_A}`,
          ),
        ),
        {
          resolve: () => Effect.succeed({ [ENVIRONMENT_A]: "must-not-forward" }),
        },
      );
      assert.strictEqual(overBound.status, 403);
      assert.strictEqual(overBound.status, 403);

      const overBoundHeaders = new Headers();
      for (let index = 0; index <= 128; index += 1)
        overBoundHeaders.set(`x-bound-${String(index).padStart(3, "0")}`, ENVIRONMENT_A);
      const overBoundHeader = yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request("https://origin.example/package", { headers: overBoundHeaders }),
        ),
        { resolve: () => Effect.succeed({ [ENVIRONMENT_A]: "must-not-forward" }) },
      );
      assert.strictEqual(overBoundHeader.status, 403);
    }),
  );

  it.effect("rejects CR/LF header injection while allowing URL percent encoding", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const headerInjection = yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request(`https://origin.example/path/${ENVIRONMENT_A}`, {
            headers: { "x-secret": ENVIRONMENT_A },
          }),
        ),
        {
          nativeRequests: requests,
          resolve: () => Effect.succeed({ [ENVIRONMENT_A]: "line-one\r\nx-injected: yes" }),
        },
      );
      assert.strictEqual(headerInjection.status, 403);
      assert.deepStrictEqual(requests, []);

      const urlValue = "line-one\r\nline-two";
      const urlInjection = yield* runEnvironment(
        proxyEnvironmentProgram(new Request(`https://origin.example/path/${ENVIRONMENT_A}`)),
        {
          nativeRequests: requests,
          resolve: () => Effect.succeed({ [ENVIRONMENT_A]: urlValue }),
        },
      );
      assert.strictEqual(urlInjection.status, 200);
      assert.strictEqual(
        requests[0]?.url,
        `https://origin.example/path/${encodeURIComponent(urlValue)}`,
      );
    }),
  );

  it("gives generic sentinels precedence on legacy hosts and preserves package pass-through", async () => {
    const forwarded: Array<Request> = [];
    const rpcInputs: unknown[] = [];
    const nativeFetch: typeof globalThis.fetch = (request) => {
      forwarded.push(request instanceof Request ? request : new Request(request));
      return Promise.resolve(new Response("forwarded"));
    };
    const handler = makeOutboundByHost(nativeFetch)["registry.npmjs.org"];
    assert.isFunction(handler);
    const context = { containerId: "container", className: "Sandbox" };

    const pending = await handler(
      new Request(`https://registry.npmjs.org/pkg?token=${ENVIRONMENT_A}`),
      environmentBindings(async (input) => {
        rpcInputs.push(input);
        return { authorized: false, reason: "pending" };
      }),
      context,
    );
    assert.strictEqual(pending.status, 403);
    assert.strictEqual(forwarded.length, 0);
    assert.deepStrictEqual(rpcInputs, [
      { origin: "https://registry.npmjs.org", sentinels: [ENVIRONMENT_A] },
    ]);

    const approved = await handler(
      new Request(`https://registry.npmjs.org/pkg?token=${ENVIRONMENT_A}`),
      environmentBindings(async () => ({
        authorized: true,
        reason: "approved",
        values: { [ENVIRONMENT_A]: "real-package-token" },
      })),
      context,
    );
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(
      forwarded[0]?.url,
      "https://registry.npmjs.org/pkg?token=real-package-token",
    );

    let unexpectedRpcCalls = 0;
    const legacy = await handler(
      new Request("https://registry.npmjs.org/pkg"),
      environmentBindings(async () => {
        unexpectedRpcCalls += 1;
        return { authorized: false, reason: "session_unavailable" };
      }),
      context,
    );
    assert.strictEqual(legacy.status, 200);
    assert.strictEqual(forwarded.length, 2);
    assert.strictEqual(unexpectedRpcCalls, 0);
  });

  it("blocks catch-all generic outbound without a recognized sentinel", async () => {
    let nativeCalls = 0;
    const outbound = makeEnvironmentOutbound(() => {
      nativeCalls += 1;
      return Promise.resolve(new Response("must-not-forward"));
    });
    const env = environmentBindings(async () => ({
      authorized: true,
      reason: "approved",
      values: { [ENVIRONMENT_A]: "real-secret" },
    }));
    const context = { containerId: "container", className: "Sandbox" };

    const noSentinel = await outbound(
      new Request("https://unlisted.example/package"),
      env,
      context,
    );
    assert.strictEqual(noSentinel.status, 403);
    const malformed = await outbound(
      new Request(`https://unlisted.example/package/${ENVIRONMENT_A.slice(0, -1)}`),
      env,
      context,
    );
    assert.strictEqual(malformed.status, 403);
    assert.strictEqual(nativeCalls, 0);
  });
});

describe("environment secret egress body scanning", () => {
  const context = { containerId: "container", className: "Sandbox" };

  it.effect(
    "authorizes and replaces text, JSON, and form body sentinels without consuming the forward body",
    () =>
      Effect.gen(function* () {
        const cases = [
          {
            contentType: "text/plain",
            body: `text=${ENVIRONMENT_A}`,
            expected: "text=body-text-secret",
            secret: "body-text-secret",
          },
          {
            contentType: "application/json",
            body: JSON.stringify({ token: ENVIRONMENT_A }),
            expected: JSON.stringify({ token: 'body-json-secret"' }),
            secret: 'body-json-secret"',
          },
          {
            contentType: "application/x-www-form-urlencoded",
            body: `token=${ENVIRONMENT_A}`,
            expected: `token=${encodeURIComponent("body form secret")}`,
            secret: "body form secret",
          },
        ] as const;
        for (const item of cases) {
          const requests: Array<Request> = [];
          const observations: Array<{
            readonly origin: string;
            readonly sentinels: ReadonlyArray<string>;
          }> = [];
          const response = yield* runEnvironment(
            proxyEnvironmentProgram(
              new Request("https://origin.example/body", {
                method: "POST",
                headers: { "content-type": item.contentType, "x-body-test": "yes" },
                body: item.body,
              }),
            ),
            {
              nativeRequests: requests,
              resolve: (origin, sentinels) =>
                Effect.sync(() => {
                  observations.push({ origin, sentinels });
                  return { [ENVIRONMENT_A]: item.secret };
                }),
            },
          );
          assert.strictEqual(response.status, 200);
          assert.deepStrictEqual(observations, [
            { origin: "https://origin.example", sentinels: [ENVIRONMENT_A] },
          ]);
          const sent = requests[0];
          assert.strictEqual(sent.method, "POST");
          assert.strictEqual(sent.headers.get("x-body-test"), "yes");
          assert.strictEqual(sent.headers.get("content-length"), null);
          assert.strictEqual(yield* Effect.promise(() => sent.text()), item.expected);
        }
      }),
  );

  it.effect("blocks pending, rejected, revoked, and unknown body-only sentinels", () =>
    Effect.gen(function* () {
      for (const reason of ["pending", "rejected", "revoked", "unknown_sentinel"] as const) {
        const requests: Array<Request> = [];
        let resolves = 0;
        const response = yield* runEnvironment(
          proxyEnvironmentProgram(
            new Request("https://origin.example/body", {
              method: "POST",
              headers: { "content-type": "text/plain" },
              body: `token=${ENVIRONMENT_A}`,
            }),
          ),
          {
            nativeRequests: requests,
            resolve: () =>
              Effect.sync(() => {
                resolves += 1;
                return null;
              }),
          },
        );
        assert.strictEqual(response.status, 403, reason);
        assert.strictEqual(resolves, 1, reason);
        assert.deepStrictEqual(requests, [], reason);
      }
    }),
  );

  it.effect("fails closed for malformed and truncated body sentinels before authorization", () =>
    Effect.gen(function* () {
      const bodies = [
        { contentType: "text/plain", body: ENVIRONMENT_A.slice(0, -1) },
        { contentType: "application/x-www-form-urlencoded", body: `token=${ENVIRONMENT_A}-suffix` },
        { contentType: "application/json", body: `{"token":"${ENVIRONMENT_A}"` },
      ] as const;
      for (const item of bodies) {
        const requests: Array<Request> = [];
        let resolves = 0;
        const response = yield* runEnvironment(
          proxyEnvironmentProgram(
            new Request("https://origin.example/body", {
              method: "POST",
              headers: { "content-type": item.contentType },
              body: item.body,
            }),
          ),
          {
            nativeRequests: requests,
            resolve: () =>
              Effect.sync(() => {
                resolves += 1;
                return { [ENVIRONMENT_A]: "must-not-forward" };
              }),
          },
        );
        assert.strictEqual(response.status, 403);
        assert.strictEqual(resolves, 0);
        assert.deepStrictEqual(requests, []);
      }
    }),
  );

  it.effect("requires all body sentinels to be known and approved", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const observations: Array<ReadonlyArray<string>> = [];
      const approved = yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request("https://origin.example/body", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ first: ENVIRONMENT_A, second: ENVIRONMENT_B }),
          }),
        ),
        {
          nativeRequests: requests,
          resolve: (origin, sentinels) =>
            Effect.sync(() => {
              observations.push(sentinels);
              assert.strictEqual(origin, "https://origin.example");
              return {
                [ENVIRONMENT_A]: "first-secret",
                [ENVIRONMENT_B]: "second-secret",
              };
            }),
        },
      );
      assert.strictEqual(approved.status, 200);
      assert.deepStrictEqual(observations, [[ENVIRONMENT_A, ENVIRONMENT_B]]);
      assert.strictEqual(
        yield* Effect.promise(() => requests[0].text()),
        JSON.stringify({ first: "first-secret", second: "second-secret" }),
      );

      const rejectedRequests: Array<Request> = [];
      const rejected = yield* runEnvironment(
        proxyEnvironmentProgram(
          new Request("https://origin.example/body", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: `${ENVIRONMENT_A},${ENVIRONMENT_B}`,
          }),
        ),
        {
          nativeRequests: rejectedRequests,
          resolve: () => Effect.succeed({ [ENVIRONMENT_A]: "only-one-secret" }),
        },
      );
      assert.strictEqual(rejected.status, 403);
      assert.deepStrictEqual(rejectedRequests, []);
    }),
  );

  it("applies body authorization on catch-all, OpenAI, GitHub, and package handlers", async () => {
    const forwarded: Array<Request> = [];
    const rpcInputs: unknown[] = [];
    const nativeFetch: typeof globalThis.fetch = (request) => {
      forwarded.push(request instanceof Request ? request : new Request(request));
      return Promise.resolve(new Response("forwarded"));
    };
    const env = environmentBindings(async (input) => {
      rpcInputs.push(input);
      return {
        authorized: true,
        reason: "approved",
        values: { [ENVIRONMENT_A]: "body-handler-secret" },
      };
    });
    const handlers = makeOutboundByHost(nativeFetch);
    const requests = [
      {
        handler: makeEnvironmentOutbound(nativeFetch),
        url: "https://unlisted.example/body",
        body: `catch-all=${ENVIRONMENT_A}`,
        contentType: "text/plain",
        expected: "catch-all=body-handler-secret",
      },
      {
        handler: handlers["api.openai.com"],
        url: "https://api.openai.com/v1/responses",
        body: JSON.stringify({ token: ENVIRONMENT_A }),
        contentType: "application/json",
        expected: JSON.stringify({ token: "body-handler-secret" }),
      },
      {
        handler: handlers["github.com"],
        url: "https://github.com/org/repo.git",
        body: `token=${ENVIRONMENT_A}`,
        contentType: "application/x-www-form-urlencoded",
        expected: "token=body-handler-secret",
      },
      {
        handler: handlers["registry.npmjs.org"],
        url: "https://registry.npmjs.org/package",
        body: `token=${ENVIRONMENT_A}`,
        contentType: "text/plain",
        expected: "token=body-handler-secret",
      },
    ] as const;
    for (const item of requests) {
      assert.isFunction(item.handler);
      const response = await item.handler(
        new Request(item.url, {
          method: "POST",
          headers: { "content-type": item.contentType },
          body: item.body,
        }),
        env,
        context,
      );
      assert.strictEqual(response.status, 200);
      const sent = forwarded[forwarded.length - 1];
      assert.strictEqual(new URL(sent.url).origin, new URL(item.url).origin);
      assert.strictEqual(await sent.text(), item.expected);
      assert.strictEqual(sent.headers.get("authorization"), null);
    }
    assert.lengthOf(rpcInputs, requests.length);
  });

  it("scans generic sentinels after the previous 64 KiB window on legacy handlers", async () => {
    const padding = "x".repeat(64 * 1024);
    const body = `${padding}${ENVIRONMENT_A}`;
    const forwarded: Array<Request> = [];
    const nativeFetch: typeof globalThis.fetch = (request) => {
      forwarded.push(request instanceof Request ? request : new Request(request));
      return Promise.resolve(new Response("forwarded"));
    };
    const handlers = makeOutboundByHost(nativeFetch);
    const requests = [
      { handler: handlers["api.openai.com"], url: "https://api.openai.com/v1/responses" },
      { handler: handlers["github.com"], url: "https://github.com/org/repo.git" },
      { handler: handlers["registry.npmjs.org"], url: "https://registry.npmjs.org/package" },
    ] as const;

    for (const item of requests) {
      assert.isFunction(item.handler);
      const forwardedBeforePending = forwarded.length;
      const pending = await item.handler(
        new Request(item.url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        }),
        environmentBindings(async () => ({ authorized: false, reason: "pending" })),
        context,
      );
      assert.strictEqual(pending.status, 403);
      assert.lengthOf(forwarded, forwardedBeforePending);

      const approved = await item.handler(
        new Request(item.url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        }),
        environmentBindings(async () => ({
          authorized: true,
          reason: "approved",
          values: { [ENVIRONMENT_A]: "approved-body-secret" },
        })),
        context,
      );
      assert.strictEqual(approved.status, 200);
      assert.lengthOf(forwarded, forwardedBeforePending + 1);
      assert.strictEqual(
        await forwarded[forwardedBeforePending].text(),
        `${padding}approved-body-secret`,
      );
    }
  });

  it("preserves ordinary large bodies but blocks hard-limit overflow and uninspectable prefixes", async () => {
    const forwarded: Array<Request> = [];
    let rpcCalls = 0;
    const nativeFetch: typeof globalThis.fetch = (request) => {
      forwarded.push(request instanceof Request ? request : new Request(request));
      return Promise.resolve(new Response("forwarded"));
    };
    const handler = makeOutboundByHost(nativeFetch)["registry.npmjs.org"];
    assert.isFunction(handler);
    const ordinaryBody = "ordinary-large-body-".repeat(4_000);
    const ordinary = await handler(
      new Request("https://registry.npmjs.org/ordinary", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: ordinaryBody,
      }),
      environmentBindings(async () => {
        rpcCalls += 1;
        return { authorized: false, reason: "session_unavailable" };
      }),
      context,
    );
    assert.strictEqual(ordinary.status, 200);
    assert.strictEqual(await forwarded[0].text(), ordinaryBody);
    assert.strictEqual(rpcCalls, 0);

    assert.isAbove(ordinaryBody.length, 64 * 1024);
    assert.isBelow(ordinaryBody.length, ENVIRONMENT_MAX_BODY_BYTES);

    const declaredOversized = await handler(
      new Request("https://registry.npmjs.org/declared-oversized", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(ENVIRONMENT_MAX_BODY_BYTES + 1),
        },
        body: "ordinary-body",
      }),
      environmentBindings(async () => {
        rpcCalls += 1;
        return { authorized: true, reason: "approved", values: {} };
      }),
      context,
    );
    assert.strictEqual(declaredOversized.status, 403);
    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(rpcCalls, 0);

    const oversized = await handler(
      new Request("https://registry.npmjs.org/oversized", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x".repeat(ENVIRONMENT_MAX_BODY_BYTES + 1),
      }),
      environmentBindings(async () => {
        rpcCalls += 1;
        return { authorized: true, reason: "approved", values: {} };
      }),
      context,
    );
    assert.strictEqual(oversized.status, 403);
    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(rpcCalls, 0);

    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`prefix=${ENVIRONMENT_A}`));
        controller.error(new Error("body unavailable"));
      },
    });
    const failingRequestInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: failingBody,
    };
    Reflect.set(failingRequestInit, "duplex", "half");
    const uninspectable = await handler(
      new Request("https://registry.npmjs.org/uninspectable", failingRequestInit),
      environmentBindings(async () => {
        rpcCalls += 1;
        return { authorized: true, reason: "approved", values: { [ENVIRONMENT_A]: "secret" } };
      }),
      context,
    );
    assert.strictEqual(uninspectable.status, 403);
    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(rpcCalls, 0);
  });
});
