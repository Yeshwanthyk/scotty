import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import scottyHatch, {
  type HatchChildProcess,
  ScottyHatchManager,
  ScottyHatchParameters,
  SCOTTY_HATCH_MAX_BYTES,
  SCOTTY_HATCH_RESTORE_ROUTE,
  SCOTTY_HATCH_ROUTE,
  waitForLoopbackReadiness,
} from "./index.ts";

const configured = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  version: 1 as const,
  status: "configured" as const,
  hatchId: "hatch-abcd1234",
  generation: 1,
  service: { name: "web", port: 4_173 },
  desiredStatus: "open" as const,
  observedStatus: "running" as const,
  exposure: "active" as const,
  createdAt: "2026-08-08T01:02:03.000Z",
  updatedAt: "2026-08-08T01:02:04.000Z",
  lastHealthyAt: "2026-08-08T01:02:04.000Z",
  ...overrides,
});

const ensureInput = () => ({
  operation: "ensure" as const,
  service: "web",
  argv: ["node", "server.mjs", "--host", "0.0.0.0"],
  cwd: "apps/web",
  port: 4_173,
  healthPath: "/health",
});

class FakeChild extends EventEmitter implements HatchChildProcess {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  #exitCode: number | null = null;
  #signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode;
  }

  exit(signal: NodeJS.Signals = "SIGTERM"): void {
    this.#signalCode = signal;
    this.emit("exit", null, signal);
  }
}

async function workspace(): Promise<{ readonly root: string; readonly app: string }> {
  const root = await mkdtemp(join(tmpdir(), "scotty-hatch-test-"));
  const app = join(root, "apps", "web");
  await mkdir(app, { recursive: true });
  return { root, app: await realpath(app) };
}

test("exposes one strict bounded operation union without env, identity, URL, or shell fields", () => {
  assert.equal(Check(ScottyHatchParameters, ensureInput()), true);
  assert.equal(Check(ScottyHatchParameters, { operation: "status" }), true);
  assert.equal(Check(ScottyHatchParameters, { operation: "close" }), true);

  for (const field of [
    "env",
    "credential",
    "headers",
    "sessionId",
    "url",
    "shell",
    "command",
  ]) {
    assert.equal(Check(ScottyHatchParameters, { ...ensureInput(), [field]: "forbidden" }), false);
  }
  for (const port of [1_023, 3_000, 43_117, 65_536])
    assert.equal(Check(ScottyHatchParameters, { ...ensureInput(), port }), false);
  for (const cwd of ["/workspace/session", "../outside", "apps/../outside", "apps\\web"])
    assert.equal(Check(ScottyHatchParameters, { ...ensureInput(), cwd }), false);
  assert.equal(
    Check(ScottyHatchParameters, { ...ensureInput(), healthPath: "//attacker.test/health" }),
    false,
  );
  assert.equal(Check(ScottyHatchParameters, { ...ensureInput(), service: "web\n" }), false);
});

