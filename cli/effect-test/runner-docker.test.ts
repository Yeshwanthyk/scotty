import { createHash } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import {
  makeDockerRunnerCompute,
  RunnerComputeFailure,
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
          if (argv[2] === "--format={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}") {
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

const credentialSources = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const codexAuthSource = `${root}/host-codex-auth.json`;
  const githubConfigSource = `${root}/host-gh-hosts.yml`;
  yield* fs.writeFileString(codexAuthSource, '{"tokens":{"access_token":"codex-secret"}}', {
    mode: 0o600,
  });
  yield* fs.writeFileString(githubConfigSource, "github.com:\n  oauth_token: gh-secret\n", {
    mode: 0o600,
  });
  return { codexAuthSource, githubConfigSource };
});

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
          const sources = yield* credentialSources(root);
          const fake = fakeDocker();
          const compute = yield* makeDockerRunnerCompute(
            {
              root,
              image:
                "registry.example/scotty-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
              ...sources,
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
          const sessionRoot = `${root}/sessions/session-${encoded}`;
          const workspace = `${sessionRoot}/workspace`;
          const create = fake.commands.find(
            (argv) => argv[0] === "container" && argv[1] === "create" && argv[3] === container,
          );
          assert.ok(create);
          assert.includeMembers(create, [
            "--read-only",
            "--cap-drop",
            "ALL",
            `type=bind,source=${workspace},target=/workspace/session-a`,
            `type=bind,source=${sessionRoot}/credentials,target=/run/scotty/credentials`,
            "HOME=/workspace/session-a/.home",
            "CODEX_HOME=/run/scotty/credentials/codex",
            "GH_CONFIG_DIR=/run/scotty/credentials/github",
            "GIT_CONFIG_GLOBAL=/run/scotty/credentials/gitconfig",
            "--entrypoint",
            "/bin/sleep",
            "infinity",
          ]);
          assert.notInclude(fake.commands.flat().join("\n"), "must-not-cross");
          assert.notInclude(fake.commands.flat().join("\n"), "SCOTTY_RUNNER_TOKEN");
          assert.notInclude(fake.commands.flat().join("\n"), "/host/home");
          assert.notInclude(fake.commands.flat().join("\n"), "/host/tmp");
          assert.notInclude(fake.commands.flat().join("\n"), "/host/bin");
          assert.notInclude(fake.commands.flat().join("\n"), "codex-secret");
          assert.notInclude(fake.commands.flat().join("\n"), "gh-secret");
          assert.strictEqual(
            yield* fs.readFileString(`${sessionRoot}/credentials/codex/auth.json`),
            '{"tokens":{"access_token":"codex-secret"}}',
          );
          assert.include(
            yield* fs.readFileString(`${sessionRoot}/credentials/github/hosts.yml`),
            "gh-secret",
          );
          assert.strictEqual((yield* fs.stat(workspace)).mode & 0o777, 0o700);
          assert.strictEqual(
            (yield* fs.stat(`${sessionRoot}/credentials/codex/auth.json`)).mode & 0o777,
            0o600,
          );
        }),
      ),
  );

  it.effect("rejects mounted HTTP when no native runner application transport is installed", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-docker-http-" });
        const sources = yield* credentialSources(root);
        const fake = fakeDocker();
        const compute = yield* makeDockerRunnerCompute(
          {
            root,
            image: `python@sha256:${"f".repeat(64)}`,
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
            ...sources,
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

        let forwarded = false;
        const response = yield* compute.mountedHttp(
          { sessionId: "session-a", runtimeId: "runner-v1:session-a" },
          new Request("http://127.0.0.1:31415/s/session-a/echo?proof=yes", {
            method: "POST",
            body: "portable",
          }),
          () => {
            forwarded = true;
            return Promise.resolve(Response.json({ ok: true }));
          },
        );
        assert.strictEqual(response.status, 404);
        assert.isFalse(forwarded);

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

  it.effect("stops and restores the same container while retaining its session state", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-docker-retain-" });
        const sources = yield* credentialSources(root);
        const fake = fakeDocker();
        const compute = yield* makeDockerRunnerCompute(
          {
            root,
            image:
              "registry.example/scotty-runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
            ...sources,
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
        assert.isFalse(
          yield* fs.exists(`${root}/sessions/session-${hash("session-a")}/credentials`),
        );
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
        const sources = yield* credentialSources(root);
        const fake = fakeDocker();
        const compute = yield* makeDockerRunnerCompute(
          {
            root,
            image:
              "registry.example/scotty-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
            ...sources,
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
          "/workspace/session-a/repo/packages/app",
          `scotty-runner-v1-${hash("session-a")}`,
          "node",
          "-e",
          "process.stdout.write('ok')",
        ]);
        yield* compute.exec("session-a", {
          argv: ["/usr/bin/printf", "ready"],
          detach: true,
        });
        assert.deepStrictEqual(fake.commands.at(-1), [
          "container",
          "exec",
          "--detach",
          "--workdir",
          "/workspace/session-a",
          `scotty-runner-v1-${hash("session-a")}`,
          "/usr/bin/printf",
          "ready",
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
              "registry.example/scotty-runtime@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
            ...sources,
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
              "registry.example/scotty-runtime@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            uid: 1000,
            gid: 1000,
            safePath: "/usr/local/bin:/usr/bin:/bin",
            childEnvironment: {},
            ...sources,
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
