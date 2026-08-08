import { assert, describe, it } from "@effect/vitest";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { ContainerProxy as SandboxContainerProxy } from "@cloudflare/sandbox";
import { vi } from "vitest";
import { commandIntentDigest, decodePiConsoleCommandV1Promise } from "../../protocol/pi-console";
import type { Bindings } from "../src/bindings";
import {
  ContainerProxy,
  SCOTTY_EVIDENCE_JOB_ROUTE,
  SCOTTY_HATCH_MAX_PROTOCOL_BYTES,
  SCOTTY_HATCH_ROUTE,
  SCOTTY_INTERNAL_HOST,
} from "../src/container-session-egress";
import { EVIDENCE_TOOL_MAX_PROTOCOL_BYTES } from "../src/evidence-contracts";
import { ScottyError } from "../src/contracts";
import { ALLOWED_HOSTS, makeOutboundByHost } from "../src/egress";
import { createSessionHarness, SESSION_ID, sessionHarnessKeys } from "./session-harness";
import { makeSessionRecord } from "./support";

const TARGET_ID = "b0b1c2d3e4f5";
const SOURCE_CONTAINER_ID = "a".repeat(64);

const evidenceJob = () => ({
  version: 1 as const,
  port: 4_173,
  viewport: { width: 1_280, height: 720 },
  steps: [
    {
      name: "Open home",
      action: { kind: "goto" as const, path: "/" },
      expect: [{ kind: "visible" as const, locator: { kind: "testId" as const, value: "home" } }],
    },
  ],
  capture: { screenshots: "after-each-step" as const, replay: true },
});

const evidenceResult = () => ({
  version: 1 as const,
  jobId: "job-abcd1234",
  status: "succeeded" as const,
  summaryUrl: `/s/${SESSION_ID}/evidence/job-abcd1234`,
  completedSteps: 1,
  frameCount: 1,
});

const evidenceRequest = (
  body: unknown = evidenceJob(),
  headers: Readonly<Record<string, string>> = {},
) =>
  new Request(`https://${SCOTTY_INTERNAL_HOST}${SCOTTY_EVIDENCE_JOB_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const hatchService = () => ({
  name: "web",
  argv: ["node", "server.mjs", "--host", "0.0.0.0"] as const,
  workingDirectory: `/workspace/${SESSION_ID}/apps/web`,
  port: 4_173,
  healthPath: "/health",
});

const hatchStatus = (closed = false) => ({
  version: 1 as const,
  status: "configured" as const,
  hatchId: "hatch-abcd1234",
  generation: 1,
  service: { name: "web", port: 4_173 },
  desiredStatus: closed ? ("closed" as const) : ("open" as const),
  observedStatus: closed ? ("stopped" as const) : ("running" as const),
  exposure: closed ? ("closed" as const) : ("active" as const),
  createdAt: "2026-08-08T01:02:03.000Z",
  updatedAt: "2026-08-08T01:02:04.000Z",
  ...(closed ? {} : { lastHealthyAt: "2026-08-08T01:02:04.000Z" }),
});

const hatchRequest = (
  method: "GET" | "POST" | "DELETE",
  body: unknown = { version: 1, service: hatchService() },
  headers: Readonly<Record<string, string>> = {},
) =>
  new Request(`https://${SCOTTY_INTERNAL_HOST}${SCOTTY_HATCH_ROUTE}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json", ...headers } : headers,
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });

const snapshot = () => ({
  version: 1 as const,
  epoch: "epoch-1",
  baseSequence: 0,
  sequence: 0,
  sessionRevision: 0,
  state: { isStreaming: false },
  messages: [],
  overlapEvents: [],
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
  pendingUiAuthority: {
    status: "partial" as const,
    reason: "pi_0_83_signal_cancellation_unobservable" as const,
  },
  extensionSurface: { statuses: {}, widgets: [] },
  capabilities: { models: [], thinkingLevels: [], commands: [] },
  truncated: { messages: false, values: false },
});