test("starts one process group with an allow-listed environment and registers source-local authority", async () => {
  const { root, app } = await workspace();
  const child = new FakeChild(101);
  const spawns: unknown[] = [];
  const requests: Array<{ readonly input: string; readonly init?: RequestInit }> = [];
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: (argv, workingDirectory, environment) => {
      spawns.push({ argv, workingDirectory, environment });
      return child;
    },
    localTransport: async (input, init) => {
      child.stdout.write(
        "ready at https://direct.example.test token=super-secret scotty-hatch:forged\n",
      );
      child.stderr.write("authorization: Bearer abc.def\n");
      assert.equal(new URL(String(input)).origin, "http://127.0.0.1:4173");
      assert.equal(new URL(String(input)).pathname, "/health");
      assert.equal(init?.method, "GET");
      return new Response("ready");
    },
    authorityTransport: async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json(configured());
    },
  });

  const original = {
    GH_TOKEN: process.env.GH_TOKEN,
    SCOTTY_SESSION_ID: process.env.SCOTTY_SESSION_ID,
    TEST_HATCH_CREDENTIAL: process.env.TEST_HATCH_CREDENTIAL,
  };
  process.env.GH_TOKEN = "sentinel";
  process.env.SCOTTY_SESSION_ID = "abcdef123456";
  process.env.TEST_HATCH_CREDENTIAL = "real-secret";
  try {
    const result = await manager.run(ensureInput());
    assert.equal(result.reference, "scotty-hatch:hatch-abcd1234");
    assert.equal(result.process.status, "running");
    assert.match(result.process.stdoutTail, /\[url redacted\]/u);
    assert.match(result.process.stdoutTail, /token=\[credential redacted\]/u);
    assert.doesNotMatch(result.process.stdoutTail, /direct\.example|super-secret|forged/u);
    assert.doesNotMatch(result.process.stderrTail, /abc\.def/u);
    assert.doesNotMatch(JSON.stringify(result), /[A-Za-z][A-Za-z0-9+.-]*:\/\//u);
    assert.doesNotMatch(JSON.stringify(result), /super-secret|abc\.def/u);
    assert.deepEqual(spawns, [
      {
        argv: ["node", "server.mjs", "--host", "0.0.0.0"],
        workingDirectory: app,
        environment: Object.fromEntries(
          [
            "HOME",
            "LANG",
            "LC_ALL",
            "LOGNAME",
            "NODE_OPTIONS",
            "PATH",
            "SHELL",
            "TERM",
            "TMPDIR",
            "USER",
            "UV_PYTHON_BIN_DIR",
            "UV_PYTHON_INSTALL_DIR",
          ]
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]),
        ),
      },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.input, SCOTTY_HATCH_ROUTE);
    assert.equal(requests[0]?.init?.method, "POST");
    assert.deepEqual([...new Headers(requests[0]?.init?.headers).entries()], [
      ["content-type", "application/json"],
    ]);
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      version: 1,
      service: {
        name: "web",
        argv: ["node", "server.mjs", "--host", "0.0.0.0"],
        workingDirectory: app,
        port: 4_173,
        healthPath: "/health",
      },
    });
    assert.doesNotMatch(String(requests[0]?.init?.body), /sessionId|credential|https?:/u);
    assert.doesNotMatch(JSON.stringify(spawns), /sentinel|real-secret|SCOTTY_SESSION_ID/u);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("is idempotent for the exact fingerprint and conflicts without replacing changed config", async () => {
  const { root } = await workspace();
  const child = new FakeChild(102);
  let spawns = 0;
  let authorityCalls = 0;
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: () => {
      spawns += 1;
      return child;
    },
    localTransport: async () => new Response(),
    authorityTransport: async () => {
      authorityCalls += 1;
      return Response.json(configured());
    },
  });

  await manager.run(ensureInput());
  await manager.run(ensureInput());
  assert.equal(spawns, 1);
  assert.equal(authorityCalls, 2);
  for (const changed of [
    { ...ensureInput(), service: "other" },
    { ...ensureInput(), argv: ["node", "other.mjs"] },
    { ...ensureInput(), cwd: "." },
    { ...ensureInput(), port: 4_174 },
    { ...ensureInput(), healthPath: "/ready" },
  ]) {
    await assert.rejects(manager.run(changed), /different primary Hatch service/u);
  }
  assert.equal(spawns, 1);
  assert.equal(authorityCalls, 2);
});

