import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import {
  agentEnv,
  ContainerAuth,
  containerAuthLayer,
  PI_SESSION_PROCESS_ID,
  PI_SESSION_TOKEN_HEADER,
  piAuthJson,
  piSessionTransportToken,
  sandboxAgentsInstructions,
} from "../../src/sandbox/auth";
import { sandboxRuntimeLayer, type SandboxRuntimeCapabilities } from "../../src/sandbox/runtime";
import { sandboxRuntimeCapabilitiesFake } from "../support";
import {
  githubManagedHandle,
  managedPiAccessToken,
  piAuthJson as managedPiAuthJson,
  selectPiAuthGrant,
  sessionRuntimeCredentials,
} from "../../src/credentials/managed";
import type { CredentialGrant } from "../../../protocol/credentials";

const PI_EXPIRES = 1_795_000_123_456;

type ProjectedPiAuth = {
  readonly openai: { readonly type: "api_key"; readonly key: string };
  readonly "openai-codex": {
    readonly type: "oauth";
    readonly access: string;
    readonly refresh: string;
    readonly expires: number;
    readonly accountId: string;
  };
};
const SESSION_ID = "a0b1c2d3e4f5";
const grants: ReadonlyArray<CredentialGrant> = [
  {
    name: "codex",
    kind: "pi-auth",
    versionRef: "version-a",
    handleSlots: [
      { provider: "openai", slot: "api-key" },
      { provider: "openai-codex", slot: "access" },
    ],
    expires: PI_EXPIRES,
  },
  {
    name: "github",
    kind: "github-cli",
    versionRef: "version-b",
    handleSlots: [{ provider: "github", slot: "git-https" }],
  },
];
const credentials = sessionRuntimeCredentials(grants);

// Keep this assertion close to the ContainerAuth boundary: native files only receive projections.
describe("container managed credential projection", () => {
  it("directs PR creation through the repository-scoped GitHub REST API", () => {
    assert.include(
      sandboxAgentsInstructions,
      "use the repository-scoped GitHub REST endpoint with `gh api --method POST repos/{owner}/{repo}/pulls`",
    );
    assert.include(sandboxAgentsInstructions, "do not use `gh pr create` or GitHub GraphQL");
  });

  it("projects fixed handles into Pi auth and GitHub environment values", () => {
    const auth = JSON.parse(piAuthJson(credentials)) as ProjectedPiAuth;
    const apiKey = "scotty-managed://codex/openai/api-key";
    const access = "scotty-managed://codex/openai-codex/access";
    const github = "scotty-managed://github/github/git-https";

    assert.deepStrictEqual(auth.openai, { type: "api_key", key: apiKey });
    assert.deepStrictEqual(auth["openai-codex"], {
      type: "oauth",
      access: managedPiAccessToken(access),
      refresh: access,
      expires: PI_EXPIRES,
      accountId: "scotty-managed",
    });
    assert.strictEqual(githubManagedHandle(grants), github);
    assert.strictEqual(agentEnv(SESSION_ID, credentials).GH_TOKEN, github);
    assert.ok(!JSON.stringify(auth).includes("plaintext"));
    assert.ok(!JSON.stringify(auth).includes("/refresh"));
  });

  it("projects an empty grant selection without ambient credential fallbacks", () => {
    const empty = sessionRuntimeCredentials([]);
    assert.deepStrictEqual(JSON.parse(managedPiAuthJson(empty)), {});
    const env = agentEnv(SESSION_ID, empty);
    assert.strictEqual(env.GH_TOKEN, undefined);
  });

  it("rejects multiple Pi grants while preserving single-grant selection", () => {
    const piGrant = grants[0];
    assert.ok(piGrant !== undefined);
    const alternate = { ...piGrant, name: "alternate", versionRef: "version-c" };

    assert.deepStrictEqual(selectPiAuthGrant([piGrant]), Result.succeed(piGrant));
    assert.deepStrictEqual(selectPiAuthGrant([piGrant, alternate]), Result.fail("ambiguous"));
    assert.deepStrictEqual(selectPiAuthGrant([alternate, piGrant]), Result.fail("ambiguous"));
  });
});

