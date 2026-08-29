import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { decodeJsonValue } from "../src/contracts";
import { managedPiAccessToken, managedPiIdToken } from "../src/managed-credentials";
import { SCOTTY_INTERNAL_HOST } from "../src/container-session-egress";
import {
  ALLOWED_HOSTS,
  denyOutbound,
  EgressFailure,
  EgressTransport,
  type EgressTransportShape,
  egressTransportLayer,
  EgressCredential,
  type EgressCredentialShape,
  makeOutboundByHost,
  passThroughProgram,
  proxyChatGptProgram,
  proxyGitHubProgram,
  proxyOAuthRefreshProgram,
  proxyOpenAIProgram,
} from "../src/egress";

const OPENAI_HANDLE = "scotty-managed://openai/openai/api-key";
const ACCESS_HANDLE = "scotty-managed://openai/openai-codex/access";
const REFRESH_HANDLE = "scotty-managed://openai/openai-codex/refresh";
const GITHUB_HANDLE = "scotty-managed://github/github/git-https";
const REAL_OPENAI = "real-openai-key";
const REAL_ACCESS = "real-chatgpt-token";
const REAL_REFRESH = "real-refresh-token";
const REAL_GITHUB = "real-github-token";
const HONEYPOT = "never-expose-honeypot-secret";
const PI_AUTH = JSON.stringify({
  openai: { type: "api_key", key: REAL_OPENAI },
  "openai-codex": {
    type: "oauth",
    access: REAL_ACCESS,
    refresh: REAL_REFRESH,
    expires: 0,
    accountId: "account-123",
  },
});

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

function credential(overrides: Partial<EgressCredentialShape> = {}): EgressCredentialShape {
  return {
    resolve: (handle, repository) =>
      handle === OPENAI_HANDLE || handle === ACCESS_HANDLE || handle === REFRESH_HANDLE
        ? Effect.succeed(Redacted.make(PI_AUTH))
        : handle === GITHUB_HANDLE && repository === "owner/project"
          ? Effect.succeed(Redacted.make(REAL_GITHUB))
          : Effect.succeed(null),
    begin: () =>
      Effect.succeed({
        sessionId: "a0b1c2d3e4f5",
        name: "openai",
        versionRef: "version-a",
        nonce: "lease-nonce",
        startedAt: "2026-01-02T00:00:00.000Z",
      }),
    persist: () => Effect.void,
    cancel: () => Effect.void,
    ...overrides,
  };
}

