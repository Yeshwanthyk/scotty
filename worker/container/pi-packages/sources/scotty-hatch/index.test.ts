import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { nativePiExtensionApi } from "../../../../test/support/native-host.ts";
import { Check } from "typebox/value";
import scottyHatch, {
  type ConfiguredStatus,
  type HatchChildProcess,
  type HatchServiceProcess,
  loadRepositoryHatchConfig,
  ScottyHatchManager as ProductionHatchManager,
  HatchFailure,
  SCOTTY_HATCH_STARTUP_ROUTE,
  type ScottyHatchManagerOptions,
  ScottyHatchParameters,
  ScottyHatchToolParameters,
  SCOTTY_HATCH_MAX_BYTES,
  SCOTTY_HATCH_RESTORE_ROUTE,
  SCOTTY_HATCH_ROUTE,
  waitForLoopbackReadiness,
} from "./index.ts";

// Startup receipts are owned by the Session; service tests use an in-memory receipt transport.
class ScottyHatchManager extends ProductionHatchManager {
  constructor(options: ScottyHatchManagerOptions = {}) {
    const authority = options.authorityTransport ?? fetch;
    super({
      ...options,
      authorityTransport: async (input, init) =>
        String(input) === SCOTTY_HATCH_STARTUP_ROUTE
          ? Response.json({ attemptId: "attempt-1", runtimeEpoch: "epoch-1" })
          : authority(input, init),
    });
  }
}

