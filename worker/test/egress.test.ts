import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { managedPiAccessToken } from "../src/managed-credentials";
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
  proxyOpenAIProgram,
} from "../src/egress";

const OPENAI_HANDLE = "scotty-managed://openai/openai/api-key";
const ACCESS_HANDLE = "scotty-managed://openai/openai-codex/access";
const GITHUB_HANDLE = "scotty-managed://github/github/git-https";
const REAL_OPENAI = "real-openai-key";
const REAL_ACCESS = "real-chatgpt-token";
const REAL_GITHUB = "real-github-token";
const HONEYPOT = "never-expose-honeypot-secret";
const PI_AUTH = JSON.stringify({
  openai: { type: "api_key", key: REAL_OPENAI },
  "openai-codex": {
    type: "oauth",
    access: REAL_ACCESS,
    refresh: ACCESS_HANDLE,
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
    assert.notProperty(handlers, "auth.openai.com");
  });
});

function credential(overrides: Partial<EgressCredentialShape> = {}): EgressCredentialShape {
  return {
    resolve: (handle, repository) =>
      handle === OPENAI_HANDLE || handle === ACCESS_HANDLE
        ? Effect.succeed(Redacted.make(PI_AUTH))
        : handle === GITHUB_HANDLE && repository === "owner/project"
          ? Effect.succeed(Redacted.make(REAL_GITHUB))
          : Effect.succeed(null),
    ...overrides,
  };
}

function run(
  program: Effect.Effect<Response, EgressFailure, EgressCredential | EgressTransport>,
  options: {
    readonly credential?: EgressCredentialShape;
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