interface NamedDurableObjectId extends DurableObjectId {
  readonly name: string;
}

function durableObjectId(name: string): NamedDurableObjectId {
  return {
    name,
    toString: () => name,
    equals: (other) => other.toString() === name,
  };
}

function sandboxNamespace(options: {
  readonly fromName?: (name: string) => object;
  readonly fromString?: (id: string) => object;
  readonly onName?: (name: string) => void;
  readonly onString?: (id: string) => void;
}): Bindings["SANDBOX"] {
  return {
    idFromName: (name) => {
      options.onName?.(name);
      return durableObjectId(name);
    },
    idFromString: (id) => {
      options.onString?.(id);
      return durableObjectId(id);
    },
    get: (id) => {
      const named = id as NamedDurableObjectId;
      const resolved =
        named.name === SOURCE_CONTAINER_ID
          ? (options.fromString?.(named.name) ?? options.fromName?.(named.name))
          : (options.fromName?.(named.name) ?? options.fromString?.(named.name));
      return resolved as never;
    },
    getByName: (name) => (options.fromName?.(name) ?? options.fromString?.(name)) as never,
    newUniqueId: () => durableObjectId("unique"),
    jurisdiction: () => sandboxNamespace(options),
  } as Bindings["SANDBOX"];
}

function bindings(namespace: Bindings["SANDBOX"]): Bindings {
  return {
    AUTH: undefined as never,
    RUNNER_REGISTRY: undefined as never,
    RUNNERS: undefined as never,
    SANDBOX: namespace,
    SESSIONS: undefined as never,
    BACKUP_BUCKET: undefined as never,
    ARTIFACT_BUCKET: undefined as never,
    BROWSER: undefined as never,
    ASSETS: undefined as never,
    SCOTTY_TOKEN: "unused",
    PI_AUTH_JSON: "unused",
    GH_TOKEN: "unused",
  };
}

const context = (containerId = SOURCE_CONTAINER_ID): OutboundHandlerContext<unknown> => ({
  containerId,
  // @cloudflare/containers passes the TypeScript constructor name, not the deployed binding name.
  className: "Sandbox",
});

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

