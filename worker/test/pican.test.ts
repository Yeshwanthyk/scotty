import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { credentialVaultLayer } from "../src/credential-vault";
import {
  decodePicanBootstrapResponseJson,
  Pican,
  PicanTransportFailure,
  picanLayer,
  type PicanCapabilities,
  type PicanCreateResult,
} from "../src/pican";
import {
  sandboxRuntimeLayer,
  type SandboxProcessCapabilities,
  type SandboxRuntimeCapabilities,
} from "../src/sandbox-runtime";
import { makeCredentialVaultStorageFake, sandboxRuntimeCapabilitiesFake } from "./support";
import { makeStoredCredential } from "./session-harness";

const SENTINEL = "scotty-codex-a0b1c2d3e4f5-pican";
const PICAN_PROXY_TOKEN = "scotty-pican-proxy-a0b1c2d3e4f5";
const SESSION_ID = "a0b1c2d3e4f5";

const processCapabilities = (
  overrides: Partial<SandboxProcessCapabilities> = {},
): SandboxProcessCapabilities => ({
  id: "scotty-pican",
  status: "running",
  kill: () => Promise.resolve(),
  waitForExit: () => Promise.resolve({ exitCode: 0 }),
  waitForPort: () => Promise.resolve(),
  ...overrides,
});

const withPican = <A, E>(
  capabilities: PicanCapabilities,
  effect: Effect.Effect<A, E, Pican>,
  runtimeOverrides: Partial<SandboxRuntimeCapabilities> = {},
): Effect.Effect<A, E> =>
  Effect.provide(
    effect,
    picanLayer(capabilities).pipe(
      Layer.provide(
        Layer.merge(
          credentialVaultLayer(
            makeCredentialVaultStorageFake(
              makeStoredCredential({
                codexSentinel: SENTINEL,
                picanProxyToken: PICAN_PROXY_TOKEN,
              }),
            ),
            "unused-github-seed",
          ),
          sandboxRuntimeLayer({
            ...sandboxRuntimeCapabilitiesFake(),
            getProcess: () => Promise.resolve(null),
            startProcess: () => Promise.resolve(processCapabilities()),
            ...runtimeOverrides,
          }),
        ),
      ),
    ),
  );

const fetchPican = (request: Request) => Effect.flatMap(Pican, (pican) => pican.fetch(request));
const launchPican = (id: string) => Effect.flatMap(Pican, (pican) => pican.launch(id));
const createHostedSession = (id: string, prompt?: string) =>
  Effect.flatMap(Pican, (pican) => pican.createHostedSession(id, prompt));
const stopPican = () => Effect.flatMap(Pican, (pican) => pican.stop());