describe("Pi session production observations", () => {
  it.effect("refreshes the native terminal launcher as an interactive workspace shell", () =>
    Effect.gen(function* () {
      const writes: Array<{ readonly path: string; readonly content: string }> = [];
      const commands: string[] = [];
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        exec: async (command) => {
          commands.push(command);
          return {
            success: true,
            stdout: "",
            stderr: "",
            exitCode: 0,
            command,
            duration: 1,
            timestamp: "2026-09-04T00:00:00.000Z",
          };
        },
        writeFile: async (path, content) => {
          if (typeof content === "string") writes.push({ path, content });
        },
      };
      const runtimeLayer = sandboxRuntimeLayer(capabilities);
      const layer = Layer.merge(runtimeLayer, containerAuthLayer.pipe(Layer.provide(runtimeLayer)));

      yield* Effect.flatMap(ContainerAuth, (auth) =>
        auth.ensureTerminal(SESSION_ID, credentials),
      ).pipe(Effect.provide(layer));

      assert.strictEqual(writes.length, 1);
      assert.strictEqual(writes[0]?.path, `/workspace/${SESSION_ID}/.pi-agent/scotty-shell`);
      assert.include(writes[0]?.content ?? "", `cd '/workspace/${SESSION_ID}'`);
      assert.include(writes[0]?.content ?? "", "exec /bin/bash --noprofile --norc -i");
      assert.notInclude(writes[0]?.content ?? "", "scotty-pi-shell");
      assert.ok(commands.some((command) => command.startsWith("chmod 700 ")));
    }),
  );

  it.effect("preserves legacy ensure readiness as an HTTP 200 process wait", () =>
    Effect.gen(function* () {
      let waitCalls = 0;
      let fetchCalls = 0;
      const process = {
        id: PI_SESSION_PROCESS_ID,
        status: "running" as const,
        kill: () => Promise.resolve(),
        waitForExit: () => Promise.resolve({ exitCode: 0 }),
        waitForPort: () => {
          waitCalls += 1;
          return Promise.resolve();
        },
      };
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        getProcess: () => Promise.resolve(process),
        fetchPort: () => {
          fetchCalls += 1;
          return Promise.resolve(new Response("legacy-ok", { status: 200 }));
        },
      };
      const runtimeLayer = sandboxRuntimeLayer(capabilities);
      const layer = Layer.merge(runtimeLayer, containerAuthLayer.pipe(Layer.provide(runtimeLayer)));

      yield* Effect.flatMap(ContainerAuth, (auth) =>
        auth.ensurePiSession(SESSION_ID, credentials),
      ).pipe(Effect.provide(layer));

      assert.strictEqual(waitCalls, 1);
      assert.strictEqual(fetchCalls, 0);
    }),
  );

  it.effect(
    "splits process admission from decoded health and authenticated snapshot readiness",
    () =>
      Effect.gen(function* () {
        const calls: Array<
          readonly [string, number, string, Readonly<Record<string, string>> | undefined]
        > = [];
        const process = {
          id: PI_SESSION_PROCESS_ID,
          status: "running" as const,
          kill: () => Promise.resolve(),
          waitForExit: () => Promise.resolve({ exitCode: 0 }),
          waitForPort: () => Promise.resolve(),
        };
        const capabilities: SandboxRuntimeCapabilities = {
          ...sandboxRuntimeCapabilitiesFake(),
          getProcess: () => Promise.resolve(process),
          fetchPort: (path, port, method, headers) => {
            calls.push([path, port, method, headers]);
            return Promise.resolve(
              Response.json(
                path === "/health"
                  ? { status: "ready", epoch: "epoch-1" }
                  : { epoch: "epoch-1", state: {}, messages: [] },
              ),
            );
          },
        };
        const runtimeLayer = sandboxRuntimeLayer(capabilities);
        const layer = Layer.merge(
          runtimeLayer,
          containerAuthLayer.pipe(Layer.provide(runtimeLayer)),
        );
        const program = Effect.gen(function* () {
          const auth = yield* ContainerAuth;
          assert.strictEqual(
            yield* auth.startPiSession(SESSION_ID, credentials),
            PI_SESSION_PROCESS_ID,
          );
          assert.deepStrictEqual(yield* auth.readPiSessionHealth(SESSION_ID), {
            processId: PI_SESSION_PROCESS_ID,
            epoch: "epoch-1",
          });
          assert.deepStrictEqual(yield* auth.verifyPiSessionSnapshot(SESSION_ID, "epoch-1"), {
            processId: PI_SESSION_PROCESS_ID,
            epoch: "epoch-1",
          });
        });

        yield* Effect.provide(program, layer);

        const token = yield* Effect.promise(() => piSessionTransportToken(SESSION_ID));
        assert.deepStrictEqual(calls, [
          ["/health", 43_117, "GET", undefined],
          ["/snapshot", 43_117, "GET", { [PI_SESSION_TOKEN_HEADER]: token }],
        ]);
      }),
  );

  it.effect("rejects a snapshot from a different supervisor epoch", () =>
    Effect.gen(function* () {
      const process = {
        id: PI_SESSION_PROCESS_ID,
        status: "running" as const,
        kill: () => Promise.resolve(),
        waitForExit: () => Promise.resolve({ exitCode: 0 }),
        waitForPort: () => Promise.resolve(),
      };
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        getProcess: () => Promise.resolve(process),
        fetchPort: () => Promise.resolve(Response.json({ epoch: "replacement-epoch" })),
      };
      const runtimeLayer = sandboxRuntimeLayer(capabilities);
      const layer = Layer.merge(runtimeLayer, containerAuthLayer.pipe(Layer.provide(runtimeLayer)));
      const result = yield* Effect.result(
        Effect.flatMap(ContainerAuth, (auth) =>
          auth.verifyPiSessionSnapshot(SESSION_ID, "expected-epoch"),
        ).pipe(Effect.provide(layer)),
      );

      assert.ok(Result.isFailure(result));
      assert.strictEqual(result.failure.reason, "nonzero_exit");
      assert.strictEqual(result.failure.message, "Pi session snapshot epoch does not match health");
    }),
  );
});
