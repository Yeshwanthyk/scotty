import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { execute } from "../src/commands";
import { CliError } from "../src/core";
import { cliLayer, type CliDependencies } from "../src/dependencies";

const failure = <A>(result: Result.Result<A, CliError>): CliError => {
  assert.isTrue(Result.isFailure(result));
  return result.failure;
};

const invoke = (args: ReadonlyArray<string>, overrides: Partial<CliDependencies>) => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  return {
    effect: execute(args).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(
        cliLayer({
          env: {},
          home: "/unused",
          cwd: "/unused",
          stdinIsTTY: false,
          stdoutIsTTY: false,
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
          ...overrides,
        }),
      ),
    ),
    stderr,
    stdout,
  };
};

const setupArguments = (
  root: string,
  codexAuth: string,
  sourceBinary: string,
): ReadonlyArray<string> => [
  "runner",
  "setup",
  "--host",
  "https://worker.example",
  "--name",
  "slumbers",
  "--root",
  root,
  "--image",
  `sha256:${"a".repeat(64)}`,
  "--codex-auth",
  codexAuth,
  "--source-binary",
  sourceBinary,
];

describe("runner setup", () => {
  it.effect("installs a repeatable hardened user service without emitting secrets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-setup-" });
      const home = `${temporary}/home`;
      const root = `${temporary}/runner-root`;
      const codexAuth = `${temporary}/auth.json`;
      const sourceBinary = `${temporary}/scotty-source`;
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(codexAuth, '{"access_token":"codex-secret"}', { mode: 0o600 });
      yield* fs.writeFileString(sourceBinary, "compiled-scotty", { mode: 0o755 });
      yield* fs.chmod(sourceBinary, 0o755);
      const commands: Array<ReadonlyArray<string>> = [];
      const run = (command: string[]) => {
        commands.push(command);
        if (command[0] === "gh")
          return Promise.resolve({ exitCode: 0, stdout: "github-secret\n", stderr: "" });
        if (command.includes("is-active"))
          return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" });
        return Promise.resolve({ exitCode: 0, stdout: "ok\n", stderr: "" });
      };
      const first = invoke(setupArguments(root, codexAuth, sourceBinary), {
        env: { SCOTTY_RUNNER_TOKEN: "runner-secret" },
        home,
        run,
      });
      assert.strictEqual(yield* first.effect, 0);
      const output = first.stdout.join("");
      assert.notInclude(output, "runner-secret");
      assert.notInclude(output, "github-secret");
      assert.notInclude(output, "codex-secret");
      assert.deepStrictEqual(JSON.parse(output), {
        binary: `${home}/.local/bin/scotty`,
        credentials: {
          codexAuth: `${home}/.local/share/scotty/runner/credentials/codex-auth.json`,
          githubConfig: `${home}/.local/share/scotty/runner/credentials/github-hosts.yml`,
        },
        environmentFile: `${home}/.config/scotty/runner/runner.env`,
        runner: "slumbers",
        service: `${home}/.config/systemd/user/scotty-runner.service`,
        status: "active",
      });
      assert.strictEqual(first.stderr.join(""), "");
      assert.deepStrictEqual(commands, [
        ["docker", "info", "--format", "{{.ServerVersion}}"],
        ["gh", "auth", "token"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "scotty-runner.service"],
        ["systemctl", "--user", "restart", "scotty-runner.service"],
        ["systemctl", "--user", "is-active", "scotty-runner.service"],
      ]);
      assert.notInclude(commands.flat().join("\n"), "github-secret");
      assert.notInclude(commands.flat().join("\n"), "runner-secret");

      const installedAuth = `${home}/.local/share/scotty/runner/credentials/codex-auth.json`;
      const installedGitHub = `${home}/.local/share/scotty/runner/credentials/github-hosts.yml`;
      const environmentFile = `${home}/.config/scotty/runner/runner.env`;
      const service = `${home}/.config/systemd/user/scotty-runner.service`;
      assert.strictEqual(yield* fs.readFileString(`${home}/.local/bin/scotty`), "compiled-scotty");
      assert.strictEqual(
        yield* fs.readFileString(installedAuth),
        '{"access_token":"codex-secret"}',
      );
      assert.include(yield* fs.readFileString(installedGitHub), "github-secret");
      assert.strictEqual(
        yield* fs.readFileString(environmentFile),
        'SCOTTY_RUNNER_TOKEN="runner-secret"\n',
      );
      const serviceText = yield* fs.readFileString(service);
      assert.include(serviceText, '"runner" "serve"');
      assert.include(serviceText, "NoNewPrivileges=true");
      assert.include(serviceText, "ProtectSystem=strict");
      assert.include(serviceText, `EnvironmentFile=${environmentFile}`);
      assert.notInclude(serviceText, "runner-secret");
      assert.notInclude(serviceText, "github-secret");
      for (const path of [installedAuth, installedGitHub, environmentFile, service]) {
        assert.strictEqual((yield* fs.stat(path)).mode & 0o777, 0o600);
      }
      for (const path of [
        `${home}/.local/share/scotty/runner/credentials`,
        `${home}/.config/scotty/runner`,
        `${home}/.config/systemd/user`,
        root,
      ]) {
        assert.strictEqual((yield* fs.stat(path)).mode & 0o777, 0o700);
      }

      commands.length = 0;
      const repeated = invoke(setupArguments(root, codexAuth, sourceBinary), {
        env: { SCOTTY_RUNNER_TOKEN: "runner-secret" },
        home,
        run,
      });
      assert.strictEqual(yield* repeated.effect, 0);
      assert.strictEqual(JSON.parse(repeated.stdout.join("")).status, "active");
      assert.deepStrictEqual(commands.at(-1), [
        "systemctl",
        "--user",
        "is-active",
        "scotty-runner.service",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails before writes when prerequisites are absent or unsafe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-fail-" });
      const home = `${temporary}/home`;
      const root = `${temporary}/runner-root`;
      const codexAuth = `${temporary}/auth.json`;
      const sourceBinary = `${temporary}/scotty-source`;
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(codexAuth, "codex-secret", { mode: 0o600 });
      yield* fs.writeFileString(sourceBinary, "compiled-scotty", { mode: 0o755 });
      yield* fs.chmod(sourceBinary, 0o755);
      const commands: Array<ReadonlyArray<string>> = [];
      const noToken = invoke(setupArguments(root, codexAuth, sourceBinary), {
        env: {},
        home,
        run: (command) => {
          commands.push(command);
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      });
      const noTokenResult = yield* Effect.result(noToken.effect);
      const noTokenFailure = failure(noTokenResult);
      assert.instanceOf(noTokenFailure, CliError);
      assert.strictEqual(noTokenFailure.message, "Runner token is not configured");
      assert.deepStrictEqual(commands, []);
      assert.isFalse(yield* fs.exists(`${home}/.config/scotty`));

      const unsafeRoot = invoke(setupArguments("/", codexAuth, sourceBinary), {
        env: { SCOTTY_RUNNER_TOKEN: "runner-secret" },
        home,
        run: (command) => {
          commands.push(command);
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      });
      const unsafeRootResult = yield* Effect.result(unsafeRoot.effect);
      assert.strictEqual(failure(unsafeRootResult).message, "Runner root is unsafe");
      assert.deepStrictEqual(commands, []);

      yield* fs.chmod(codexAuth, 0o644);
      const unsafe = invoke(setupArguments(root, codexAuth, sourceBinary), {
        env: { SCOTTY_RUNNER_TOKEN: "runner-secret" },
        home,
        run: (command) => {
          commands.push(command);
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      });
      const unsafeResult = yield* Effect.result(unsafe.effect);
      assert.strictEqual(failure(unsafeResult).message, "Codex auth source permissions are unsafe");
      assert.deepStrictEqual(commands, []);

      yield* fs.chmod(codexAuth, 0o600);
      const noDocker = invoke(setupArguments(root, codexAuth, sourceBinary), {
        env: { SCOTTY_RUNNER_TOKEN: "runner-secret" },
        home,
        run: (command) => {
          commands.push(command);
          return Promise.resolve({
            exitCode: command[0] === "docker" ? 1 : 0,
            stdout: "",
            stderr: "",
          });
        },
      });
      const noDockerResult = yield* Effect.result(noDocker.effect);
      assert.strictEqual(failure(noDockerResult).message, "Docker is not available");
      assert.deepStrictEqual(commands, [["docker", "info", "--format", "{{.ServerVersion}}"]]);
      assert.isFalse(yield* fs.exists(`${home}/.config/scotty`));

      commands.length = 0;
      const noGitHub = invoke(setupArguments(root, codexAuth, sourceBinary), {
        env: { SCOTTY_RUNNER_TOKEN: "runner-secret" },
        home,
        run: (command) => {
          commands.push(command);
          return Promise.resolve({
            exitCode: command[0] === "gh" ? 1 : 0,
            stdout: "",
            stderr: "not logged in",
          });
        },
      });
      const noGitHubResult = yield* Effect.result(noGitHub.effect);
      assert.strictEqual(failure(noGitHubResult).message, "GitHub CLI is not authenticated");
      assert.deepStrictEqual(commands, [
        ["docker", "info", "--format", "{{.ServerVersion}}"],
        ["gh", "auth", "token"],
      ]);
      assert.isFalse(yield* fs.exists(`${home}/.config/scotty`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
