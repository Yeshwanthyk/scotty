import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { execute } from "../src/commands";
import { EXIT } from "../src/core";
import { cliLayer, type CliDependencies } from "../src/dependencies";
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
  processRun?: CliDependencies["run"],
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
          ...(processRun === undefined ? {} : { run: processRun }),
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
        const registryBodies: string[] = [];
        const calls: string[] = [];
        const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          calls.push(path);
          if (path === "/api/credentials/sync") {
            registryBodies.push(await request.text());
            return Response.json({ credentials: [] });
          }
          if (path === "/api/sandbox/configuration")
            return Response.json({ revision: 0, activeDigest });
          putCalls += 1;
          activeDigest = path.slice(path.lastIndexOf("/") + 1);
          return Response.json({ revision: 1, activeDigest });
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
        assert.deepStrictEqual(JSON.parse(registryBodies[0] ?? "{}"), {
          credentials: [],
        });
        assert.deepStrictEqual(calls, [
          "/api/credentials/sync",
          "/api/sandbox/configuration",
          `/api/sandbox/bundles/${output.digest}`,
        ]);

        const second = run(home, ["sync", "--json", "--host", "https://worker.example"], fetch);
        assert.strictEqual(yield* second.effect, EXIT.OK);
        assert.deepStrictEqual(JSON.parse(second.stdout.join("")), output);
        assert.strictEqual(putCalls, 1);
        assert.deepStrictEqual(JSON.parse(registryBodies[1] ?? "{}"), {
          credentials: [],
        });
        assert.deepStrictEqual(calls, [
          "/api/credentials/sync",
          "/api/sandbox/configuration",
          `/api/sandbox/bundles/${output.digest}`,
          "/api/credentials/sync",
          "/api/sandbox/configuration",
        ]);
      }),
    ),
  );

  it.effect("publishes Pi auth before the bundle and keeps the output redacted", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        yield* writeFixture(home);
        const authPath = join(home, ".pi", "agent", "auth.json");
        yield* Effect.promise(() => mkdir(join(home, ".pi", "agent"), { recursive: true }));
        const providerSecret = "pi-provider-secret";
        yield* Effect.promise(() =>
          writeFile(
            authPath,
            JSON.stringify({ openai: { type: "api_key", key: providerSecret } }),
            { mode: 0o600 },
          ),
        );
        const configPath = scottyTomlConfigPath(home);
        const config = yield* Effect.promise(() => readFile(configPath, "utf8"));
        yield* Effect.promise(() =>
          writeFile(
            configPath,
            `${config}[credentials.openai]\nkind = "pi-auth"\nsource = ${JSON.stringify(authPath)}\nscope = "global"\n`,
            { mode: 0o600 },
          ),
        );

        const calls: string[] = [];
        let registryBody: string | undefined;
        let failRegistry = false;
        let activeDigest: string | null = null;
        const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          calls.push(path);
          if (path === "/api/credentials/sync") {
            registryBody = await request.text();
            if (failRegistry)
              return new Response(
                JSON.stringify({ error: { code: "upstream", message: "registry-secret" } }),
                { status: 502, headers: { "content-type": "application/json" } },
              );
            return Response.json({
              credentials: [{ name: "openai", kind: "pi-auth", scope: "global", configured: true }],
            });
          }
          if (path === "/api/sandbox/configuration")
            return Response.json({ revision: 0, activeDigest });
          activeDigest = path.slice(path.lastIndexOf("/") + 1);
          return Response.json({ revision: 1, activeDigest });
        };

        const invocation = run(home, ["sync", "--json", "--host", "https://worker.example"], fetch);
        assert.strictEqual(yield* invocation.effect, EXIT.OK);
        const output = JSON.parse(invocation.stdout.join(""));
        assert.deepStrictEqual(Object.keys(output), ["digest", "items"]);
        assert.strictEqual(
          JSON.parse(registryBody ?? "{}").credentials[0].providers.openai.key,
          providerSecret,
        );
        assert.notInclude(invocation.stdout.join(""), providerSecret);
        assert.deepStrictEqual(calls, [
          "/api/credentials/sync",
          "/api/sandbox/configuration",
          `/api/sandbox/bundles/${output.digest}`,
        ]);

        failRegistry = true;
        const failed = run(home, ["sync", "--json", "--host", "https://worker.example"], fetch);
        const failure = yield* Effect.result(failed.effect);
        assert.ok(Result.isFailure(failure));
        assert.strictEqual(failure.failure.code, "credential_registry_sync_failed");
        assert.notInclude(failure.failure.message, "registry-secret");
        assert.notInclude(failed.stderr.join(""), "registry-secret");
        assert.deepStrictEqual(calls.slice(-1), ["/api/credentials/sync"]);
      }),
    ),
  );

  it.effect("resolves GitHub CLI credentials locally before one complete registry sync", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        yield* writeFixture(home);
        const configPath = scottyTomlConfigPath(home);
        const config = yield* Effect.promise(() => readFile(configPath, "utf8"));
        yield* Effect.promise(() =>
          writeFile(
            configPath,
            `${config.replace("allowed = []", 'allowed = ["owner/repo"]')}[credentials.github]\nkind = "github-cli"\nscope = "repository"\nrepositories = ["owner/repo"]\n`,
            { mode: 0o600 },
          ),
        );
        const calls: string[] = [];
        let registryBody: unknown;
        const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          calls.push(path);
          if (path === "/api/credentials/sync") {
            registryBody = JSON.parse(await request.text());
            return Response.json({
              credentials: [
                {
                  name: "github",
                  kind: "github-cli",
                  scope: "repository",
                  repositories: ["owner/repo"],
                  configured: true,
                },
              ],
            });
          }
          if (path === "/api/sandbox/configuration")
            return Response.json({ revision: 0, activeDigest: null });
          return Response.json({
            revision: 1,
            activeDigest: path.slice(path.lastIndexOf("/") + 1),
          });
        };
        const processCalls: Array<ReadonlyArray<string>> = [];
        const processRun: CliDependencies["run"] = async (command) => {
          processCalls.push(command);
          return { exitCode: 0, stdout: "github-token-local\n", stderr: "" };
        };
        const invocation = run(
          home,
          ["sync", "--json", "--host", "https://worker.example"],
          fetch,
          false,
          processRun,
        );
        assert.strictEqual(yield* invocation.effect, EXIT.OK);
        assert.deepStrictEqual(processCalls, [["gh", "auth", "token"]]);
        assert.deepStrictEqual(registryBody, {
          credentials: [
            {
              name: "github",
              kind: "github-cli",
              scope: "repository",
              repositories: ["owner/repo"],
              token: "github-token-local",
            },
          ],
        });
        assert.notInclude(invocation.stdout.join(""), "github-token-local");
        assert.deepStrictEqual(calls, [
          "/api/credentials/sync",
          "/api/sandbox/configuration",
          `/api/sandbox/bundles/${JSON.parse(invocation.stdout.join("")).digest}`,
        ]);
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
  it.effect("lists and prints exact embedded skill text with stable JSON shapes", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const scottySkillContent = yield* Effect.promise(() =>
          readFile(join(import.meta.dirname, "..", "..", "skills", "scotty", "SKILL.md"), "utf8"),
        );
        const liveSkillContent = yield* Effect.promise(() =>
          readFile(
            join(
              import.meta.dirname,
              "..",
              "..",
              "skills",
              "scotty-live-observability",
              "SKILL.md",
            ),
            "utf8",
          ),
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

        const live = run(
          home,
          ["skill", "show", "scotty-live-observability", "--json"],
          async () => new Response(),
        );
        assert.strictEqual(yield* live.effect, EXIT.OK);
        assert.deepStrictEqual(JSON.parse(live.stdout.join("")), {
          name: "scotty-live-observability",
          content: liveSkillContent,
        });

        const list = run(home, ["skill", "list", "--json"], async () => new Response());
        assert.strictEqual(yield* list.effect, EXIT.OK);
        assert.deepStrictEqual(JSON.parse(list.stdout.join("")), {
          skills: ["scotty", "scotty-live-observability"],
        });

        const humanList = run(home, ["skill", "list"], async () => new Response(), true);
        assert.strictEqual(yield* humanList.effect, EXIT.OK);
        assert.strictEqual(humanList.stdout.join(""), "scotty\nscotty-live-observability\n");
      }),
    ),
  );
});