const configured = (overrides: Partial<ConfiguredStatus> = {}): ConfiguredStatus => ({
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

  succeed(): void {
    this.#exitCode = 0;
    this.emit("exit", 0, null);
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

const hatchToml = (
  overrides: Partial<Record<"service" | "argv" | "cwd" | "port" | "health_path", string>> = {},
) => `[hatch]
service = ${overrides.service ?? '"web"'}
argv = ${overrides.argv ?? '["pnpm", "exec", "vite", "dev", "--host", "0.0.0.0", "--port", "4173"]'}
cwd = ${overrides.cwd ?? '"."'}
port = ${overrides.port ?? "4173"}
health_path = ${overrides.health_path ?? '"/"'}
`;

test("exposes one strict bounded operation union without env, identity, URL, or shell fields", () => {
  assert.equal(Check(ScottyHatchParameters, ensureInput()), true);
  assert.equal(Check(ScottyHatchParameters, { operation: "ensure" }), true);
  assert.equal(Check(ScottyHatchParameters, { operation: "ensure", service: "web" }), false);
  assert.equal(Check(ScottyHatchParameters, { operation: "status" }), true);
  assert.equal(Check(ScottyHatchParameters, { operation: "close" }), true);

  for (const field of [
    "version",
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

test("loads and normalizes strict repository-root hatch.toml", async () => {
  const { root } = await workspace();
  await writeFile(join(root, "hatch.toml"), hatchToml());

  assert.deepEqual(await loadRepositoryHatchConfig(root), {
    operation: "ensure",
    service: "web",
    argv: ["pnpm", "exec", "vite", "dev", "--host", "0.0.0.0", "--port", "4173"],
    cwd: ".",
    port: 4_173,
    healthPath: "/",
  });
});

test("accepts bounded display metadata for each Hatch operation", () => {
  for (const input of [
    ensureInput(),
    { operation: "ensure" },
    { operation: "status" },
    { operation: "close" },
  ]) {
    assert.equal(
      Check(ScottyHatchToolParameters, { ...input, displayText: "Starting the invoice preview" }),
      true,
    );
    for (const displayText of [
      42,
      "",
      "x".repeat(181),
      "Trailing newline\n",
      "Unicode\u2028separator",
      "Unicode\u2029separator",
      "Starting\npreview",
    ]) {
      assert.equal(Check(ScottyHatchToolParameters, { ...input, displayText }), false);
    }
  }
});

test("rejects malformed TOML, unknown fields, unsafe cwd, and an absent config", async () => {
  const malformed = await workspace();
  await writeFile(join(malformed.root, "hatch.toml"), '[hatch\nservice = "web"\n');
  await assert.rejects(loadRepositoryHatchConfig(malformed.root), /malformed TOML/u);

  const unknown = await workspace();
  await writeFile(
    join(unknown.root, "hatch.toml"),
    `${hatchToml()}environment = { TOKEN = "no" }\n`,
  );
  await assert.rejects(loadRepositoryHatchConfig(unknown.root), /unsupported or malformed fields/u);

  const unsafe = await workspace();
  await writeFile(join(unsafe.root, "hatch.toml"), hatchToml({ cwd: '"../outside"' }));
  await assert.rejects(loadRepositoryHatchConfig(unsafe.root), /unsupported or malformed fields/u);

  const absent = await workspace();
  await assert.rejects(loadRepositoryHatchConfig(absent.root), /hatch\.toml is missing/u);

  let spawns = 0;
  let authorityCalls = 0;
  const manager = new ScottyHatchManager({
    workspaceRoot: absent.root,
    spawnProcess: () => {
      spawns += 1;
      return new FakeChild(88);
    },
    authorityTransport: async () => {
      authorityCalls += 1;
      return Response.json({ status: "not_configured" });
    },
  });
  const result = await manager.run({ operation: "ensure" });
  assert.deepEqual(result.hatch, { status: "not_configured" });
  assert.equal(result.process.status, "not_owned");
  assert.equal(spawns, 0);
  assert.equal(authorityCalls, 0);
});

test("invalid explicit and repository config publish fenced startup failures", async () => {
  const { root } = await workspace();
  const reports: unknown[] = [];
  const manager = new ProductionHatchManager({
    workspaceRoot: root,
    authorityTransport: async (input, init) => {
      assert.equal(String(input), SCOTTY_HATCH_STARTUP_ROUTE);
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ attemptId: `attempt-${reports.length}`, runtimeEpoch: "epoch-one" });
    },
  });
  await assert.rejects(manager.run({ ...ensureInput(), port: 3_000 }), {
    code: "invalid_config",
  });
  assert.deepEqual(reports, [
    { operation: "begin" },
    {
      operation: "finish",
      attemptId: "attempt-1",
      runtimeEpoch: "epoch-one",
      failureCode: "invalid_config",
    },
  ]);
  assert.deepEqual((await manager.run({ operation: "ensure" })).hatch, {
    status: "not_configured",
  });
  assert.equal(reports.length, 2);
  await writeFile(join(root, "hatch.toml"), '[hatch\nservice = "web"\n');
  await assert.rejects(manager.run({ operation: "ensure" }), { code: "invalid_config" });
  assert.deepEqual(reports.slice(2), [
    { operation: "begin" },
    {
      operation: "finish",
      attemptId: "attempt-3",
      runtimeEpoch: "epoch-one",
      failureCode: "invalid_config",
    },
  ]);
});

test("complete explicit ensure input overrides repository config", async () => {
  const { root } = await workspace();
  await writeFile(join(root, "hatch.toml"), "not valid TOML = [");
  const child = new FakeChild(99);
  const spawns: Array<readonly string[]> = [];
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: (argv) => {
      spawns.push(argv);
      return child;
    },
    localTransport: async () => new Response(),
    authorityTransport: async () => Response.json(configured()),
  });

  await manager.run(ensureInput());
  assert.deepEqual(spawns, [["node", "server.mjs", "--host", "0.0.0.0"]]);
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
    SCOTTY_SESSION_ID: process.env.SCOTTY_SESSION_ID,
    TEST_HATCH_CREDENTIAL: process.env.TEST_HATCH_CREDENTIAL,
  };
  process.env.SCOTTY_SESSION_ID = "abcdef123456";
  process.env.TEST_HATCH_CREDENTIAL = "real-secret";
  try {
    const result = await manager.run({
      ...ensureInput(),
      displayText: "Starting the invoice preview",
    });
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
    assert.deepEqual(
      [...new Headers(requests[0]?.init?.headers).entries()],
      [["content-type", "application/json"]],
    );
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      service: {
        name: "web",
        argv: ["node", "server.mjs", "--host", "0.0.0.0"],
        workingDirectory: app,
        port: 4_173,
        healthPath: "/health",
      },
    });
    assert.doesNotMatch(String(requests[0]?.init?.body), /sessionId|credential|https?:/u);
    assert.doesNotMatch(JSON.stringify(spawns), /real-secret|SCOTTY_SESSION_ID/u);
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

test("stops rejected registration but retains local ownership when registration is unconfirmed", async () => {
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
  await assert.rejects(
    manager.run(ensureInput()),
    (error) => error instanceof HatchFailure && error.code === "registration_unconfirmed",
  );
  assert.deepEqual(signals, ["SIGTERM"]);

  reply = Response.json(configured({ hatchId: "hatch-abcd1234\n" }));
  await assert.rejects(
    manager.run(ensureInput()),
    (error) => error instanceof HatchFailure && error.code === "registration_unconfirmed",
  );
  assert.deepEqual(signals, ["SIGTERM"]);

  reply = Response.json(configured({ service: { name: "other", port: 4_173 } }));
  await assert.rejects(manager.run(ensureInput()), /did not confirm/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM"]);

  reply = new Response("x".repeat(SCOTTY_HATCH_MAX_BYTES + 1));
  await assert.rejects(
    manager.run(ensureInput()),
    (error) => error instanceof HatchFailure && error.code === "registration_unconfirmed",
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM"]);
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

  await writeFile(join(root, "hatch.toml"), hatchToml({ cwd: '"escape"' }));
  await assert.rejects(manager.run({ operation: "ensure" }), /resolves outside the workspace/u);
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

test("prepares once before initial start, reports fenced startup, and skips preparation on idempotent ensure", async () => {
  const { root } = await workspace();
  const spawned: string[] = [];
  const reports: unknown[] = [];
  const manager = new ProductionHatchManager({
    workspaceRoot: root,
    spawnProcess: (argv) => {
      spawned.push(argv[0]);
      const child = new FakeChild(600 + spawned.length);
      if (argv[0] === "prepare") queueMicrotask(() => child.succeed());
      return child;
    },
    localTransport: async () => new Response(),
    authorityTransport: async (input, init) => {
      if (String(input) === SCOTTY_HATCH_STARTUP_ROUTE) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json({ attemptId: "attempt-1", runtimeEpoch: "epoch-1" });
      }
      return Response.json(configured());
    },
  });
  const input = { ...ensureInput(), prepare: { argv: ["prepare"], timeout_seconds: 1 } };
  await manager.run(input);
  await manager.run(input);
  assert.deepEqual(spawned, ["prepare", "node"]);
  assert.deepEqual(reports, [
    { operation: "begin" },
    { operation: "finish", attemptId: "attempt-1", runtimeEpoch: "epoch-1" },
    { operation: "begin" },
    { operation: "finish", attemptId: "attempt-1", runtimeEpoch: "epoch-1" },
  ]);
});

test("repository Hatch config builds a service, reaches real loopback health, and stops it", async () => {
  const { root } = await workspace();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const source = `import { createServer } from "node:http";
createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404);
  response.end(request.url === "/health" ? "SCOTTY_HATCH_READY" : "missing");
}).listen(Number(process.argv[2]), "127.0.0.1");\n`;
  await writeFile(join(root, "server.ts"), source);
  await writeFile(
    join(root, "hatch.toml"),
    `[hatch]\nservice = "web"\nargv = ["node", "server.mjs", "${port}"]\ncwd = "."\nport = ${port}\nhealth_path = "/health"\nready_timeout_seconds = 5\n\n[hatch.prepare]\nargv = ["bun", "build", "server.ts", "--target=node", "--outfile=server.mjs"]\ntimeout_seconds = 30\n`,
  );
  const reports: unknown[] = [];
  const manager = new ProductionHatchManager({
    workspaceRoot: root,
    authorityTransport: async (input, init) => {
      if (String(input) === SCOTTY_HATCH_STARTUP_ROUTE) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json({ attemptId: "attempt-live", runtimeEpoch: "epoch-live" });
      }
      return Response.json(configured({ service: { name: "web", port } }));
    },
  });
  try {
    const first = await manager.run({ operation: "ensure" });
    assert.equal(first.process.status, "running");
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}/health`)).text(),
      "SCOTTY_HATCH_READY",
    );
    await writeFile(join(root, "server.ts"), "this is deliberately invalid TypeScript");
    const second = await manager.run({ operation: "ensure" });
    assert.equal(second.process.status, "running");
    assert.equal(reports.length, 4);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});

test("Hatch preparation inherits a readable CA for strict Node TLS without exposing ambient secrets", async () => {
  const { root } = await workspace();
  const certificate = join(root, "ca.pem");
  const key = join(root, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: "ignore" },
  );
  const secure = createHttpsServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (_request, response) => response.end("TRUSTED_CA"),
  );
  await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
  const secureAddress = secure.address();
  assert.ok(secureAddress && typeof secureAddress !== "string");
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const serviceAddress = reservation.address();
  assert.ok(serviceAddress && typeof serviceAddress !== "string");
  await new Promise<void>((resolve) => reservation.close(resolve));
  const port = serviceAddress.port;
  await writeFile(
    join(root, "prepare.mjs"),
    `
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS verification disabled");
const response = await fetch("https://127.0.0.1:${secureAddress.port}/");
if (!response.ok || await response.text() !== "TRUSTED_CA") throw new Error("CA was not trusted");
`,
  );
  await writeFile(
    join(root, "server.mjs"),
    `
import { createServer } from "node:http";
createServer((_request, response) => response.end("READY")).listen(${port}, "127.0.0.1");
`,
  );
  const withoutCa = await new Promise<{ error: Error | null; stderr: string }>((resolve) =>
    execFile(
      "node",
      ["prepare.mjs"],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        timeout: 10_000,
      },
      (error, _stdout, stderr) => resolve({ error, stderr }),
    ),
  );
  assert.ok(withoutCa.error);
  assert.match(withoutCa.stderr, /SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT/);
  const priorCa = process.env.NODE_EXTRA_CA_CERTS;
  const priorCorepack = process.env.COREPACK_HOME;
  const priorSecret = process.env.TEST_HATCH_CREDENTIAL;
  process.env.NODE_EXTRA_CA_CERTS = certificate;
  process.env.COREPACK_HOME = "/opt/corepack";
  process.env.TEST_HATCH_CREDENTIAL = "must-not-cross";
  const environments: NodeJS.ProcessEnv[] = [];
  const manager = new ProductionHatchManager({
    workspaceRoot: root,
    spawnProcess: (argv, cwd, environment) => {
      environments.push(environment);
      return spawn(argv[0], argv.slice(1), {
        cwd,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    authorityTransport: async (input) =>
      String(input) === SCOTTY_HATCH_STARTUP_ROUTE
        ? Response.json({ attemptId: "attempt-ca", runtimeEpoch: "epoch-ca" })
        : Response.json(configured({ service: { name: "web", port } })),
  });
  try {
    const result = await manager.run({
      operation: "ensure",
      service: "web",
      argv: ["node", "server.mjs"],
      cwd: ".",
      port,
      healthPath: "/health",
      prepare: { argv: ["node", "prepare.mjs"], timeout_seconds: 10 },
    });
    assert.equal(result.process.status, "running");
    assert.equal(environments.length, 2);
    for (const environment of environments) {
      assert.equal(environment.NODE_EXTRA_CA_CERTS, certificate);
      assert.equal(environment.COREPACK_HOME, "/opt/corepack");
      assert.equal(environment.TEST_HATCH_CREDENTIAL, undefined);
      assert.notEqual(environment.NODE_TLS_REJECT_UNAUTHORIZED, "0");
    }
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) =>
      secure.close((error) => (error ? reject(error) : resolve())),
    );
    if (priorCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = priorCa;
    if (priorCorepack === undefined) delete process.env.COREPACK_HOME;
    else process.env.COREPACK_HOME = priorCorepack;
    if (priorSecret === undefined) delete process.env.TEST_HATCH_CREDENTIAL;
    else process.env.TEST_HATCH_CREDENTIAL = priorSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test("failed preparation is cleaned up and reported without starting the service", async () => {
  const { root } = await workspace();
  const child = new FakeChild(620);
  const reports: unknown[] = [];
  const spawned: string[] = [];
  const manager = new ProductionHatchManager({
    workspaceRoot: root,
    spawnProcess: (argv) => {
      spawned.push(argv[0]);
      queueMicrotask(() => child.exit());
      return child;
    },
    authorityTransport: async (input, init) => {
      if (String(input) !== SCOTTY_HATCH_STARTUP_ROUTE) throw new Error("service was registered");
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ attemptId: "attempt-2", runtimeEpoch: "epoch-2" });
    },
  });
  await assert.rejects(
    manager.run({ ...ensureInput(), prepare: { argv: ["prepare"], timeout_seconds: 1 } }),
    (error) => error instanceof HatchFailure && error.code === "preparation_failed",
  );
  assert.deepEqual(spawned, ["prepare"]);
  assert.deepEqual(reports, [
    { operation: "begin" },
    {
      operation: "finish",
      attemptId: "attempt-2",
      runtimeEpoch: "epoch-2",
      failureCode: "preparation_failed",
    },
  ]);
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
    processGroupExists: () => child.signalCode === null,
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
  const spawns: Array<Pick<HatchServiceProcess, "argv" | "workingDirectory">> = [];
  const requests: Array<{ readonly input: string; readonly method: string }> = [];
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    spawnProcess: (argv, workingDirectory) => {
      spawns.push({ argv, workingDirectory });
      return child;
    },
    localTransport: async () => new Response("ready"),
    authorityTransport: async (input, init) => {
      requests.push({ input: String(input), method: init?.method ?? "GET" });
      return Response.json({
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
  assert.deepEqual(spawns[0]?.argv, ["npm", "run", "dev", "--", "--host", "0.0.0.0"]);
  assert.equal(spawns[0]?.workingDirectory, app);
  assert.notEqual(requests[0]?.input, SCOTTY_HATCH_ROUTE);
});

test("restore uses persisted readiness and legacy descriptors use the default", async () => {
  const { root, app } = await workspace();
  let configuredTimeout = true;
  let attempts = 0;
  let child = new FakeChild(402);
  const manager = new ScottyHatchManager({
    workspaceRoot: root,
    readyTimeoutMillis: 0,
    spawnProcess: () => child,
    signalProcessGroup: (_pid, signal) => child.exit(signal),
    processGroupExists: () => child.signalCode === null,
    localTransport: async () => new Response(null, { status: ++attempts % 2 === 0 ? 204 : 503 }),
    authorityTransport: async () =>
      Response.json({
        hatchId: "hatch-abcd1234",
        generation: 7,
        operationNonce: "resume-abcd1234",
        runtimeEpoch: "runtime-epoch-7",
        service: {
          name: "web",
          argv: ["npm", "run", "dev"],
          workingDirectory: app,
          port: 4_173,
          healthPath: "/health",
          ...(configuredTimeout ? { readyTimeoutSeconds: 60 } : {}),
        },
      }),
  });
  await manager.restore();
  assert.equal(attempts, 2);
  await manager.shutdown();
  configuredTimeout = false;
  attempts = 0;
  child = new FakeChild(403);
  await assert.rejects(manager.restore(), /did not become ready in time/u);
  assert.equal(attempts, 1);
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
    processGroupExists: () => child.signalCode === null,
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
  scottyHatch(nativePiExtensionApi(api));
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["scotty_hatch"],
  );
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
