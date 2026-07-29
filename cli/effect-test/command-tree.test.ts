import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { execute } from "../src/commands";
import { CliError, EXIT, VERSION } from "../src/core";
import { cliLayer, type CliDependencies } from "../src/dependencies";

const failure = <A>(result: Result.Result<A, CliError>): CliError => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const run = (
  args: ReadonlyArray<string>,
  overrides: Partial<CliDependencies> = {},
): {
  readonly effect: Effect.Effect<number, CliError>;
  readonly stdout: string[];
  readonly stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    effect: execute(args).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(
        cliLayer({
          env: {},
          home: "/tmp/scotty-cli-effect-test",
          cwd: "/tmp/scotty-cli-effect-test",
          stdinIsTTY: false,
          stdoutIsTTY: false,
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
          ...overrides,
        }),
      ),
    ),
    stdout,
    stderr,
  };
};

describe("Effect command tree", () => {
  it.effect(
    "generates root and nested help from one tree with an explicit built-in allowlist",
    () =>
      Effect.gen(function* () {
        const root = run(["--help"]);
        assert.strictEqual(yield* root.effect, EXIT.OK);
        const rootHelp = root.stdout.join("");
        assert.include(rootHelp, "scotty <subcommand> [flags]");
        assert.include(rootHelp, "beam");
        assert.include(rootHelp, "doctor");
        assert.include(rootHelp, "auth");
        assert.include(rootHelp, "runner");
        assert.include(rootHelp, "--version, -V");
        assert.notInclude(rootHelp, "--wizard");
        assert.notInclude(rootHelp, "--completions");
        assert.notInclude(rootHelp, "--log-level");
        assert.strictEqual(root.stderr.join(""), "");

        const beam = run(["beam", "--help"]);
        assert.strictEqual(yield* beam.effect, EXIT.OK);
        assert.include(beam.stdout.join(""), "scotty beam <subcommand> [flags]");
        assert.include(beam.stdout.join(""), "up");
        assert.strictEqual(beam.stderr.join(""), "");

        const runner = run(["runner", "--help"]);
        assert.strictEqual(yield* runner.effect, EXIT.OK);
        assert.include(runner.stdout.join(""), "scotty runner <subcommand> [flags]");
        assert.include(runner.stdout.join(""), "serve");
        assert.include(runner.stdout.join(""), "setup");
        assert.include(runner.stdout.join(""), "list");
        assert.include(runner.stdout.join(""), "remove");
        assert.strictEqual(runner.stderr.join(""), "");

        const auth = run(["auth", "--help"]);
        assert.strictEqual(yield* auth.effect, EXIT.OK);
        assert.include(auth.stdout.join(""), "status");
        assert.include(auth.stdout.join(""), "sync");
        assert.include(auth.stdout.join(""), "reseed");
        assert.strictEqual(auth.stderr.join(""), "");
      }),
  );

  it.effect("lists and removes runners through authenticated control-plane routes", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "DELETE")
          return Response.json({ name: "garage", status: "removed" });
        return Response.json([
          {
            name: "garage",
            desired: "draining",
            connection: "disconnected",
            lastSeenAt: null,
            assignedSessions: 0,
          },
        ]);
      };
      const shared = {
        env: { SCOTTY_HOST: "https://worker.example", SCOTTY_TOKEN: "root-secret" },
        fetch,
      };

      const listed = run(["--json", "runner", "list"], shared);
      assert.strictEqual(yield* listed.effect, EXIT.OK);
      assert.deepStrictEqual(JSON.parse(listed.stdout.join("")), [
        {
          name: "garage",
          desired: "draining",
          connection: "disconnected",
          lastSeenAt: null,
          assignedSessions: 0,
        },
      ]);

      const removed = run(["--json", "runner", "remove", "garage", "--yes"], shared);
      assert.strictEqual(yield* removed.effect, EXIT.OK);
      assert.deepStrictEqual(JSON.parse(removed.stdout.join("")), {
        name: "garage",
        status: "removed",
      });
      assert.deepStrictEqual(
        requests.map((request) => ({
          authorization: request.headers.get("authorization"),
          method: request.method,
          pathname: new URL(request.url).pathname,
        })),
        [
          {
            authorization: "Bearer root-secret",
            method: "GET",
            pathname: "/api/runners",
          },
          {
            authorization: "Bearer root-secret",
            method: "DELETE",
            pathname: "/api/runners/garage",
          },
        ],
      );
    }),
  );

  it.effect("requires exactly one auth reseed target", () =>
    Effect.gen(function* () {
      const missing = run(["auth", "reseed"]);
      assert.strictEqual(
        failure(yield* Effect.result(missing.effect)).message,
        "Pass exactly one session ID or --all-active",
      );
      const both = run(["auth", "reseed", "abc123", "--all-active"]);
      assert.strictEqual(
        failure(yield* Effect.result(both.effect)).message,
        "Pass exactly one session ID or --all-active",
      );
    }),
  );

  it.effect("keeps runner credentials out of shared token flags", () =>
    Effect.gen(function* () {
      const invocation = run([
        "--host",
        "https://worker.example",
        "--token",
        "owner-secret",
        "runner",
        "serve",
        "--name",
        "slumbers",
        "--root",
        "/srv/scotty",
        "--isolation",
        "docker",
        "--image",
        "registry.example/scotty@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]);
      const error = failure(yield* Effect.result(invocation.effect));
      assert.strictEqual(error.code, "bad_usage");
      assert.strictEqual(error.message, "runner serve does not accept --token");
      assert.strictEqual(invocation.stdout.join(""), "");
      assert.strictEqual(invocation.stderr.join(""), "");
    }),
  );

  it.effect("rejects plaintext runner authentication away from loopback", () =>
    Effect.gen(function* () {
      const invocation = run(
        [
          "--host",
          "http://worker.example",
          "runner",
          "serve",
          "--name",
          "slumbers",
          "--root",
          "/srv/scotty",
          "--isolation",
          "docker",
          "--image",
          "registry.example/scotty@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        { env: { SCOTTY_RUNNER_TOKEN: "runner-secret" } },
      );
      const error = failure(yield* Effect.result(invocation.effect));
      assert.strictEqual(error.code, "bad_usage");
      assert.strictEqual(error.message, "runner serve requires an HTTPS Scotty host");
      assert.strictEqual(invocation.stdout.join(""), "");
      assert.strictEqual(invocation.stderr.join(""), "");
    }),
  );

  it.effect("requires an explicit safe runner isolation configuration", () =>
    Effect.gen(function* () {
      const base = [
        "--host",
        "https://worker.example",
        "runner",
        "serve",
        "--name",
        "slumbers",
        "--root",
        "/srv/scotty",
      ];
      const environment = { env: { SCOTTY_RUNNER_TOKEN: "runner-secret" } };

      const missing = run(base, environment);
      assert.strictEqual(
        failure(yield* Effect.result(missing.effect)).message,
        "--isolation process|docker is required",
      );

      const invalid = run([...base, "--isolation", "host"], environment);
      assert.strictEqual(
        failure(yield* Effect.result(invalid.effect)).message,
        "--isolation must be process or docker",
      );

      const remoteProcess = run([...base, "--isolation", "process"], environment);
      assert.strictEqual(
        failure(yield* Effect.result(remoteProcess.effect)).message,
        "--isolation process is only allowed with a loopback Scotty host",
      );

      const missingImage = run([...base, "--isolation", "docker"], environment);
      assert.strictEqual(
        failure(yield* Effect.result(missingImage.effect)).message,
        "--image is required with --isolation docker",
      );

      const invalidImage = run(
        [...base, "--isolation", "docker", "--image", "registry.example/scotty:latest"],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(invalidImage.effect)).message,
        "--image must be digest-pinned as REPOSITORY@sha256:64_LOWER_HEX or sha256:64_LOWER_HEX",
      );

      const processImage = run(
        [
          "--host",
          "http://127.0.0.1:8787",
          "runner",
          "serve",
          "--name",
          "local",
          "--root",
          "/srv/scotty",
          "--isolation",
          "process",
          "--image",
          "registry.example/scotty@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(processImage.effect)).message,
        "--image is only valid with --isolation docker",
      );

      const missingCodexAuth = run(
        [...base, "--isolation", "docker", "--image", `sha256:${"a".repeat(64)}`],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(missingCodexAuth.effect)).message,
        "--codex-auth is required with --isolation docker",
      );

      const relativeCodexAuth = run(
        [
          ...base,
          "--isolation",
          "docker",
          "--image",
          `sha256:${"a".repeat(64)}`,
          "--codex-auth",
          "auth.json",
          "--github-config",
          "/home/runner/.config/gh",
        ],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(relativeCodexAuth.effect)).message,
        "--codex-auth must be an absolute path",
      );

      const processCredentials = run(
        [
          "--host",
          "http://127.0.0.1:8787",
          "runner",
          "serve",
          "--name",
          "local",
          "--root",
          "/srv/scotty",
          "--isolation",
          "process",
          "--codex-auth",
          "/home/runner/.codex/auth.json",
        ],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(processCredentials.effect)).message,
        "--codex-auth is only valid with --isolation docker",
      );

      const missingSource = run(
        [
          ...base,
          "--isolation",
          "docker",
          "--image",
          `sha256:${"a".repeat(64)}`,
          "--codex-auth",
          "/missing/codex-auth.json",
          "--github-config",
          "/missing/hosts.yml",
        ],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(missingSource.effect)).message,
        "--codex-auth must reference an existing regular file",
      );

      const fs = yield* FileSystem.FileSystem;
      const sourceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-sources-" });
      const unsafeCodex = `${sourceRoot}/auth.json`;
      const safeCodex = `${sourceRoot}/safe-auth.json`;
      yield* fs.writeFileString(unsafeCodex, "secret", { mode: 0o644 });
      yield* fs.chmod(unsafeCodex, 0o644);
      yield* fs.writeFileString(safeCodex, "secret", { mode: 0o600 });
      const unsafeSource = run(
        [
          ...base,
          "--isolation",
          "docker",
          "--image",
          `sha256:${"a".repeat(64)}`,
          "--codex-auth",
          unsafeCodex,
          "--github-config",
          "/missing/hosts.yml",
        ],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(unsafeSource.effect)).message,
        "--codex-auth source must not be accessible by group or other users",
      );
      const missingGitHub = run(
        [
          ...base,
          "--isolation",
          "docker",
          "--image",
          `sha256:${"a".repeat(64)}`,
          "--codex-auth",
          safeCodex,
          "--github-config",
          "/missing/hosts.yml",
        ],
        environment,
      );
      assert.strictEqual(
        failure(yield* Effect.result(missingGitHub.effect)).message,
        "--github-config must reference an existing regular file",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps parser failures typed and generated help out of machine stdout", () =>
    Effect.gen(function* () {
      const invocation = run([
        "beam",
        "up",
        "fix",
        "--title",
        "Fix build",
        "--repo",
        "owner/project",
        "--provider",
        "box",
      ]);
      const result = yield* Effect.result(invocation.effect);
      const error = failure(result);
      assert.instanceOf(error, CliError);
      assert.strictEqual(error.code, "bad_usage");
      assert.strictEqual(error.message, "--provider must be cloudflare");
      assert.strictEqual(error.exitCode, EXIT.USAGE);
      assert.strictEqual(invocation.stdout.join(""), "");
      assert.strictEqual(invocation.stderr.join(""), "");
    }),
  );

  it.effect("accepts shared flags around nested commands and keeps version output exact", () =>
    Effect.gen(function* () {
      const list = run(["--host", "https://worker.example", "ls", "--token", "secret", "--json"], {
        fetch: async () => Response.json([]),
      });
      assert.strictEqual(yield* list.effect, EXIT.OK);
      assert.strictEqual(list.stdout.join(""), "[]\n");
      assert.strictEqual(list.stderr.join(""), "");

      const version = run(["-V"]);
      assert.strictEqual(yield* version.effect, EXIT.OK);
      assert.strictEqual(version.stdout.join(""), `${VERSION}\n`);
      assert.strictEqual(version.stderr.join(""), "");
    }),
  );
});
