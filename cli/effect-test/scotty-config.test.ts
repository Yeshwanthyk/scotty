import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { execute } from "../src/commands";
import { CliError, EXIT } from "../src/core";
import {
  decodeScottyTomlText,
  loadScottyTomlConfig,
  scottyTomlConfigPath,
} from "../src/scotty-config";
import { cliLayer, type CliDependencies } from "../src/dependencies";

const validToml = (
  input: {
    readonly skills?: ReadonlyArray<string>;
    readonly packages?: ReadonlyArray<string>;
    readonly tools?: ReadonlyArray<string>;
    readonly extensions?: ReadonlyArray<string>;
    readonly allowed?: ReadonlyArray<string>;
  } = {},
): string =>
  [
    "version = 1",
    "",
    "[sync]",
    `skills = ${JSON.stringify(input.skills ?? ["~/.pi/agent/skills"])}`,
    `packages = ${JSON.stringify(input.packages ?? [])}`,
    `tools = ${JSON.stringify(input.tools ?? ["~/.pi/agent/tools"])}`,
    `extensions = ${JSON.stringify(input.extensions ?? ["~/.pi/agent/extensions"])}`,
    "",
    "[repos]",
    `allowed = ${JSON.stringify(input.allowed ?? ["owner/fixture"])}`,
    "",
  ].join("\n");

const withTempDirectory = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "scotty-config-test-"))),
      use,
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    ),
  );

const writeToml = (home: string, text: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    const path = scottyTomlConfigPath(home);
    await mkdir(join(home, ".config", "scotty"), { recursive: true });
    await writeFile(path, text, { mode: 0o600 });
  });

const failure = <A, E>(result: Result.Result<A, E>): E => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result));
  return result.success;
};

