import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { execute } from "../src/commands";
import { CliError, EXIT } from "../src/core";
import { cliLayer, type CliDependencies, type CredentialStoreShape } from "../src/services";

const ORIGIN = "https://worker.example";
const CLIENT_ID = "0123456789ab";
const CLIENT_CREDENTIAL = `scotty_client.${CLIENT_ID}.${"a".repeat(32)}`;
const PAIRING_CREDENTIAL = `scotty_pair.abcdef012345.${"b".repeat(32)}`;

const clientView = {
  id: CLIENT_ID,
  label: "terminal",
  scopes: ["sessions:read", "sessions:write"],
  role: "standard",
  createdAt: "2026-08-15T12:00:00.000Z",
  expiresAt: "2026-09-15T12:00:00.000Z",
  lastSeenAt: "2026-08-15T12:01:00.000Z",
};

interface MemoryIdentity {
  client?: string;
  root?: string;
}

const memoryStore = (identity: MemoryIdentity): CredentialStoreShape => ({
  load: (name) => Effect.succeed(identity[name]),
  save: (name, value) =>
    Effect.sync(() => {
      identity[name] = value;
    }),
  remove: (name) =>
    Effect.sync(() => {
      delete identity[name];
    }),
});

const run = (
  args: ReadonlyArray<string>,
  overrides: Partial<CliDependencies> = {},
  identity: MemoryIdentity = {},
) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdin = "";
  const dependencies: Partial<CliDependencies> = {
    env: { SCOTTY_TOKEN: "must-not-be-used", SCOTTY_HOST: "https://ignored.example" },
    home: "/tmp/scotty-client-command-test",
    cwd: "/tmp/scotty-client-command-test",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    readStdin: async () => stdin,
    credentialStore: memoryStore(identity),
    fileSystem: {
      readPrivateText: () => Effect.succeed(`${JSON.stringify({ version: 1, host: ORIGIN })}\n`),
    },
    ...overrides,
  };
  return {
    effect: execute(args).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(cliLayer(dependencies)),
    ),
    identity,
    setStdin: (value: string) => {
      stdin = value;
    },
    stderr,
    stdout,
  };
};

