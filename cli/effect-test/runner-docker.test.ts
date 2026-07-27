import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import {
  makeDockerRunnerCompute,
  RUNNER_FIXTURE_FILE,
  RunnerComputeFailure,
  runnerFixtureSource,
  type RunnerComputeCommandOutput,
  type RunnerComputeProcess,
} from "../src/runner-docker";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const successfulOutput = (
  overrides: Partial<RunnerComputeCommandOutput> = {},
): RunnerComputeCommandOutput => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...overrides,
});

interface FakeDocker {
  readonly commands: Array<ReadonlyArray<string>>;
  readonly process: RunnerComputeProcess;
  readonly running: Map<string, boolean>;
}

const fakeDocker = (): FakeDocker => {
  const commands: Array<ReadonlyArray<string>> = [];
  const running = new Map<string, boolean>();
  const process: RunnerComputeProcess = {
    run: (argv) =>
      Effect.sync(() => {
        commands.push([...argv]);
        if (argv[0] === "container" && argv[1] === "ls" && typeof argv[5] === "string") {
          const name = argv[5].slice("name=^/".length, -1);
          return successfulOutput({ stdout: running.has(name) ? "container-id\n" : "" });
        }
        if (argv[0] === "container" && argv[1] === "inspect" && typeof argv[3] === "string") {
          if (argv[2] === "--format={{.NetworkSettings.IPAddress}}") {
            return successfulOutput({ stdout: "172.17.0.2\n" });
          }
          return successfulOutput({ stdout: `${running.get(argv[3]) === true}\n` });
        }
        if (argv[0] === "container" && argv[1] === "create" && typeof argv[3] === "string") {
          running.set(argv[3], false);
          return successfulOutput({ stdout: "container-id\n" });
        }
        if (argv[0] === "container" && argv[1] === "start" && typeof argv[2] === "string") {
          running.set(argv[2], true);
          return successfulOutput();
        }
        if (argv[0] === "container" && argv[1] === "stop" && typeof argv[4] === "string") {
          running.set(argv[4], false);
          return successfulOutput();
        }
        if (argv[0] === "container" && argv[1] === "rm" && typeof argv[3] === "string") {
          running.delete(argv[3]);
          return successfulOutput();
        }
        if (argv[0] === "container" && argv[1] === "exec") {
          return successfulOutput({ stdout: "command output" });
        }
        return successfulOutput({ exitCode: 1 });
      }),
  };
  return { commands, process, running };
};

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const computeFailure = <A>(
  result: Result.Result<A, RunnerComputeFailure>,
): RunnerComputeFailure => {
  assert.isTrue(Result.isFailure(result));
  return result.failure;
};