const load = (home: string, cwd: string) =>
  loadScottyTomlConfig({ home, cwd }).pipe(
    Effect.provide(
      cliLayer({
        env: {},
        home,
        cwd,
        stdoutIsTTY: false,
        stdinIsTTY: false,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ),
  );

const runCommand = (
  args: ReadonlyArray<string>,
  overrides: Partial<CliDependencies>,
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
          home: "/tmp/scotty-config-command-test",
          cwd: "/tmp/scotty-config-command-test",
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

describe("Scotty TOML configuration boundary", () => {
  it.effect("parses as unknown and strictly decodes the target surface", () =>
    Effect.gen(function* () {
      const decoded = success(
        yield* Effect.result(
          decodeScottyTomlText(
            validToml({
              skills: ["~/.pi/agent/skills"],
              tools: ["./tools"],
              extensions: ["/tmp/extensions"],
              allowed: ["Owner/Fixture"],
            }),
          ),
        ),
      );
      assert.deepStrictEqual(decoded, {
        version: 1,
        sync: {
          skills: ["~/.pi/agent/skills"],
          packages: [],
          tools: ["./tools"],
          extensions: ["/tmp/extensions"],
        },
        repos: { allowed: ["Owner/Fixture"] },
      });

      const invalidDocuments = [
        `${validToml()}unknown = true\n`,
        `${validToml().replace("[repos]", "future = true\n\n[repos]")}`,
        "version =\n",
        validToml({ allowed: ["owner/fixture", "OWNER/FIXTURE"] }),
        validToml({ allowed: ["owner/not/a-repository"] }),
        validToml({ skills: ["${HOME}/.pi/agent/skills"] }),
      ];
      for (const document of invalidDocuments) {
        const result = yield* Effect.result(decodeScottyTomlText(document));
        assert.instanceOf(failure(result), CliError);
      }
    }),
  );

  it.effect("rejects duplicate literal roots within a category", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const skills = join(home, "skills");
        yield* Effect.promise(() => mkdir(skills));
        yield* writeToml(
          home,
          validToml({ skills: ["./skills", "./skills"], tools: [], extensions: [] }),
        );

        const result = yield* Effect.result(load(home, home));
        const error = failure(result);
        assert.instanceOf(error, CliError);
        assert.include(error.message, "sync.skills");
        assert.include(error.message, "duplicate roots after resolution");
      }),
    ),
  );

  it.effect("rejects roots that resolve to the same canonical path", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const skills = join(home, "skills");
        yield* Effect.promise(() => mkdir(skills));
        yield* writeToml(
          home,
          validToml({ skills: ["./skills", skills], tools: [], extensions: [] }),
        );

        const result = yield* Effect.result(load(home, home));
        const error = failure(result);
        assert.instanceOf(error, CliError);
        assert.include(error.message, "sync.skills");
        assert.include(error.message, "duplicate roots after resolution");
      }),
    ),
  );
  it.effect("rejects filesystem aliases of the same root", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const realParent = join(home, "real");
        const skills = join(realParent, "skills");
        const aliasParent = join(home, "alias");
        yield* Effect.promise(() => mkdir(skills, { recursive: true }));
        yield* Effect.promise(() => symlink(realParent, aliasParent));
        yield* writeToml(
          home,
          validToml({
            skills: [skills, join(aliasParent, "skills")],
            tools: [],
            extensions: [],
          }),
        );

        const result = yield* Effect.result(load(home, home));
        const error = failure(result);
        assert.instanceOf(error, CliError);
        assert.include(error.message, "sync.skills");
        assert.include(error.message, "duplicate roots after resolution");
      }),
    ),
  );

  it.effect("resolves tilde and relative roots locally while retaining TOML values", () =>
    withTempDirectory((home) =>
      withTempDirectory((cwd) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            mkdir(join(home, ".pi", "agent", "skills"), { recursive: true }),
          );
          yield* Effect.promise(() =>
            mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true }),
          );
          yield* Effect.promise(() => mkdir(join(cwd, "tools"), { recursive: true }));
          yield* Effect.promise(() =>
            mkdir(join(home, "packages", "local-package"), { recursive: true }),
          );
          yield* writeToml(
            home,
            validToml({
              skills: ["~/.pi/agent/skills"],
              packages: ["~/packages/local-package"],
              tools: ["./tools"],
              extensions: ["~/.pi/agent/extensions"],
            }),
          );

          const loaded = yield* load(home, cwd);
          assert.deepStrictEqual(loaded.config.sync.tools, ["./tools"]);
          assert.deepStrictEqual(loaded.resolvedRoots, {
            skills: [yield* Effect.promise(() => realpath(join(home, ".pi", "agent", "skills")))],
            packages: [
              yield* Effect.promise(() => realpath(join(home, "packages", "local-package"))),
            ],
            tools: [yield* Effect.promise(() => realpath(join(cwd, "tools")))],
            extensions: [
              yield* Effect.promise(() => realpath(join(home, ".pi", "agent", "extensions"))),
            ],
          });
        }),
      ),
    ),
  );

  it.effect("rejects missing, symlinked, and overly broad source roots", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        yield* writeToml(
          home,
          validToml({ skills: [join(home, "missing")], tools: [], extensions: [] }),
        );
        const missing = yield* Effect.result(load(home, home));
        assert.include(failure(missing).message, "does not exist");
        const fileRoot = join(home, "not-a-directory");
        yield* Effect.promise(() => writeFile(fileRoot, "source"));
        yield* writeToml(home, validToml({ skills: [], tools: [fileRoot], extensions: [] }));
        const notDirectory = yield* Effect.result(load(home, home));
        assert.include(failure(notDirectory).message, "not a directory");

        const target = join(home, "target");
        const linked = join(home, "linked");
        yield* Effect.promise(() => mkdir(target));
        yield* Effect.promise(() => symlink(target, linked));
        yield* writeToml(home, validToml({ skills: [linked], tools: [], extensions: [] }));
        const symlinked = yield* Effect.result(load(home, home));
        assert.include(failure(symlinked).message, "unsafe");

        yield* writeToml(home, validToml({ skills: ["~"], tools: [], extensions: [] }));
        const broad = yield* Effect.result(load(home, home));
        assert.include(failure(broad).message, "unsafe");
      }),
    ),
  );

  it.effect("checks locally without network, provider, or credential effects", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(join(home, "skills")));
        yield* Effect.promise(() => mkdir(join(home, "tools")));
        yield* Effect.promise(() => mkdir(join(home, "extensions")));
        yield* writeToml(
          home,
          validToml({
            skills: ["./skills"],
            tools: ["./tools"],
            extensions: ["./extensions"],
          }),
        );
        let fetchCalls = 0;
        let processCalls = 0;
        const invocation = runCommand(["--json", "config", "check"], {
          home,
          cwd: home,
          fetch: async () => {
            fetchCalls += 1;
            return new Response();
          },
          run: async () => {
            processCalls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        });
        assert.strictEqual(yield* invocation.effect, EXIT.OK);
        assert.strictEqual(fetchCalls, 0);
        assert.strictEqual(processCalls, 0);
        assert.deepStrictEqual(JSON.parse(invocation.stdout.join("")), {
          ok: true,
          configPath: scottyTomlConfigPath(home),
          version: 1,
          sync: {
            skills: ["./skills"],
            packages: [],
            tools: ["./tools"],
            extensions: ["./extensions"],
          },
          repos: { allowed: ["owner/fixture"] },
        });
        assert.strictEqual(invocation.stderr.join(""), "");
      }),
    ),
  );
});