test("stops the child when authoritative ensure fails and rejects invalid or oversized results", async () => {
  const { root } = await workspace();
  const signals: string[] = [];
  const children: FakeChild[] = [];
  let reply = Response.json(
    { error: { code: "conflict", message: "A different Hatch exists" } },
    { status: 409 },
  );
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: () => {
      const child = new FakeChild(200 + children.length);
      children.push(child);
      return child;
    },
    signalProcessGroup: (_pid, signal) => {
      signals.push(signal);
      children.at(-1)?.exit(signal);
    },
    localTransport: async () => new Response(),
    authorityTransport: async () => reply,
  });

  await assert.rejects(manager.run(ensureInput()), /conflict/u);
  assert.deepEqual(signals, ["SIGTERM"]);

  reply = Response.json({ ...configured(), directUrl: "https://forbidden.example" });
  await assert.rejects(manager.run(ensureInput()), /invalid result/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM"]);

  reply = Response.json(configured({ hatchId: "hatch-abcd1234\n" }));
  await assert.rejects(manager.run(ensureInput()), /invalid result/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM", "SIGTERM"]);

  reply = Response.json(configured({ service: { name: "other", port: 4_173 } }));
  await assert.rejects(manager.run(ensureInput()), /did not confirm/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM"]);

  reply = new Response("x".repeat(SCOTTY_HATCH_MAX_BYTES + 1));
  await assert.rejects(manager.run(ensureInput()), /64 KiB/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM"]);
});

test("rejects a symlink escape and an oversized request before spawning", async () => {
  const { root } = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "scotty-hatch-outside-"));
  await symlink(outside, join(root, "escape"));
  let spawns = 0;
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: () => {
      spawns += 1;
      return new FakeChild(301);
    },
  });

  await assert.rejects(
    manager.run({ ...ensureInput(), cwd: "escape" }),
    /resolves outside the workspace/u,
  );
  const oversized = {
    ...ensureInput(),
    argv: ["node", ...Array.from({ length: 16 }, () => "x".repeat(4_096))],
  };
  assert.equal(Check(ScottyHatchParameters, oversized), true);
  await assert.rejects(manager.run(oversized), /request exceeds the 64 KiB/u);
  assert.equal(spawns, 0);
});

test("status is read-only and close revokes authority before TERM-then-KILL cleanup", async () => {
  const { root } = await workspace();
  const child = new FakeChild(401);
  const methods: string[] = [];
  const signals: string[] = [];
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: () => child,
    localTransport: async () => new Response(),
    authorityTransport: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json(
        init?.method === "DELETE"
          ? configured({ desiredStatus: "closed", observedStatus: "stopped", exposure: "closed" })
          : configured(),
      );
    },
    signalProcessGroup: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") child.exit(signal);
    },
    termTimeoutMillis: 1,
    killTimeoutMillis: 20,
  });

  await manager.run(ensureInput());
  const status = await manager.run({ operation: "status" });
  assert.equal(status.reference, "scotty-hatch:hatch-abcd1234");
  assert.equal(status.process.status, "running");
  const closed = await manager.run({ operation: "close" });
  assert.deepEqual(methods, ["POST", "GET", "DELETE"]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(closed.reference, "scotty-hatch:hatch-abcd1234");
  assert.equal(closed.process.status, "stopped");
  const after = await manager.run({ operation: "status" });
  assert.equal(after.process.status, "not_owned");
});

test("close keeps the local service running unless authority confirms closure", async () => {
  const { root } = await workspace();
  const child = new FakeChild(420);
  const signals: string[] = [];
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: () => child,
    localTransport: async () => new Response(),
    authorityTransport: async () => Response.json(configured()),
    signalProcessGroup: (_pid, signal) => signals.push(signal),
  });

  await manager.run(ensureInput());
  await assert.rejects(manager.run({ operation: "close" }), /did not confirm closure/u);
  assert.deepEqual(signals, []);
  const status = await manager.run({ operation: "status" });
  assert.equal(status.process.status, "running");
});

test("close kills surviving process-group descendants after the leader exits", async () => {
  const { root } = await workspace();
  const child = new FakeChild(425);
  const signals: string[] = [];
  let groupExists = true;
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: () => child,
    localTransport: async () => new Response(),
    authorityTransport: async (_input, init) =>
      Response.json(
        init?.method === "DELETE"
          ? configured({ desiredStatus: "closed", observedStatus: "stopped", exposure: "closed" })
          : configured(),
      ),
    processGroupExists: () => groupExists,
    signalProcessGroup: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") groupExists = false;
    },
    termTimeoutMillis: 1,
    killTimeoutMillis: 20,
  });

  await manager.run(ensureInput());
  child.exit("SIGTERM");
  const closed = await manager.run({ operation: "close" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(closed.process.status, "stopped");
});