describe("Docker runner compute", () => {
  it.effect(
    "creates one hardened container per hashed session without leaking ambient secrets",
    () =>
      withNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-docker-runner-" });
          const fake = fakeDocker();
          const compute = yield* makeDockerRunnerCompute(
            {
              root,
              image:
                "registry.example/scotty-pican@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              uid: 1000,
              gid: 1001,
              safePath: "/usr/local/bin:/usr/bin:/bin",
              childEnvironment: {
                HOME: "/host/home",
                LANG: "C.UTF-8",
                PATH: "/host/bin",
                TMPDIR: "/host/tmp",
                SCOTTY_RUNNER_TOKEN: "must-not-cross",
              },
            },
            fake.process,
          );

          const first = yield* compute.ensure("session-a");
          const second = yield* compute.ensure("session-b");
          assert.strictEqual(first.phase, "running");
          assert.strictEqual(second.phase, "running");
          assert.notStrictEqual(first.resourceId, second.resourceId);
          assert.notStrictEqual(first.workspace, second.workspace);

          const encoded = hash("session-a");
          const container = `scotty-runner-v1-${encoded}`;
          const workspace = `${root}/sessions/session-${encoded}`;
          const create = fake.commands.find(
            (argv) => argv[0] === "container" && argv[1] === "create" && argv[3] === container,
          );
          assert.deepStrictEqual(create, [
            "container",
            "create",
            "--name",
            container,
            "--user",
            "1000:1001",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=64m",
            "--tmpfs",
            "/var/tmp:rw,nosuid,nodev,size=64m",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--memory",
            "2147483648b",
            "--memory-swap",
            "2147483648b",
            "--pids-limit",
            "512",
            "--network",
            "bridge",
            "--mount",
            `type=bind,source=${workspace},target=/workspace`,
            "--workdir",
            "/workspace",
            "--env",
            "HOME=/workspace/.home",
            "--env",
            "TMPDIR=/tmp",
            "--env",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "--env",
            "LANG=C.UTF-8",
            "registry.example/scotty-pican@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "python3",
            "/workspace/.scotty-runner-fixture.py",
          ]);
          assert.notInclude(fake.commands.flat().join("\n"), "must-not-cross");
          assert.notInclude(fake.commands.flat().join("\n"), "SCOTTY_RUNNER_TOKEN");
          assert.notInclude(fake.commands.flat().join("\n"), "/host/home");
          assert.notInclude(fake.commands.flat().join("\n"), "/host/tmp");
          assert.notInclude(fake.commands.flat().join("\n"), "/host/bin");
          assert.isTrue(yield* fs.exists(`${workspace}/.home`));
          const fixture = yield* fs.readFileString(`${workspace}/${RUNNER_FIXTURE_FILE}`);
          assert.include(fixture, 'SESSION = "session-a"');
          assert.include(fixture, 'RUNNER = "slumbers-compatible"');
          assert.notInclude(fixture, "must-not-cross");
          assert.strictEqual((yield* fs.stat(workspace)).mode & 0o777, 0o700);
          assert.strictEqual((yield* fs.stat(`${workspace}/.home`)).mode & 0o777, 0o700);
        }),
      ),
  );

  it.effect(
    "forwards mounted HTTP only to the running session container's fixed bridge target",
    () =>
      withNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-docker-http-" });
          const fake = fakeDocker();
          const compute = yield* makeDockerRunnerCompute(
            {
              root,
              image: `python@sha256:${"f".repeat(64)}`,
              uid: 1000,
              gid: 1000,
              safePath: "/usr/local/bin:/usr/bin:/bin",
              childEnvironment: {},
            },
            fake.process,
          );
          const absent = yield* Effect.result(
            compute.mountedHttp(
              { sessionId: "session-a", runtimeId: "runner-v1:session-a" },
              new Request("http://127.0.0.1:31415/s/session-a/health"),
              () => Promise.resolve(new Response()),
            ),
          );
          assert.strictEqual(computeFailure(absent).code, "runtime_not_running");

          yield* compute.ensure("session-a");
          const commandsBeforeMismatch = fake.commands.length;
          const mismatch = yield* Effect.result(
            compute.mountedHttp(
              { sessionId: "session-a", runtimeId: "runner-v1:wrong" },
              new Request("http://ignored/s/session-a/health"),
              () => Promise.resolve(new Response()),
            ),
          );
          assert.strictEqual(computeFailure(mismatch).code, "runtime_not_running");
          assert.strictEqual(fake.commands.length, commandsBeforeMismatch);

          let forwarded: Request | undefined;
          const controller = new AbortController();
          const response = yield* compute.mountedHttp(
            { sessionId: "session-a", runtimeId: "runner-v1:session-a" },
            new Request("http://127.0.0.1:31415/s/session-a/echo?proof=yes", {
              method: "POST",
              body: "portable",
              signal: controller.signal,
            }),
            (request) => {
              forwarded = request;
              return Promise.resolve(Response.json({ ok: true }));
            },
          );
          assert.strictEqual(response.status, 200);
          assert.strictEqual(forwarded?.url, "http://172.17.0.2:31415/s/session-a/echo?proof=yes");
          assert.strictEqual(forwarded?.method, "POST");
          controller.abort();
          assert.isTrue(forwarded?.signal.aborted);
          assert.deepStrictEqual(fake.commands.at(-1), [
            "container",
            "inspect",
            "--format={{.NetworkSettings.IPAddress}}",
            `scotty-runner-v1-${hash("session-a")}`,
          ]);

          yield* compute.stop("session-a");
          const stopped = yield* Effect.result(
            compute.mountedHttp(
              { sessionId: "session-a", runtimeId: "runner-v1:session-a" },
              new Request("http://ignored/s/session-a/health"),
              () => Promise.resolve(new Response()),
            ),
          );
          assert.strictEqual(computeFailure(stopped).code, "runtime_not_running");
        }),
      ),
  );

  it.effect("serves the portable fixture shell, asset, action, SSE, and health locally", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-fixture-" });
        const script = `${root}/${RUNNER_FIXTURE_FILE}`;
        const localPort = 43_145;
        yield* fs.writeFileString(
          script,
          runnerFixtureSource("fixture-session", "slumbers-a", localPort),
        );
        const child = spawn("python3", [script], { stdio: "ignore" });
        const base = `http://127.0.0.1:${localPort}/s/fixture-session`;
        let healthy = false;
        for (let attempt = 0; attempt < 30 && !healthy; attempt += 1) {
          healthy = yield* Effect.tryPromise({
            try: () => fetch(`${base}/health`).then((response) => response.ok),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(false)));
          if (!healthy) yield* Effect.sleep("20 millis");
        }
        assert.isTrue(healthy);
        const shell = yield* Effect.promise(() =>
          fetch(base, { headers: { "x-secret-proof": "must-not-reflect" } }).then((response) =>
            response.text(),
          ),
        );
        assert.include(shell, "provider=runner");
        assert.include(shell, "runner=slumbers-a");
        assert.include(shell, "session=fixture-session");
        assert.include(shell, "/s/fixture-session/fixture.css");
        assert.notInclude(shell, "must-not-reflect");
        const css = yield* Effect.promise(() => fetch(`${base}/fixture.css`).then((r) => r.text()));
        assert.include(css, "font-family");
        const echo = yield* Effect.promise(() =>
          fetch(`${base}/echo`, { method: "POST", body: "portable-proof" }).then((r) => r.json()),
        );
        assert.deepStrictEqual(echo, { action: "echo", bytes: 14, body: "portable-proof" });
        const oversized = yield* Effect.promise(
          () =>
            new Promise<{
              readonly body: string;
              readonly connection: string | undefined;
              readonly status: number;
            }>((resolve, reject) => {
              const request = httpRequest(
                `${base}/echo`,
                { method: "POST", headers: { "content-length": "4097" } },
                (response) => {
                  const chunks: Array<Buffer> = [];
                  response.on("data", (chunk: Buffer) => chunks.push(chunk));
                  response.on("end", () =>
                    resolve({
                      body: Buffer.concat(chunks).toString(),
                      connection: response.headers.connection,
                      status: response.statusCode ?? 0,
                    }),
                  );
                },
              );
              request.on("error", reject);
              request.end("x".repeat(4097));
            }),
        );
        assert.deepStrictEqual(oversized, {
          body: "request body too large",
          connection: "close",
          status: 413,
        });
        const events = yield* Effect.promise(() => fetch(`${base}/events`).then((r) => r.text()));
        assert.strictEqual(events.match(/event: fixture/g)?.length, 3);
        child.kill("SIGTERM");
      }),
    ),
  );

  it.effect("stops and restores the same container while retaining only its workspace", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-docker-retain-" });
        const fake = fakeDocker();
        const compute = yield* makeDockerRunnerCompute(
          {
            root,
            image:
              "registry.example/scotty-pican@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
          },
          fake.process,
        );

        const ensured = yield* compute.ensure("session-a");
        yield* fs.writeFileString(`${ensured.workspace}/marker.txt`, "retained");
        const outside = `${root}/outside.txt`;
        yield* fs.writeFileString(outside, "outside");

        assert.strictEqual((yield* compute.stop("session-a")).phase, "stopped");
        assert.strictEqual((yield* compute.inspect("session-a")).phase, "stopped");
        assert.isTrue(yield* fs.exists(`${ensured.workspace}/marker.txt`));

        assert.strictEqual((yield* compute.ensure("session-a")).phase, "running");
        assert.strictEqual(yield* fs.readFileString(`${ensured.workspace}/marker.txt`), "retained");
        assert.strictEqual(
          fake.commands.filter((argv) => argv[0] === "container" && argv[1] === "create").length,
          1,
        );

        assert.strictEqual((yield* compute.remove("session-a")).phase, "absent");
        assert.isFalse(yield* fs.exists(ensured.workspace));
        assert.isTrue(yield* fs.exists(outside));
        assert.strictEqual((yield* compute.inspect("session-a")).phase, "absent");
      }),
    ),
  );

  it.effect("executes argv directly in the mounted workspace and keeps failures fixed", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-docker-exec-" });
        const fake = fakeDocker();
        const compute = yield* makeDockerRunnerCompute(
          {
            root,
            image:
              "registry.example/scotty-pican@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
          },
          fake.process,
        );

        const stopped = yield* Effect.result(
          compute.exec("session-a", { argv: ["node", "--version"] }),
        );
        const stoppedFailure = computeFailure(stopped);
        assert.instanceOf(stoppedFailure, RunnerComputeFailure);
        assert.strictEqual(stoppedFailure.code, "runtime_not_running");
        assert.strictEqual(stoppedFailure.message, "Runner compute operation failed");

        yield* compute.ensure("session-a");
        const output = yield* compute.exec("session-a", {
          argv: ["node", "-e", "process.stdout.write('ok')"],
          relativeCwd: "repo/packages/app",
        });
        assert.strictEqual(output.stdout, "command output");
        const command = fake.commands.at(-1);
        assert.deepStrictEqual(command, [
          "container",
          "exec",
          "--workdir",
          "/workspace/repo/packages/app",
          `scotty-runner-v1-${hash("session-a")}`,
          "node",
          "-e",
          "process.stdout.write('ok')",
        ]);

        for (const relativeCwd of ["/outside", "../outside", "repo/../../outside"]) {
          const invalid = yield* Effect.result(
            compute.exec("session-a", {
              argv: ["node", "--version"],
              relativeCwd,
            }),
          );
          assert.strictEqual(computeFailure(invalid).code, "invalid_cwd");
        }

        const failing: RunnerComputeProcess = {
          run: () => Effect.succeed(successfulOutput({ exitCode: 125, stderr: "hidden details" })),
        };
        const unavailable = yield* makeDockerRunnerCompute(
          {
            root,
            image:
              "registry.example/scotty-pican@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
          },
          failing,
        );
        const failure = yield* Effect.result(unavailable.inspect("session-a"));
        const unavailableFailure = computeFailure(failure);
        assert.strictEqual(unavailableFailure.code, "process_failed");
        assert.strictEqual(unavailableFailure.message, "Runner compute operation failed");
        assert.notInclude(unavailableFailure.message, "hidden details");

        const interruptedProcess: RunnerComputeProcess = {
          run: (argv) =>
            argv[0] === "container" && argv[1] === "exec"
              ? Effect.fail(new RunnerComputeFailure({ code: "process_failed" }))
              : fake.process.run(argv),
        };
        const interruptedCompute = yield* makeDockerRunnerCompute(
          {
            root,
            image:
              "registry.example/scotty-pican@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
          },
          interruptedProcess,
        );
        const interrupted = yield* Effect.result(
          interruptedCompute.exec("session-a", { argv: ["node", "agent.js"] }),
        );
        assert.strictEqual(computeFailure(interrupted).code, "process_failed");
        assert.strictEqual((yield* interruptedCompute.inspect("session-a")).phase, "running");
      }),
    ),
  );
});