const failure = <A>(result: Result.Result<A, CliError>): CliError => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("PR3 client commands", () => {
  it.effect("registers canonical client commands and removes tui pair", () =>
    Effect.gen(function* () {
      const root = run(["--help"]);
      assert.strictEqual(yield* root.effect, EXIT.OK);
      assert.include(root.stdout.join(""), "client");

      const client = run(["client", "--help"]);
      assert.strictEqual(yield* client.effect, EXIT.OK);
      assert.include(client.stdout.join(""), "pair");
      assert.include(client.stdout.join(""), "status");
      assert.include(client.stdout.join(""), "unpair");

      const tui = run(["tui", "--help"]);
      assert.strictEqual(yield* tui.effect, EXIT.OK);
      assert.notInclude(tui.stdout.join(""), "pair");
    }),
  );

  it.effect("pairs from no-echo input and enforces the exact installation origin", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const paired = run(["client", "pair", ORIGIN], {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Response.json(
            { client: { id: CLIENT_ID } },
            { headers: { "set-cookie": `__Host-scotty=${CLIENT_CREDENTIAL}; Secure; HttpOnly` } },
          );
        },
      });
      paired.setStdin(`${PAIRING_CREDENTIAL}\n`);
      assert.strictEqual(yield* paired.effect, EXIT.OK);
      assert.strictEqual(paired.identity.client, CLIENT_CREDENTIAL);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.headers.get("origin"), ORIGIN);
      assert.strictEqual(requests[0]?.headers.get("sec-fetch-site"), "same-origin");
      const visible = paired.stdout.join("") + paired.stderr.join("");
      assert.notInclude(visible, PAIRING_CREDENTIAL);
      assert.notInclude(visible, CLIENT_CREDENTIAL);

      let fetched = false;
      const mismatched = run(["client", "pair", "https://other.example"], {
        fetch: async () => {
          fetched = true;
          return Response.json({});
        },
      });
      mismatched.setStdin(
        `https://other.example/pair#token=${encodeURIComponent(PAIRING_CREDENTIAL)}\n`,
      );
      const error = failure(yield* Effect.result(mismatched.effect));
      assert.strictEqual(error.code, "bad_usage");
      assert.include(error.message, "exactly match");
      assert.isFalse(fetched);
      assert.strictEqual(mismatched.identity.client, undefined);
    }),
  );

  it.effect("performs a fresh status request and validates the calling client", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const identity = { client: CLIENT_CREDENTIAL };
      const invocation = run(
        ["client", "status"],
        {
          fetch: async (input, init) => {
            requests.push(new Request(input, init));
            return Response.json({
              kind: "client",
              scopes: clientView.scopes,
              client: clientView,
            });
          },
        },
        identity,
      );
      assert.strictEqual(yield* invocation.effect, EXIT.OK);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(new URL(requests[0]?.url ?? "").pathname, "/api/auth/me");
      assert.strictEqual(requests[0]?.headers.get("cookie"), `__Host-scotty=${CLIENT_CREDENTIAL}`);
      assert.strictEqual(requests[0]?.headers.get("authorization"), null);

      const stale = run(
        ["client", "status"],
        {
          fetch: async () =>
            Response.json({
              kind: "client",
              scopes: clientView.scopes,
              client: { ...clientView, id: "fedcba987654" },
            }),
        },
        identity,
      );
      assert.strictEqual(
        failure(yield* Effect.result(stale.effect)).message,
        "Server did not confirm the current client identity",
      );
    }),
  );

  it.effect("uses the client cookie rather than root bearer for normal CLI HTTP", () =>
    Effect.gen(function* () {
      let request: Request | undefined;
      const invocation = run(
        ["ls"],
        {
          fetch: async (input, init) => {
            request = new Request(input, init);
            return Response.json([]);
          },
        },
        { client: CLIENT_CREDENTIAL },
      );
      assert.strictEqual(yield* invocation.effect, EXIT.OK);
      assert.strictEqual(request?.headers.get("cookie"), `__Host-scotty=${CLIENT_CREDENTIAL}`);
      assert.strictEqual(request?.headers.get("authorization"), null);
      assert.strictEqual(new URL(request?.url ?? "").origin, ORIGIN);
    }),
  );

  it.effect("uses paired-client cookies for canonical installation management commands", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const identity = { client: CLIENT_CREDENTIAL };
      for (const args of [
        ["repo", "list"],
        ["env", "list"],
        ["runner", "list"],
      ] as const) {
        const invocation = run(
          args,
          {
            fetch: async (input, init) => {
              const request = new Request(input, init);
              requests.push(request);
              const path = new URL(request.url).pathname;
              return Response.json(
                path === "/api/environment"
                  ? { revision: 0, variables: [], protectedBindings: [] }
                  : [],
              );
            },
          },
          identity,
        );
        assert.strictEqual(yield* invocation.effect, EXIT.OK);
      }
      assert.deepStrictEqual(
        requests.map((request) => ({
          path: new URL(request.url).pathname,
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
        })),
        ["/api/repos", "/api/environment", "/api/runners"].map((path) => ({
          path,
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          authorization: null,
        })),
      );
    }),
  );

  it.effect("unpairs only the calling client and retains identity on an ambiguous response", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const identity = { client: CLIENT_CREDENTIAL };
      const unpaired = run(
        ["client", "unpair"],
        {
          fetch: async (input, init) => {
            requests.push(new Request(input, init));
            return Response.json({ ok: true });
          },
        },
        identity,
      );
      assert.strictEqual(yield* unpaired.effect, EXIT.OK);
      assert.strictEqual(identity.client, undefined);
      assert.deepStrictEqual(
        requests.map((request) => ({
          method: request.method,
          path: new URL(request.url).pathname,
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
          origin: request.headers.get("origin"),
        })),
        [
          {
            method: "POST",
            path: "/api/auth/logout",
            cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
            authorization: null,
            origin: ORIGIN,
          },
        ],
      );

      const retained = { client: CLIENT_CREDENTIAL };
      const ambiguous = run(
        ["client", "unpair"],
        { fetch: async () => Response.json({ ok: false }) },
        retained,
      );
      const error = failure(yield* Effect.result(ambiguous.effect));
      assert.strictEqual(error.code, "invalid_response");
      assert.strictEqual(retained.client, CLIENT_CREDENTIAL);
      const networkRetained = { client: CLIENT_CREDENTIAL };
      const network = run(
        ["client", "unpair"],
        {
          fetch: () => Promise.reject("connection lost after request dispatch"),
        },
        networkRetained,
      );
      assert.strictEqual(failure(yield* Effect.result(network.effect)).code, "network_error");
      assert.strictEqual(networkRetained.client, CLIENT_CREDENTIAL);
    }),
  );
});