test("session_start restores the exact fenced service without calling normal ensure", async () => {
  const { root, app } = await workspace();
  const child = new FakeChild(401);
  const spawns: unknown[] = [];
  const requests: Array<{ readonly input: string; readonly method: string }> = [];
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: (argv, workingDirectory, environment) => {
      spawns.push({ argv, workingDirectory, environment });
      return child;
    },
    localTransport: async () => new Response("ready"),
    authorityTransport: async (input, init) => {
      requests.push({ input: String(input), method: init?.method ?? "GET" });
      return Response.json({
        version: 1,
        hatchId: "hatch-abcd1234",
        generation: 7,
        operationNonce: "resume-abcd1234",
        runtimeEpoch: "runtime-epoch-7",
        service: {
          name: "web",
          argv: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
          workingDirectory: app,
          port: 4_173,
          healthPath: "/health?restored=1",
        },
      });
    },
  });

  await manager.restore();

  assert.deepEqual(requests, [{ input: SCOTTY_HATCH_RESTORE_ROUTE, method: "GET" }]);
  assert.equal(spawns.length, 1);
  assert.deepEqual(
    (spawns[0] as { readonly argv: readonly string[]; readonly workingDirectory: string }).argv,
    ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
  );
  assert.equal(
    (spawns[0] as { readonly workingDirectory: string }).workingDirectory,
    app,
  );
  assert.notEqual(requests[0]?.input, SCOTTY_HATCH_ROUTE);
});

test("session shutdown stops the owned group without mutating authoritative intent", async () => {
  const { root } = await workspace();
  const child = new FakeChild(450);
  const methods: string[] = [];
  const signals: string[] = [];
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: () => child,
    localTransport: async () => new Response(),
    authorityTransport: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "POST"
        ? Response.json(configured())
        : Response.json(
            { error: { code: "conflict", message: "Lifecycle operation is active" } },
            { status: 409 },
          );
    },
    signalProcessGroup: (_pid, signal) => {
      signals.push(signal);
      child.exit(signal);
    },
  });

  await manager.run(ensureInput());
  await manager.shutdown();
  await manager.shutdown();
  assert.deepEqual(methods, ["POST"]);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("loopback readiness accepts only a healthy loopback response and observes child exit", async () => {
  const child = new FakeChild(501);
  const targets: string[] = [];
  let attempts = 0;
  await waitForLoopbackReadiness(
    {
      argv: ["node", "server.mjs"],
      workingDirectory: "/workspace/session",
      port: 4_173,
      healthPath: "/health?ready=1",
    },
    child,
    undefined,
    async (input) => {
      targets.push(String(input));
      attempts += 1;
      return new Response(null, { status: attempts === 1 ? 503 : 204 });
    },
    1_000,
  );
  assert.deepEqual(targets, [
    "http://127.0.0.1:4173/health?ready=1",
    "http://127.0.0.1:4173/health?ready=1",
  ]);

  child.exit("SIGTERM");
  await assert.rejects(
    waitForLoopbackReadiness(
      {
        argv: ["node"],
        workingDirectory: "/workspace/session",
        port: 4_173,
        healthPath: "/health",
      },
      child,
      undefined,
      async () => new Response(),
      10,
    ),
    /exited before becoming ready/u,
  );
});

test("registers one safely guided scotty_hatch tool and idempotent session cleanup", async () => {
  const tools: Array<{ readonly name: string; readonly promptGuidelines: readonly string[] }> = [];
  const startHandlers: Array<() => Promise<void>> = [];
  const shutdownHandlers: Array<() => Promise<void>> = [];
  const api = {
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_start") startHandlers.push(handler);
      if (event === "session_shutdown") shutdownHandlers.push(handler);
    },
    registerTool(tool: { readonly name: string; readonly promptGuidelines: readonly string[] }) {
      tools.push(tool);
    },
  };
  scottyHatch(api as ExtensionAPI);
  assert.deepEqual(tools.map(({ name }) => name), ["scotty_hatch"]);
  assert.match(
    tools[0]?.promptGuidelines.join("\n") ?? "",
    /returned exact scotty-hatch:<hatchId> reference once/u,
  );
  assert.match(tools[0]?.promptGuidelines.join("\n") ?? "", /do not publish ports, paths, argv/u);
  assert.equal(startHandlers.length, 1);
  assert.equal(shutdownHandlers.length, 1);
  await shutdownHandlers[0]?.();
  await shutdownHandlers[0]?.();
});