describe("container-only session egress", () => {
  it("maps the exact reserved host to the source selected only by context.containerId", async () => {
    let nativeFetchCalls = 0;
    const operations: unknown[] = [];
    const selectedContainerIds: string[] = [];
    const source = {
      containerSessionRequest: async (operation: unknown) => {
        operations.push(operation);
        return Response.json(snapshot());
      },
    };
    const namespace = sandboxNamespace({
      fromString: () => source,
      onString: (id) => selectedContainerIds.push(id),
    });
    const handlers = makeOutboundByHost(() => {
      nativeFetchCalls += 1;
      return Promise.resolve(new Response("native fallback"));
    });

    assert.deepStrictEqual(Object.keys(handlers), [...ALLOWED_HOSTS]);
    const handler = handlers[SCOTTY_INTERNAL_HOST];
    assert.isFunction(handler);
    const response = await handler(
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect`, {
        headers: {
          "scotty-session-id": SESSION_ID,
        },
      }),
      bindings(namespace),
      context(),
    );

    assert.strictEqual(response.status, 401);
    assert.deepStrictEqual(selectedContainerIds, []);
    assert.deepStrictEqual(operations, []);
    assert.strictEqual(nativeFetchCalls, 0);

    const accepted = await handler(
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect`),
      bindings(namespace),
      context(),
    );
    assert.strictEqual(accepted.status, 200);
    assert.deepStrictEqual(selectedContainerIds, [SOURCE_CONTAINER_ID]);
    assert.deepStrictEqual(operations, [{ version: 1, action: "inspect", targetId: TARGET_ID }]);
    assert.strictEqual(nativeFetchCalls, 0);
  });

  it("dispatches evidence with the SDK runtime class in the exported proxy", async () => {
    const jobs: unknown[] = [];
    const source = {
      runScottyEvidenceJob: async (job: unknown) => {
        jobs.push(job);
        return evidenceResult();
      },
    };
    const env = bindings(sandboxNamespace({ fromString: () => source }));
    const proxy: ContainerProxy = Object.create(ContainerProxy.prototype);
    Reflect.set(proxy, "env", env);
    Reflect.set(proxy, "ctx", {
      props: { containerId: SOURCE_CONTAINER_ID, className: "Sandbox" },
    });
    const fallback = vi.spyOn(SandboxContainerProxy.prototype, "fetch");

    const response = await proxy.fetch(evidenceRequest());

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(jobs, [evidenceJob()]);
    assert.strictEqual(fallback.mock.calls.length, 0);
    fallback.mockRestore();
  });

  it("routes bounded Hatch status, ensure, and close only to source-derived authority", async () => {
    const operations: unknown[] = [];
    const selectedContainerIds: string[] = [];
    const source = {
      getScottyHatchStatus: async () => {
        operations.push({ operation: "status" });
        return hatchStatus();
      },
      ensureScottyHatch: async (input: unknown) => {
        operations.push({ operation: "ensure", input });
        return hatchStatus();
      },
      closeScottyHatch: async () => {
        operations.push({ operation: "close" });
        return hatchStatus(true);
      },
    };
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);
    const env = bindings(
      sandboxNamespace({
        fromString: () => source,
        onString: (id) => selectedContainerIds.push(id),
      }),
    );

    for (const request of [hatchRequest("GET"), hatchRequest("POST"), hatchRequest("DELETE")]) {
      const response = await handler(request, env, context());
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      const result = await response.json();
      assert.notProperty(result, "url");
      assert.notProperty(result, "credential");
    }

    assert.deepStrictEqual(selectedContainerIds, [
      SOURCE_CONTAINER_ID,
      SOURCE_CONTAINER_ID,
      SOURCE_CONTAINER_ID,
    ]);
    assert.deepStrictEqual(operations, [
      { operation: "status" },
      { operation: "ensure", input: { version: 1, service: hatchService() } },
      { operation: "close" },
    ]);
  });

  it("rejects Hatch identity spoofing, malformed intent, oversized input, and unsafe source results", async () => {
    let sourceCalls = 0;
    const source = {
      getScottyHatchStatus: async () => {
        sourceCalls += 1;
        return { ...hatchStatus(), url: "https://forbidden.example" };
      },
      ensureScottyHatch: async () => {
        sourceCalls += 1;
        return hatchStatus();
      },
      closeScottyHatch: async () => {
        sourceCalls += 1;
        return hatchStatus(true);
      },
    };
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);
    const env = bindings(sandboxNamespace({ fromString: () => source }));

    for (const request of [
      hatchRequest("POST", { version: 1, service: { ...hatchService(), env: { TOKEN: "x" } } }),
      hatchRequest("POST", { version: 1, service: hatchService(), sessionId: SESSION_ID }),
      hatchRequest("POST", { version: 1, service: hatchService() }, { authorization: "Bearer x" }),
      new Request(`https://${SCOTTY_INTERNAL_HOST}${SCOTTY_HATCH_ROUTE}?session=${SESSION_ID}`),
      new Request(`https://${SCOTTY_INTERNAL_HOST}${SCOTTY_HATCH_ROUTE}`, { method: "PUT" }),
    ]) {
      const response = await handler(request, env, context());
      assert.ok(response.status === 400 || response.status === 401);
    }
    const oversized = new Request(`https://${SCOTTY_INTERNAL_HOST}${SCOTTY_HATCH_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(SCOTTY_HATCH_MAX_PROTOCOL_BYTES + 1),
    });
    assert.strictEqual((await handler(oversized, env, context())).status, 400);
    assert.strictEqual((await handler(hatchRequest("GET"), env, context(""))).status, 401);
    assert.strictEqual(
      (await handler(hatchRequest("GET"), env, { ...context(), className: "ScottySandbox" }))
        .status,
      401,
    );
    assert.strictEqual((await handler(hatchRequest("GET"), env, context())).status, 502);
    assert.strictEqual(sourceCalls, 1);
  });

  it("preserves typed Hatch conflicts and redacts unknown authority failures", async () => {
    let failure: unknown = new ScottyError("conflict", "A different primary Hatch is configured", {
      httpStatus: 409,
      exitCode: 5,
    });
    const source = {
      ensureScottyHatch: () => Promise.reject(failure),
    };
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);
    const env = bindings(sandboxNamespace({ fromString: () => source }));

    const conflict = await handler(hatchRequest("POST"), env, context());
    assert.strictEqual(conflict.status, 409);
    assert.deepStrictEqual(await conflict.json(), {
      error: {
        code: "conflict",
        message: "A different primary Hatch is configured",
      },
    });

    failure = new Error("provider honeypot credential");
    const unknown = await handler(hatchRequest("POST"), env, context());
    assert.strictEqual(unknown.status, 500);
    const body = await unknown.text();
    assert.include(body, "Scotty Hatch request failed");
    assert.notInclude(body, "honeypot");
    assert.notInclude(body, "credential");
  });

  it("fails closed for missing context and ambient credential, proxy, or spoof headers", async () => {
    let sourceCalls = 0;
    const source = {
      containerSessionRequest: async () => {
        sourceCalls += 1;
        return Response.json(snapshot());
      },
    };
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);
    const namespace = sandboxNamespace({ fromString: () => source });

    const missing = await handler(
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect`),
      bindings(namespace),
      context(""),
    );
    assert.strictEqual(missing.status, 401);

    for (const [name, value] of [
      ["authorization", "Bearer ambient"],
      ["cookie", "session=ambient"],
      ["forwarded", "for=203.0.113.10"],
      ["x-container-id", SOURCE_CONTAINER_ID],
      ["x-sandbox-name", SESSION_ID],
      ["x-scotty-session-id", SESSION_ID],
      ["x-source-session-id", SESSION_ID],
    ]) {
      const rejected = await handler(
        new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect`, {
          headers: { [name]: value },
        }),
        bindings(namespace),
        context(),
      );
      assert.strictEqual(rejected.status, 401);
      assert.strictEqual(errorCode(await rejected.json()), "auth");
    }
    assert.strictEqual(sourceCalls, 0);
  });

  it("strictly bounds the internal routes and passes only decoded target intent", async () => {
    const operations: unknown[] = [];
    const source = {
      containerSessionRequest: async (operation: unknown) => {
        operations.push(operation);
        return Response.json({ id: TARGET_ID, status: "unavailable", retryable: false });
      },
    };
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);
    const env = bindings(sandboxNamespace({ fromString: () => source }));

    for (const request of [
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect?source=x`),
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect`, {
        method: "POST",
      }),
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/steer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "continue", sourceSessionId: SESSION_ID }),
      }),
    ]) {
      const response = await handler(request, env, context());
      assert.strictEqual(response.status, 400);
    }

    const response = await handler(
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/steer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "continue" }),
      }),
      env,
      context(),
    );
    assert.strictEqual(response.status, 502);
    assert.deepStrictEqual(operations, [
      { version: 1, action: "steer", targetId: TARGET_ID, message: "continue" },
    ]);

    for (const upstream of [
      Response.json({ unexpected: true }),
      new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    ]) {
      const invalidHandler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
        SCOTTY_INTERNAL_HOST
      ];
      assert.isFunction(invalidHandler);
      const invalid = await invalidHandler(
        new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect`),
        bindings(
          sandboxNamespace({
            fromString: () => ({ containerSessionRequest: async () => upstream }),
          }),
        ),
        context(),
      );
      assert.strictEqual(invalid.status, 502);
    }
  });

  it("runs one bounded evidence job only on the source selected by actual container identity", async () => {
    const selectedContainerIds: string[] = [];
    const jobs: unknown[] = [];
    let unrelatedCalls = 0;
    const source = {
      getScottySession: async () => {
        unrelatedCalls += 1;
        return {};
      },
      runScottyEvidenceJob: async (job: unknown) => {
        jobs.push(job);
        return {
          ...evidenceResult(),
          diagnostic: {
            operation: "screenshot",
            reason: "ambiguous",
            step: 0,
            kitesurf: { operation: "screenshot", reason: "ambiguous" },
          },
        };
      },
    };
    const namespace = sandboxNamespace({
      fromString: () => source,
      onString: (id) => selectedContainerIds.push(id),
      onName: () => {
        unrelatedCalls += 1;
      },
    });
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);

    const response = await handler(evidenceRequest(), bindings(namespace), context());

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), evidenceResult());
    assert.deepStrictEqual(selectedContainerIds, [SOURCE_CONTAINER_ID]);
    assert.deepStrictEqual(jobs, [evidenceJob()]);
    assert.strictEqual(unrelatedCalls, 0);
    assert.strictEqual(response.headers.get("cache-control"), "no-store");
  });

  it("rejects evidence caller authority, missing source identity, invalid routes, and a disabled gate", async () => {
    let sourceCalls = 0;
    const source = {
      runScottyEvidenceJob: async () => {
        sourceCalls += 1;
        return evidenceResult();
      },
    };
    const namespace = sandboxNamespace({ fromString: () => source });
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);
    const env = bindings(namespace);

    const requests = [
      evidenceRequest({ ...evidenceJob(), sessionId: SESSION_ID }),
      evidenceRequest(evidenceJob(), { authorization: "Bearer ambient" }),
      evidenceRequest(evidenceJob(), { "x-scotty-session-id": SESSION_ID }),
      new Request(
        `https://${SCOTTY_INTERNAL_HOST}${SCOTTY_EVIDENCE_JOB_ROUTE}?sessionId=${SESSION_ID}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ),
      new Request(`https://${SCOTTY_INTERNAL_HOST}${SCOTTY_EVIDENCE_JOB_ROUTE}`),
    ];
    for (const request of requests) {
      const response = await handler(request, env, context());
      assert.ok(response.status === 400 || response.status === 401);
    }

    const noIdentity = await handler(evidenceRequest(), env, context(""));
    assert.strictEqual(noIdentity.status, 401);
    for (const className of ["ScottySandbox", "ContainerProxy", "CallerSelectedSandbox"]) {
      const wrongClass = await handler(evidenceRequest(), env, {
        containerId: SOURCE_CONTAINER_ID,
        className,
      });
      assert.strictEqual(wrongClass.status, 401);
      assert.strictEqual(errorCode(await wrongClass.json()), "auth");
    }
    const disabled = await handler(
      evidenceRequest(),
      { ...env, SCOTTY_BROWSER_TEST_ENABLED: "false" },
      context(),
    );
    assert.strictEqual(disabled.status, 409);
    assert.strictEqual(errorCode(await disabled.json()), "wrong_state");
    assert.strictEqual(sourceCalls, 0);
  });

  it("enforces 64 KiB request and result limits and rejects source result mismatches", async () => {
    let sourceCalls = 0;
    const namespace = sandboxNamespace({
      fromString: () => ({
        runScottyEvidenceJob: async () => {
          sourceCalls += 1;
          return {
            ...evidenceResult(),
            summaryUrl: `/s/${SESSION_ID}/evidence/${"x".repeat(EVIDENCE_TOOL_MAX_PROTOCOL_BYTES)}`,
          };
        },
      }),
    });
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);
    const env = bindings(namespace);

    const oversized = new Request(`https://${SCOTTY_INTERNAL_HOST}${SCOTTY_EVIDENCE_JOB_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(EVIDENCE_TOOL_MAX_PROTOCOL_BYTES + 1),
    });
    const oversizedResponse = await handler(oversized, env, context());
    assert.strictEqual(oversizedResponse.status, 400);
    assert.strictEqual(sourceCalls, 0);

    const resultResponse = await handler(evidenceRequest(), env, context());
    assert.strictEqual(resultResponse.status, 502);
    assert.strictEqual(errorCode(await resultResponse.json()), "upstream");
    assert.strictEqual(sourceCalls, 1);

    const mismatchNamespace = sandboxNamespace({
      fromString: () => ({
        runScottyEvidenceJob: async () => ({
          ...evidenceResult(),
          summaryUrl: `/s/${SESSION_ID}/evidence/different-job`,
        }),
      }),
    });
    const mismatched = await handler(evidenceRequest(), bindings(mismatchNamespace), context());
    assert.strictEqual(mismatched.status, 502);
  });
});

describe("source Sandbox orchestration authority", () => {
  it("requires evidence to originate from a warm running Cloudflare source", async () => {
    const records = [
      {
        record: makeSessionRecord({ status: "sleeping" }),
        rawPiContainerRunning: true,
      },
      {
        record: makeSessionRecord({
          provider: "runner",
          runner: "garage",
          execution: { provider: "runner" as const, runner: "garage", runtimeId: "runtime-1" },
        }),
        rawPiContainerRunning: true,
      },
      {
        record: makeSessionRecord(),
        rawPiContainerRunning: false,
      },
    ];

    for (const { record, rawPiContainerRunning } of records) {
      const source = await createSessionHarness({
        evidenceEnabled: true,
        initialEntries: { [sessionHarnessKeys.record]: record },
        rawPiContainerRunning,
      });
      const namespace = sandboxNamespace({ fromString: () => source.sandbox });
      const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
        SCOTTY_INTERNAL_HOST
      ];
      assert.isFunction(handler);

      const response = await handler(evidenceRequest(), bindings(namespace), context());
      assert.strictEqual(response.status, 409);
      assert.strictEqual(errorCode(await response.json()), "wrong_state");
    }
  });

  it("requires an authoritative warm Cloudflare source with no operation", async () => {
    for (const record of [
      makeSessionRecord({ status: "sleeping" }),
      makeSessionRecord({
        operation: {
          kind: "snapshot",
          nonce: "operation-1",
          startedAt: "2026-01-01T00:00:02.000Z",
        },
      }),
      makeSessionRecord({
        provider: "runner",
        runner: "garage",
        execution: { provider: "runner", runner: "garage", runtimeId: "runtime-1" },
      }),
    ]) {
      let targetSelections = 0;
      const source = await createSessionHarness({
        initialEntries: { [sessionHarnessKeys.record]: record },
        sandboxNamespace: sandboxNamespace({
          fromName: () => {
            targetSelections += 1;
            return {};
          },
        }),
      });

      const response = await source.sandbox.containerSessionRequest({
        version: 1,
        action: "inspect",
        targetId: TARGET_ID,
      });
      assert.strictEqual(response.status, 409);
      assert.strictEqual(errorCode(await response.json()), "wrong_state");
      assert.strictEqual(targetSelections, 0);
    }
  });

  it("rejects self-targeting and exact-case cross-repo targeting", async () => {
    let targetSelections = 0;
    const self = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }) },
      sandboxNamespace: sandboxNamespace({
        fromName: () => {
          targetSelections += 1;
          return {};
        },
      }),
    });
    const selfResponse = await self.sandbox.containerSessionRequest({
      version: 1,
      action: "inspect",
      targetId: SESSION_ID,
    });
    assert.strictEqual(selfResponse.status, 401);
    assert.strictEqual(targetSelections, 0);

    let relayCalls = 0;
    const target = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: TARGET_ID,
          repo: "Owner/project",
        }),
      },
      passivePiConsoleRelay: {
        fetch: async () => {
          relayCalls += 1;
          return Response.json(snapshot());
        },
      },
    });
    const source = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          repo: "owner/project",
        }),
      },
      sandboxNamespace: sandboxNamespace({ fromName: () => target.sandbox }),
    });
    const crossRepo = await source.sandbox.containerSessionRequest({
      version: 1,
      action: "inspect",
      targetId: TARGET_ID,
    });
    assert.strictEqual(crossRepo.status, 401);
    assert.strictEqual(errorCode(await crossRepo.json()), "auth");
    assert.strictEqual(relayCalls, 0);
  });

  it("delegates same-repo inspect and steer through context.containerId without credentials or wake", async () => {
    const relayed: Request[] = [];
    const target = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: TARGET_ID,
          repo: "owner/project",
        }),
      },
      passivePiConsoleRelay: {
        fetch: async ({ request }) => {
          relayed.push(request.clone());
          if (new URL(request.url).pathname.endsWith("/snapshot")) {
            const { sessionRevision: _sessionRevision, ...relaySnapshot } = snapshot();
            return Response.json(relaySnapshot);
          }
          const command = await decodePiConsoleCommandV1Promise(await request.clone().json());
          return Response.json(
            {
              version: 1,
              epoch: command.epoch,
              commandId: command.commandId,
              commandDigest: await commandIntentDigest(command.intent),
              status: "accepted",
              response: { success: true },
            },
            { status: 202 },
          );
        },
      },
    });
    let sourceStub: {
      containerSessionRequest(input: unknown): Promise<Response>;
    } = {
      containerSessionRequest: async () => Response.json({}, { status: 500 }),
    };
    const namespace = sandboxNamespace({
      fromName: () => target.sandbox,
      fromString: () => sourceStub,
    });
    const source = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          repo: "owner/project",
        }),
      },
      sandboxNamespace: namespace,
    });
    sourceStub = source.sandbox;
    const handler = makeOutboundByHost(() => Promise.resolve(new Response("native")))[
      SCOTTY_INTERNAL_HOST
    ];
    assert.isFunction(handler);

    const inspected = await handler(
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/inspect`),
      bindings(namespace),
      context(),
    );
    assert.strictEqual(inspected.status, 200);
    assert.deepStrictEqual(await inspected.json(), snapshot());

    const steered = await handler(
      new Request(`https://${SCOTTY_INTERNAL_HOST}/api/sessions/${TARGET_ID}/steer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "continue the focused tests" }),
      }),
      bindings(namespace),
      context(),
    );
    assert.strictEqual(steered.status, 200);
    const outcome = await steered.text();
    assert.include(outcome, `"id":"${TARGET_ID}"`);
    assert.include(outcome, '"status":"accepted"');
    assert.strictEqual(relayed.length, 3);
    for (const request of relayed) {
      assert.strictEqual(request.headers.get("authorization"), null);
      assert.strictEqual(request.headers.get("cookie"), null);
      assert.strictEqual(request.headers.get("x-api-key"), null);
      assert.strictEqual(request.headers.get("x-scotty-session-id"), null);
    }
    assert.isFalse(target.events.some((event) => event.startsWith("host:container:")));
    assert.deepStrictEqual(target.rawPiRequests, []);
  });

  it("fails closed when the target authority is unavailable", async () => {
    const unavailable = {
      getScottySession: () => Promise.reject(new TypeError("target unavailable")),
      fetch: () => Promise.resolve(Response.json({ unexpected: true })),
    };
    const source = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }) },
      sandboxNamespace: sandboxNamespace({ fromName: () => unavailable }),
    });

    const response = await source.sandbox.containerSessionRequest({
      version: 1,
      action: "inspect",
      targetId: TARGET_ID,
    });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(errorCode(await response.json()), "not_found");
  });
});