describe("Pican", () => {
  it("decodes only the bootstrap fields the Worker persists", () => {
    const valid = decodePicanBootstrapResponseJson(
      JSON.stringify({ defaultBranch: "main", repoExists: true }),
    );
    const invalid = decodePicanBootstrapResponseJson(
      JSON.stringify({ defaultBranch: "", repoExists: "yes" }),
    );

    assert.ok(Result.isSuccess(valid));
    assert.deepStrictEqual(valid.success, {
      defaultBranch: "main",
      repoExists: true,
    });
    assert.ok(Result.isFailure(invalid));
  });

  it.effect("forwards the request exactly while replacing browser and proxy credentials", () =>
    Effect.gen(function* () {
      let forwarded: Request | undefined;
      let port: number | undefined;
      const capabilities: PicanCapabilities = {
        containerFetch: (request, requestedPort) => {
          forwarded = request;
          port = requestedPort;
          return Promise.resolve(new Response("ok"));
        },
      };
      const headers = new Headers({
        authorization: "Bearer browser-secret",
        connection: "keep-alive, x-remove-me",
        cookie: "scotty=browser-secret",
        "x-remove-me": "hop-by-hop",
        "x-forwarded-for": "203.0.113.10",
        "x-pican-proxy-token": "spoofed-token",
        "x-request-id": "request-1",
      });
      const request = new Request("https://scotty.example.test/api/events?cursor=7", {
        method: "POST",
        headers,
        body: "stream me",
      });

      const response = yield* withPican(capabilities, fetchPican(request));

      assert.strictEqual(yield* Effect.promise(() => response.text()), "ok");
      assert.ok(forwarded);
      const captured = forwarded;
      assert.strictEqual(port, 31_415);
      assert.strictEqual(captured.method, "POST");
      assert.strictEqual(captured.url, "https://scotty.example.test/api/events?cursor=7");
      assert.strictEqual(yield* Effect.promise(() => captured.text()), "stream me");
      assert.strictEqual(captured.headers.get("x-request-id"), "request-1");
      assert.strictEqual(captured.headers.get("x-pican-proxy-token"), PICAN_PROXY_TOKEN);
      assert.strictEqual(captured.headers.get("authorization"), null);
      assert.strictEqual(captured.headers.get("cookie"), null);
      assert.strictEqual(captured.headers.get("connection"), null);
      assert.strictEqual(captured.headers.get("x-remove-me"), null);
      assert.strictEqual(captured.headers.get("x-forwarded-for"), null);
    }),
  );

  it.effect(
    "returns the upstream stream without buffering and strips unsafe response headers",
    () =>
      Effect.gen(function* () {
        const body = new ReadableStream<Uint8Array>();
        const capabilities: PicanCapabilities = {
          containerFetch: () =>
            Promise.resolve(
              new Response(body, {
                status: 202,
                statusText: "Accepted",
                headers: {
                  connection: "close, x-remove-me",
                  "set-cookie": "pican=secret",
                  "x-pican-event": "ready",
                  "x-remove-me": "hop-by-hop",
                },
              }),
            ),
        };

        const response = yield* withPican(
          capabilities,
          fetchPican(new Request("https://scotty.example.test/events")),
        );

        assert.strictEqual(response.status, 202);
        assert.strictEqual(response.statusText, "Accepted");
        assert.strictEqual(response.body, body);
        assert.strictEqual(response.headers.get("x-pican-event"), "ready");
        assert.strictEqual(response.headers.get("set-cookie"), null);
        assert.strictEqual(response.headers.get("connection"), null);
        assert.strictEqual(response.headers.get("x-remove-me"), null);
      }),
  );

  it.effect("maps provider rejection to a fixed redacted typed failure", () =>
    Effect.gen(function* () {
      const capabilities: PicanCapabilities = {
        containerFetch: () =>
          Promise.reject(new Error("provider leaked ghp_secret and scotty-codex-session-secret")),
      };

      const result = yield* Effect.result(
        withPican(capabilities, fetchPican(new Request("https://scotty.example.test/api/session"))),
      );

      assert.ok(Result.isFailure(result));
      assert.deepStrictEqual(
        result.failure,
        new PicanTransportFailure({
          reason: "transport",
          message: "Pican upstream transport failed",
        }),
      );
      assert.ok(!JSON.stringify(result.failure).includes("ghp_"));
      assert.ok(!JSON.stringify(result.failure).includes("session-secret"));
    }),
  );

  it.effect("propagates Effect interruption to the forwarded request signal", () =>
    Effect.gen(function* () {
      let forwarded: Request | undefined;
      let resolvePending: (response: Response) => void = () => undefined;
      const pending = new Promise<Response>((resolve) => {
        resolvePending = resolve;
      });
      const capabilities: PicanCapabilities = {
        containerFetch: (request) => {
          forwarded = request;
          return pending;
        },
      };
      const fiber = yield* withPican(
        capabilities,
        fetchPican(new Request("https://scotty.example.test/events")),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      assert.ok(forwarded);
      assert.strictEqual(forwarded.signal.aborted, false);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(forwarded.signal.aborted, true);
      resolvePending(new Response());
    }),
  );

  it.effect("launches hosted Pican and proves readiness through its authenticated HTTP mount", () =>
    Effect.gen(function* () {
      let command: string | undefined;
      let options:
        | Parameters<NonNullable<SandboxRuntimeCapabilities["startProcess"]>>[1]
        | undefined;
      const readinessRequests: Array<readonly [Request, number]> = [];

      yield* withPican(
        {
          containerFetch: (request, port) => {
            readinessRequests.push([request, port]);
            return Promise.resolve(Response.json({ ready: true }));
          },
        },
        launchPican(SESSION_ID),
        {
          startProcess: (nextCommand, nextOptions) => {
            command = nextCommand;
            options = nextOptions;
            return Promise.resolve(processCapabilities());
          },
        },
      );

      assert.strictEqual(
        command,
        "/usr/local/bin/pican -host 0.0.0.0 -p 31415 -runtime codex -codex-command /usr/local/bin/codex",
      );
      assert.ok(options);
      assert.strictEqual(options.processId, "scotty-pican");
      assert.strictEqual(options.autoCleanup, true);
      assert.strictEqual(options.cwd, `/workspace/${SESSION_ID}`);
      assert.deepStrictEqual(options.env, {
        CODEX_HOME: `/workspace/${SESSION_ID}/.codex`,
        OPENAI_API_KEY: SENTINEL,
        GH_TOKEN: `scotty-github-${SESSION_ID}-sentinel`,
        GITHUB_SENTINEL: `scotty-github-${SESSION_ID}-sentinel`,
        GIT_TERMINAL_PROMPT: "0",
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PICAN_MODE: "hosted",
        PICAN_BASE_PATH: `/s/${SESSION_ID}`,
        PICAN_WORKSPACE_ROOT: `/workspace/${SESSION_ID}`,
        PICAN_STATE_ROOT: `/workspace/${SESSION_ID}/.pican`,
        PICAN_AUTH_MODE: "proxy",
        PICAN_PROXY_HEADER: "X-Pican-Proxy-Token",
        PICAN_PROXY_TOKEN,
      });
      assert.strictEqual(command?.includes(PICAN_PROXY_TOKEN), false);
      assert.strictEqual(readinessRequests.length, 1);
      assert.strictEqual(readinessRequests[0]?.[1], 31_415);
      assert.strictEqual(
        readinessRequests[0]?.[0].url,
        `http://pican.internal/s/${SESSION_ID}/api/settings`,
      );
      assert.strictEqual(
        readinessRequests[0]?.[0].headers.get("x-pican-proxy-token"),
        PICAN_PROXY_TOKEN,
      );
    }),
  );

  it.effect("observes an existing stable process instead of starting a duplicate", () =>
    Effect.gen(function* () {
      let starts = 0;
      const existing = processCapabilities({
        waitForPort: () => Promise.reject(new Error("process-bound readiness must not be used")),
      });

      yield* withPican(
        { containerFetch: () => Promise.resolve(new Response()) },
        launchPican(SESSION_ID),
        {
          getProcess: () => Promise.resolve(existing),
          startProcess: () => {
            starts += 1;
            return Promise.resolve(processCapabilities());
          },
        },
      );

      assert.strictEqual(starts, 0);
    }),
  );

  it.effect("retries the mounted HTTP readiness probe on the deterministic clock", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const launched = yield* withPican(
        {
          containerFetch: () => {
            attempts += 1;
            return Promise.resolve(
              attempts === 1
                ? new Response("starting", { status: 503 })
                : Response.json({ ready: true }),
            );
          },
        },
        launchPican(SESSION_ID),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      assert.strictEqual(attempts, 1);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(launched);
      assert.strictEqual(attempts, 2);
    }),
  );

  it.effect("restarts Pican when Cloudflare still reports its completed process record", () =>
    Effect.gen(function* () {
      let starts = 0;
      let staleReadinessChecks = 0;
      const completed = processCapabilities({
        status: "completed",
        waitForPort: () => {
          staleReadinessChecks += 1;
          return Promise.resolve();
        },
      });

      yield* withPican(
        { containerFetch: () => Promise.resolve(new Response()) },
        launchPican(SESSION_ID),
        {
          getProcess: () => Promise.resolve(completed),
          startProcess: () => {
            starts += 1;
            return Promise.resolve(
              processCapabilities({
                waitForPort: () =>
                  Promise.reject(new Error("process-bound readiness must not be used")),
              }),
            );
          },
        },
      );

      assert.strictEqual(starts, 1);
      assert.strictEqual(staleReadinessChecks, 0);
    }),
  );

  it.effect("performs one idempotent hosted creation request and classifies Pican states", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly response: Response;
        readonly expected: PicanCreateResult["state"];
      }> = [
        {
          response: createResponse("created", "accepted"),
          expected: "stable",
        },
        {
          response: createResponse("creating", "dispatching", 202),
          expected: "pending",
        },
        {
          response: createResponse("unknown", "unknown", 503),
          expected: "unknown",
        },
        {
          response: new Response("conflict", { status: 409 }),
          expected: "conflict",
        },
        {
          response: new Response('{"unexpected":true}', { status: 422 }),
          expected: "invalid",
        },
        {
          response: createResponse("created", "accepted", 202),
          expected: "invalid",
        },
      ];

      for (const testCase of cases) {
        const forwarded: Request[] = [];
        const result = yield* withPican(
          {
            containerFetch: (request) => {
              forwarded.push(request);
              return Promise.resolve(testCase.response);
            },
          },
          createHostedSession(SESSION_ID, "Investigate once"),
        );

        assert.strictEqual(result.state, testCase.expected);
        assert.strictEqual(forwarded.length, 1);
        assert.strictEqual(
          forwarded[0]?.url,
          `http://pican.internal/s/${SESSION_ID}/api/new-session`,
        );
        assert.strictEqual(forwarded[0]?.headers.get("idempotency-key"), SESSION_ID);
        assert.strictEqual(
          yield* Effect.promise(() => forwarded[0]?.text() ?? Promise.resolve("")),
          JSON.stringify({
            path: `/workspace/${SESSION_ID}`,
            runtime: "codex",
            initialPrompt: "Investigate once",
          }),
        );
      }
    }),
  );

  it.effect("stops idempotently and escalates only after the bounded graceful wait fails", () =>
    Effect.gen(function* () {
      const signals: Array<string | undefined> = [];
      let lookups = 0;
      const process = processCapabilities({
        kill: (signal) => {
          signals.push(signal);
          return Promise.resolve();
        },
        waitForExit: () =>
          signals.at(-1) === "SIGTERM"
            ? Promise.reject(new Error("timeout with credential-shaped detail"))
            : Promise.resolve({ exitCode: 137 }),
      });

      yield* withPican({ containerFetch: () => Promise.resolve(new Response()) }, stopPican(), {
        getProcess: () => {
          lookups += 1;
          return Promise.resolve(process);
        },
      });

      assert.strictEqual(lookups, 2);
      assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
    }),
  );
});

function createResponse(
  createState: "created" | "creating" | "unknown",
  promptDispatchState: "accepted" | "dispatching" | "not_requested" | "unknown",
  status = 200,
): Response {
  return Response.json(
    {
      id: "pican-session",
      nativeId: "codex-thread",
      runtime: "codex",
      createState,
      promptDispatchState,
    },
    { status },
  );
}
