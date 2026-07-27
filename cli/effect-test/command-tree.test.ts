import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
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
      }),
  );

  it.effect("keeps parser failures typed and generated help out of machine stdout", () =>
    Effect.gen(function* () {
      const invocation = run(["beam", "up", "fix", "--repo", "owner/project", "--provider", "box"]);
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
