import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { execute } from "../src/commands";
import { EXIT } from "../src/core";
import { cliLayer } from "../src/dependencies";
import { scottyTomlConfigPath } from "../src/scotty-config";

const withTempDirectory = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "scotty-sync-command-test-"))),
      use,
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    ),
  );

const writeFixture = Effect.fnUntraced(function* (home: string) {
  const skills = join(home, "skills");
  const localPackage = join(home, "packages", "pi-subagents");
  const tools = join(home, "tools");
  const extensions = join(home, "extensions");
  yield* Effect.promise(() => mkdir(join(skills, "fixture-skill"), { recursive: true }));
  yield* Effect.promise(() => mkdir(tools, { recursive: true }));
  yield* Effect.promise(() =>
    mkdir(join(localPackage, "node_modules", "effect"), { recursive: true }),
  );
  yield* Effect.promise(() => mkdir(extensions, { recursive: true }));
  yield* Effect.promise(() =>
    writeFile(
      join(skills, "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: Fixture\n---\n\n# Fixture\n",
    ),
  );
  yield* Effect.promise(() => writeFile(join(tools, "fixture-tool"), "#!/bin/sh\n"));
  yield* Effect.promise(() =>
    writeFile(join(extensions, "fixture-extension.ts"), "export default () => {}\n"),
  );
  yield* Effect.promise(() =>
    writeFile(
      join(localPackage, "package.json"),
      `${JSON.stringify({ name: "pi-subagents", pi: { extensions: ["./index.ts"] } })}\n`,
    ),
  );
  yield* Effect.promise(() =>
    writeFile(join(localPackage, "index.ts"), "export default () => {}\n"),
  );
  yield* Effect.promise(() =>
    writeFile(join(localPackage, "node_modules", "effect", "index.js"), "export {};\n"),
  );
  const configPath = scottyTomlConfigPath(home);
  yield* Effect.promise(() => mkdir(join(home, ".config", "scotty"), { recursive: true }));
  yield* Effect.promise(() =>
    writeFile(
      configPath,
      [
        "version = 1",
        "[sync]",
        `skills = [${JSON.stringify(skills)}]`,
        `packages = [${JSON.stringify(localPackage)}]`,
        `tools = [${JSON.stringify(tools)}]`,
        `extensions = [${JSON.stringify(extensions)}]`,
        "[repos]",
        "allowed = []",
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
  );
});

const run = (
  home: string,
  args: ReadonlyArray<string>,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  stdoutIsTTY = false,
) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    effect: execute(args).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(
        cliLayer({
          env: { SCOTTY_TOKEN: "root-token" },
          home,
          cwd: home,
          stdinIsTTY: false,
          stdoutIsTTY,
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
          fetch,
        }),
      ),
    ),
  };
};

describe("top-level sync and embedded skill commands", () => {
  it.effect("reuses the CAS digest and emits the small sync JSON contract", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        yield* writeFixture(home);
        let activeDigest: string | null = null;
        let putCalls = 0;
        const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === "/api/sandbox/configuration")
            return Response.json({ schemaVersion: 1, revision: 0, activeDigest });
          putCalls += 1;
          activeDigest = path.slice(path.lastIndexOf("/") + 1);
          return Response.json({ schemaVersion: 1, revision: 1, activeDigest });
        };

        const first = run(home, ["sync", "--json", "--host", "https://worker.example"], fetch);
        assert.strictEqual(yield* first.effect, EXIT.OK);
        const output = JSON.parse(first.stdout.join(""));
        assert.deepStrictEqual(Object.keys(output), ["digest", "items"]);
        assert.deepStrictEqual(output.items, [
          { kind: "extension", name: "fixture-extension.ts" },
          { kind: "package", name: "pi-subagents" },
          { kind: "skill", name: "fixture-skill" },
          { kind: "tool", name: "fixture-tool" },
        ]);
        assert.match(output.digest, /^[0-9a-f]{64}$/u);
        assert.strictEqual(first.stderr.join(""), "");

        const second = run(home, ["sync", "--json", "--host", "https://worker.example"], fetch);
        assert.strictEqual(yield* second.effect, EXIT.OK);
        assert.deepStrictEqual(JSON.parse(second.stdout.join("")), output);
        assert.strictEqual(putCalls, 1);
      }),
    ),
  );

  it.effect("builds the TOML bundle before resolving remote credentials", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        yield* writeFixture(home);
        yield* Effect.promise(() => writeFile(join(home, "tools", "auth.json"), "{}"));
        let fetchCalls = 0;
        const invocation = run(
          home,
          ["sync", "--json", "--host", "https://worker.example", "--token-file", "missing-token"],
          async () => {
            fetchCalls += 1;
            return new Response();
          },
        );
        const result = yield* Effect.result(invocation.effect);
        assert.ok(Result.isFailure(result));
        assert.include(result.failure.message, "credential files");
        assert.notInclude(result.failure.message, "token file");
        assert.strictEqual(fetchCalls, 0);
        assert.strictEqual(invocation.stdout.join(""), "");
        assert.strictEqual(invocation.stderr.join(""), "");
      }),
    ),
  );
  it.effect("prints the exact embedded skill text and minimal JSON shape", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const scottySkillContent = yield* Effect.promise(() =>
          readFile(join(import.meta.dirname, "..", "..", "skills", "scotty", "SKILL.md"), "utf8"),
        );
        const human = run(home, ["skill", "show"], async () => new Response(), true);
        assert.strictEqual(yield* human.effect, EXIT.OK);
        assert.strictEqual(human.stdout.join(""), scottySkillContent);

        const json = run(home, ["skill", "show", "--json"], async () => new Response());
        assert.strictEqual(yield* json.effect, EXIT.OK);
        assert.deepStrictEqual(JSON.parse(json.stdout.join("")), {
          name: "scotty",
          content: scottySkillContent,
        });
      }),
    ),
  );
});
