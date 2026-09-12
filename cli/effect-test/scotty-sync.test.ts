import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { execute } from "../src/commands";
import { EXIT } from "../src/core";
import { cliLayer, type CliDependencies } from "../src/dependencies";

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
  it.effect("retains repository scope when refreshing the existing GitHub credential", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        let body: unknown;
        const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === "/api/credentials")
            return Response.json([
              {
                name: "github",
                kind: "github-cli",
                scope: "repository",
                repositories: ["owner/scotty", "owner/ziggy"],
                configured: true,
                versionRef: "v1",
              },
            ]);
          body = JSON.parse(await request.text());
          return Response.json({
            name: "github",
            kind: "github-cli",
            scope: "repository",
            repositories: ["owner/scotty", "owner/ziggy"],
            configured: true,
            versionRef: "v2",
          });
        };
        const invocation = run(
          home,
          ["sync", "--json", "--host", "https://worker.example", "--github"],
          fetch,
          false,
          async () => ({ exitCode: 0, stdout: "github-secret\n", stderr: "" }),
        );
        assert.strictEqual(yield* invocation.effect, EXIT.OK);
        assert.deepStrictEqual(body, {
          credential: {
            name: "github",
            kind: "github-cli",
            scope: "repository",
            repositories: ["owner/scotty", "owner/ziggy"],
            token: "github-secret",
          },
          expectedVersionRef: "v1",
        });
        assert.notInclude(invocation.stdout.join(""), "github-secret");
      }),
    ),
  );
  it.effect("refreshes only explicitly selected local credentials", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const authPath = join(home, ".pi", "agent", "auth.json");
        yield* Effect.promise(() => mkdir(join(home, ".pi", "agent"), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            authPath,
            JSON.stringify({
              openai: { type: "api_key", key: "pi-provider-secret" },
            }),
            { mode: 0o600 },
          ),
        );
        let body: unknown;
        const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === "/api/credentials") return Response.json([]);
          if (path !== "/api/credentials/pi") return Response.json({});
          body = JSON.parse(await request.text());
          return Response.json({
            name: "pi",
            kind: "pi-auth",
            scope: "global",
            configured: true,
            versionRef: "v1",
          });
        };
        const invocation = run(
          home,
          ["sync", "--json", "--host", "https://worker.example", "--pi-auth", authPath],
          fetch,
        );
        assert.strictEqual(yield* invocation.effect, EXIT.OK);
        assert.deepStrictEqual(JSON.parse(invocation.stdout.join("")), {
          credentials: [
            { name: "pi", kind: "pi-auth", scope: "global", configured: true, versionRef: "v1" },
          ],
        });
        assert.deepStrictEqual(body, {
          credential: {
            name: "pi",
            kind: "pi-auth",
            scope: "global",
            providers: { openai: { type: "api_key", key: "pi-provider-secret" } },
          },
        });
        assert.notInclude(invocation.stdout.join(""), "pi-provider-secret");
      }),
    ),
  );

  it.effect(
    "switches the sole agent credential to Codex without creating a second registry entry",
    () =>
      withTempDirectory((home) =>
        Effect.gen(function* () {
          const authPath = join(home, "auth.json");
          yield* Effect.promise(() =>
            writeFile(
              authPath,
              JSON.stringify({
                tokens: {
                  access_token: "access-secret",
                  refresh_token: "refresh-secret",
                  expires: 1999999999999,
                },
              }),
              { mode: 0o600 },
            ),
          );
          let body: unknown;
          let path = "";
          const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const request = new Request(input, init);
            path = new URL(request.url).pathname;
            if (path === "/api/credentials")
              return Response.json([
                {
                  name: "pi",
                  kind: "pi-auth",
                  scope: "global",
                  configured: true,
                  versionRef: "v1",
                },
              ]);
            body = JSON.parse(await request.text());
            return Response.json({
              name: "pi",
              kind: "pi-auth",
              scope: "global",
              configured: true,
              versionRef: "v2",
            });
          };
          const invocation = run(
            home,
            ["sync", "--host", "https://worker.example", "--codex-auth", authPath],
            fetch,
          );
          assert.strictEqual(yield* invocation.effect, EXIT.OK);
          assert.strictEqual(path, "/api/credentials/pi");
          assert.deepStrictEqual(body, {
            credential: {
              name: "pi",
              kind: "pi-auth",
              scope: "global",
              providers: {
                "openai-codex": {
                  type: "oauth",
                  access: "access-secret",
                  refresh: "refresh-secret",
                  expires: 1999999999999,
                },
              },
            },
            expectedVersionRef: "v1",
          });
          assert.notInclude(invocation.stdout.join(""), "refresh-secret");
        }),
      ),
  );

  it.effect("rejects simultaneous Pi and Codex auth sources before contacting the vault", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const invocation = run(
          home,
          ["sync", "--host", "https://worker.example", "--pi-auth", "a", "--codex-auth", "b"],
          async () => {
            assert.fail("vault must not be called");
          },
        );
        const error = yield* invocation.effect.pipe(Effect.flip);
        assert.strictEqual(error.exitCode, EXIT.USAGE);
        assert.include(error.message, "Choose either --pi-auth or --codex-auth");
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