function run(
  program: Effect.Effect<
    Response,
    EgressFailure,
    EgressCredential | EgressTransport | HttpClient.HttpClient
  >,
  options: {
    readonly credential?: EgressCredentialShape;
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
    Effect.provide(
      Layer.succeed(EgressCredential)(EgressCredential.of(options.credential ?? credential())),
    ),
    Effect.provide(Layer.succeed(EgressTransport)(EgressTransport.of(transport))),
    Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)),
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
              authorization: `Bearer ${OPENAI_HANDLE}`,
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
      assert.equal(sent.url, "https://api.openai.com/v1/models");
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

  it.effect("injects ChatGPT token and account id, but rejects ungranted handles", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      yield* run(
        proxyChatGptProgram(
          new Request("https://chatgpt.com/backend-api/me", {
            headers: { authorization: `Bearer ${managedPiAccessToken(ACCESS_HANDLE)}` },
          }),
        ),
        { nativeRequests: requests },
      );
      const sent = requests[0];
      assert.equal(sent.headers.get("authorization"), "Bearer real-chatgpt-token");
      assert.equal(sent.headers.get("chatgpt-account-id"), "account-123");
      assert.equal(sent.url, "https://chatgpt.com/backend-api/me");
      const rejected = yield* run(
        proxyChatGptProgram(
          new Request("https://chatgpt.com/backend-api/me", {
            headers: { authorization: `Bearer ${managedPiAccessToken(GITHUB_HANDLE)}` },
          }),
        ),
      );
      assert.equal(rejected.status, 403);
    }),
  );

  it.effect("keeps GitHub Bearer and Basic credential types separate", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      yield* run(
        proxyGitHubProgram(
          new Request("https://api.github.com/repos/owner/project", {
            headers: { authorization: `Bearer ${GITHUB_HANDLE}` },
          }),
        ),
        { nativeRequests: requests },
      );
      yield* run(
        proxyGitHubProgram(
          new Request("https://github.com/owner/project.git", {
            headers: { authorization: `Basic ${btoa(`x-access-token:${GITHUB_HANDLE}`)}` },
          }),
        ),
        { nativeRequests: requests },
      );
      assert.equal(requests[0].headers.get("authorization"), `Bearer ${REAL_GITHUB}`);
      const basic = requests[1].headers.get("authorization") ?? "";
      assert.equal(atob(basic.slice(6)), `x-access-token:${REAL_GITHUB}`);
      assert.equal(requests[0].url, "https://api.github.com/repos/owner/project");
      assert.equal(requests[1].url, "https://github.com/owner/project.git");
      assert.equal(
        (yield* run(
          proxyGitHubProgram(
            new Request("https://api.github.com/repos/other/project", {
              headers: { authorization: `Bearer ${GITHUB_HANDLE}` },
            }),
          ),
        )).status,
        403,
      );
    }),
  );

  it.effect("returns credential-bearing redirects without forwarding credentials again", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = yield* run(
        proxyOpenAIProgram(
          new Request("https://api.openai.com/v1/responses", {
            headers: { authorization: `Bearer ${OPENAI_HANDLE}` },
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

  it.effect("strips forwarding metadata and rejects credential-bearing pass-through", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      yield* run(
        passThroughProgram(
          new Request("https://registry.npmjs.org/pkg", {
            headers: {
              "cf-connecting-ip": HONEYPOT,
            },
          }),
        ),
        { nativeRequests: requests },
      );
      const sent = requests[0];
      assert.equal(sent.headers.get("cf-connecting-ip"), null);
      assert.equal(sent.headers.get("cookie"), null);
      assert.equal(sent.headers.get("proxy-authorization"), null);
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
  );
});

describe("OAuth refresh", () => {
  const request = (body: unknown) =>
    new Request("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = { grant_type: "refresh_token", refresh_token: REFRESH_HANDLE, client_id: "client" };

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
        (yield* run(proxyOAuthRefreshProgram(request({ refresh_token: "not-a-managed-handle" }))))
          .status,
        403,
      );
      const busy = yield* run(proxyOAuthRefreshProgram(request(body)), {
        credential: credential({ begin: () => Effect.succeed(null) }),
      });
      assert.equal(busy.status, 409);
      assert.deepEqual(yield* Effect.promise(() => busy.json()), {
        error: { code: "oauth_refresh_busy", message: "OAuth refresh is already in progress" },
      });
      const missing = yield* run(proxyOAuthRefreshProgram(request(body)), {
        credential: credential({ resolve: () => Effect.succeed(null) }),
      });
      assert.equal(missing.status, 502);
    }),
  );

  it.effect(
    "sends the real refresh token only to the exact auth URL and persists before safe response",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const requests: Array<HttpClientRequest.HttpClientRequest> = [];
        const response = yield* run(proxyOAuthRefreshProgram(request(body)), {
          requests,
          credential: credential({
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
        const safeBody = yield* Effect.promise(() => response.json());
        assert.deepStrictEqual(safeBody, {
          id_token: managedPiIdToken(ACCESS_HANDLE),
          access_token: managedPiAccessToken(ACCESS_HANDLE),
          refresh_token: REFRESH_HANDLE,
        });
        assert.ok(!JSON.stringify(safeBody).includes(REAL_REFRESH));
      }),
  );

  it.effect("accepts Pi form refresh and returns safe managed handles with expiry", () =>
    Effect.gen(function* () {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_HANDLE,
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
        id_token: managedPiIdToken(ACCESS_HANDLE),
        access_token: managedPiAccessToken(ACCESS_HANDLE),
        refresh_token: REFRESH_HANDLE,
        expires_in: 3600,
      });
    }),
  );

  it.effect("preserves upstream non-2xx status/envelope/no-store and cancels", () =>
    Effect.gen(function* () {
      let cancels = 0;
      const response = yield* run(proxyOAuthRefreshProgram(request(body)), {
        credential: credential({
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

  it.effect("retains refresh state when a successful upstream response is malformed", () =>
    Effect.gen(function* () {
      let cancels = 0;
      const response = yield* run(proxyOAuthRefreshProgram(request(body)), {
        credential: credential({
          cancel: () =>
            Effect.sync(() => {
              cancels += 1;
            }),
        }),
        respond: () => Effect.succeed(new Response(HONEYPOT, { status: 200 })),
      });
      assert.equal(response.status, 502);
      assert.equal(yield* Effect.promise(() => response.text()), "Invalid OAuth response");
      assert.equal(cancels, 0);
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
          Layer.succeed(EgressCredential)(
            EgressCredential.of(
              credential({
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
  it.effect(
    "retries only Registry persistence exactly three times without canceling stale state",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        let upstreamCalls = 0;
        let cancels = 0;
        const exit = yield* run(proxyOAuthRefreshProgram(request(body)), {
          credential: credential({
            persist: () =>
              Effect.sync(() => {
                attempts += 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new EgressFailure({ reason: "persistence", message: HONEYPOT })),
                ),
              ),
            cancel: () =>
              Effect.sync(() => {
                cancels += 1;
              }),
          }),
          respond: () =>
            Effect.sync(() => {
              upstreamCalls += 1;
              return new Response(JSON.stringify({ access_token: "new-access" }), { status: 200 });
            }),
        }).pipe(Effect.exit);
        assert.strictEqual(attempts, 3);
        assert.strictEqual(upstreamCalls, 1);
        assert.strictEqual(cancels, 0);
        assert.ok(String(exit).includes("Failure"));
        assert.ok(!String(exit).includes(HONEYPOT));
      }),
  );

  it.effect("returns sanitized OAuth output only after persistence confirms", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      let attempts = 0;
      let upstreamCalls = 0;
      const response = yield* run(proxyOAuthRefreshProgram(request(body)), {
        credential: credential({
          persist: () =>
            Effect.sync(() => {
              attempts += 1;
              events.push(`persist-${attempts}`);
            }).pipe(
              Effect.flatMap(() =>
                attempts < 3
                  ? Effect.fail(
                      new EgressFailure({ reason: "persistence", message: "not-yet-committed" }),
                    )
                  : Effect.void,
              ),
            ),
        }),
        respond: () =>
          Effect.sync(() => {
            upstreamCalls += 1;
            events.push("upstream");
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
      assert.deepStrictEqual(events, [
        "upstream",
        "persist-1",
        "persist-2",
        "persist-3",
        "response",
      ]);
      assert.strictEqual(attempts, 3);
      assert.strictEqual(upstreamCalls, 1);
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        id_token: managedPiIdToken(ACCESS_HANDLE),
        access_token: managedPiAccessToken(ACCESS_HANDLE),
        refresh_token: REFRESH_HANDLE,
      });
    }),
  );
});
