import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import type { CredentialGrant } from "../../../../protocol/credentials";
import { CODEX_VERSION } from "../../../../protocol/codex-app-server";
import {
  admitCodexSandbox,
  interruptCodexSandbox,
  readCodexSandbox,
  sendCodexSandboxMessage,
  startCodexSandbox,
  type CodexSandboxIdentity,
} from "../../../src/agent/codex/sandbox";
import { sandboxRuntimeLayer } from "../../../src/sandbox/runtime";
import { sandboxRuntimeCapabilitiesFake } from "../../support";

const identity: CodexSandboxIdentity = {
  sessionId: "a0b1c2d3e4f5",
  generation: "generation-1",
  token: "a".repeat(64),
  selection: { agent: "codex", model: "gpt-5.4", effort: "high" },
};
const grant: CredentialGrant = {
  name: "codex",
  kind: "pi-auth",
  versionRef: "version-1",
  handleSlots: [{ provider: "openai-codex", slot: "access" }],
  expires: 1000,
};
const snapshot = {
  generation: identity.generation,
  threadId: "thread-1",
  version: CODEX_VERSION,
  settings: {
    model: "gpt-5.4",
    effort: "high",
    workspace: "/workspace/a0b1c2d3e4f5",
    modelProvider: "scotty-managed",
    approvalPolicy: "never",
    sandbox: "dangerFullAccess",
  },
  ready: true,
  failure: null,
  cleanup: null,
  prompt: { status: "idle" },
};

describe("Codex Sandbox adapter", () => {
  for (const stalled of ["fetch", "body"] as const) {
    it.effect(`snapshot deadline cancels stalled ${stalled} I/O`, () =>
      Effect.gen(function* () {
        let cancelled = 0;
        let requestSignal: AbortSignal | undefined;
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled += 1;
          },
        });
        const layer = sandboxRuntimeLayer({
          ...sandboxRuntimeCapabilitiesFake(),
          fetchPort: (_path, _port, _method, _headers, _body, signal) => {
            requestSignal = signal;
            if (stalled === "body") return Promise.resolve(new Response(stream));
            return new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        });
        const fiber = yield* readCodexSandbox(identity).pipe(
          Effect.provide(layer),
          Effect.result,
          Effect.forkChild,
        );
        yield* TestClock.adjust(5001);
        const result = yield* Fiber.join(fiber);
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.message, "Codex snapshot deadline exceeded");
        assert.equal(requestSignal?.aborted, stalled === "fetch");
        assert.equal(cancelled, stalled === "body" ? 1 : 0);
        assert.isFalse(stream.locked);
      }),
    );
  }

  it.effect("interrupted admission waiter reconciles without posting again", () =>
    Effect.gen(function* () {
      let posts = 0;
      const entered = yield* Deferred.make<void>();
      let signal: AbortSignal | undefined;
      const layer = sandboxRuntimeLayer({
        ...sandboxRuntimeCapabilitiesFake(),
        fetchPort: (_path, _port, method, _headers, _body, requestSignal) => {
          if (method === "POST") {
            posts += 1;
            signal = requestSignal;
            Deferred.doneUnsafe(entered, Effect.void);
            return new Promise<Response>((_resolve, reject) => {
              requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), {
                once: true,
              });
            });
          }
          return Promise.resolve(
            Response.json({
              ...snapshot,
              prompt: posts === 0 ? { status: "idle" } : { status: "running", turnId: "turn-1" },
            }),
          );
        },
      });
      const waiter = yield* admitCodexSandbox(identity, "thread-1", "one prompt", false).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(waiter);
      assert.isTrue(signal?.aborted);
      const reconciled = yield* admitCodexSandbox(identity, "thread-1", "one prompt", true).pipe(
        Effect.provide(layer),
      );
      assert.equal(reconciled.turnId, "turn-1");
      assert.equal(posts, 1);
    }),
  );
  it.effect("provisions fresh private paths and launches only sentinel plus expiry", () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const files: Array<{ path: string; content: unknown }> = [];
      let launch = "";
      const base = sandboxRuntimeCapabilitiesFake();
      const layer = sandboxRuntimeLayer({
        ...base,
        exec: (command, options) => {
          commands.push(command);
          return base.exec(command, options);
        },
        writeFile: (path, content) => {
          files.push({ path, content });
          return Promise.resolve();
        },
        startProcess: (command) => {
          launch = command;
          return Promise.resolve({
            id: "scotty-codex-generation-1",
            status: "running" as const,
            kill: () => Promise.resolve(),
            waitForExit: () => Promise.resolve({ exitCode: 0 }),
            waitForPort: () => Promise.resolve(),
          });
        },
      });
      const processId = yield* startCodexSandbox(identity, [grant]).pipe(Effect.provide(layer));
      assert.equal(processId, "scotty-codex-generation-1");
      assert.include(commands[0], "umask 077 && mkdir");
      assert.notInclude(commands[0], "mkdir -p");
      assert.deepEqual(files, [
        { path: "/tmp/scotty-codex-generation-1/control.token", content: identity.token },
      ]);
      assert.include(commands[1], "chmod 600");
      assert.include(launch, "/usr/local/bin/scotty-codex-server");
      assert.include(launch, '"runtimeDir":"/tmp/scotty-codex-generation-1/runtime"');
      assert.include(launch, '"model":"gpt-5.4","effort":"high"');
      assert.include(launch, '"expiresAt":1000');
      assert.notInclude(launch, identity.token);
      assert.notInclude(launch, "auth.json");
    }),
  );

  it.effect(
    "rejects missing, ambiguous, expired and wrong-slot grants before process or file effects",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const layer = sandboxRuntimeLayer({
          ...sandboxRuntimeCapabilitiesFake(),
          exec: () => {
            calls += 1;
            return Promise.reject(new Error("unexpected exec"));
          },
        });
        for (const grants of [
          [],
          [grant, { ...grant, name: "second" }],
          [{ ...grant, expires: 0 }],
          [{ ...grant, handleSlots: [{ provider: "openai", slot: "api-key" }] as const }],
        ]) {
          const result = yield* startCodexSandbox(identity, grants).pipe(
            Effect.provide(layer),
            Effect.result,
          );
          assert.isTrue(Result.isFailure(result));
        }
        assert.equal(calls, 0);
      }),
  );

  it.effect("rejects malformed generations before private path provisioning", () =>
    Effect.gen(function* () {
      const result = yield* startCodexSandbox({ ...identity, generation: "../workspace" }, [
        grant,
      ]).pipe(Effect.provide(sandboxRuntimeLayer(sandboxRuntimeCapabilitiesFake())), Effect.result);
      assert.isTrue(Result.isFailure(result));
    }),
  );

  for (const changed of [
    { generation: "stale" },
    { threadId: "wrong-thread" },
    { settings: { ...snapshot.settings, effort: "low" } },
    { settings: { ...snapshot.settings, model: "gpt-5.2" } },
  ]) {
    it.effect(`rejects mismatched native proof ${JSON.stringify(changed)}`, () =>
      Effect.gen(function* () {
        let posts = 0;
        const layer = sandboxRuntimeLayer({
          ...sandboxRuntimeCapabilitiesFake(),
          fetchPort: (_path, _port, method) => {
            if (method === "POST") posts += 1;
            return Promise.resolve(Response.json({ ...snapshot, ...changed }));
          },
        });
        const result = yield* admitCodexSandbox(identity, "thread-1", "one prompt", false).pipe(
          Effect.provide(layer),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        assert.equal(posts, 0);
      }),
    );
  }

  it.effect("does not replay an idle or admitting snapshot during reconciliation", () =>
    Effect.gen(function* () {
      let posts = 0;
      for (const status of ["idle", "admitting"]) {
        const layer = sandboxRuntimeLayer({
          ...sandboxRuntimeCapabilitiesFake(),
          fetchPort: (_path, _port, method) => {
            if (method === "POST") posts += 1;
            return Promise.resolve(Response.json({ ...snapshot, prompt: { status } }));
          },
        });
        const result = yield* admitCodexSandbox(identity, "thread-1", "one prompt", true).pipe(
          Effect.provide(layer),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
      }
      assert.equal(posts, 0);
    }),
  );

  it.effect("reconciles a lost POST and snapshot response without a second admission", () =>
    Effect.gen(function* () {
      let admitted = false;
      let posts = 0;
      let loseSnapshot = true;
      const layer = sandboxRuntimeLayer({
        ...sandboxRuntimeCapabilitiesFake(),
        fetchPort: (_path, _port, method) => {
          if (method === "POST") {
            posts += 1;
            admitted = true;
            return Promise.reject(new Error("lost reply"));
          }
          if (admitted && loseSnapshot) {
            loseSnapshot = false;
            return Promise.reject(new Error("snapshot unavailable"));
          }
          return Promise.resolve(
            Response.json({
              ...snapshot,
              prompt: admitted ? { status: "running", turnId: "turn-1" } : { status: "idle" },
            }),
          );
        },
      });
      const first = yield* admitCodexSandbox(identity, "thread-1", "one prompt", false).pipe(
        Effect.provide(layer),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(first));
      const reconciled = yield* admitCodexSandbox(identity, "thread-1", "one prompt", true).pipe(
        Effect.provide(layer),
      );
      assert.equal(reconciled.turnId, "turn-1");
      assert.equal(posts, 1);
    }),
  );

  it.effect("preserves a lost message reply as a typed post-dispatch ambiguity", () =>
    Effect.gen(function* () {
      let posts = 0;
      const layer = sandboxRuntimeLayer({
        ...sandboxRuntimeCapabilitiesFake(),
        fetchPort: (path, _port, method) => {
          if (path === "/message" && method === "POST") {
            posts += 1;
            return Promise.reject(new Error("lost reply"));
          }
          return Promise.resolve(
            Response.json({ ...snapshot, prompt: { status: "running", turnId: "turn-1" } }),
          );
        },
      });
      const result = yield* sendCodexSandboxMessage(
        identity,
        "thread-1",
        "adjust",
        "message-1",
      ).pipe(Effect.provide(layer), Effect.result);
      assert.ok(Result.isFailure(result));
      assert.isTrue(Predicate.isTagged(result.failure, "CodexMessageAdmissionUnknown"));
      assert.equal(posts, 1);
    }),
  );

  it.effect("requires the expected active turn and reconciles a native interruption", () =>
    Effect.gen(function* () {
      let snapshotReads = 0;
      let posts = 0;
      const layer = sandboxRuntimeLayer({
        ...sandboxRuntimeCapabilitiesFake(),
        fetchPort: (path, _port, method) => {
          if (path === "/snapshot") {
            snapshotReads += 1;
            return Promise.resolve(
              Response.json({
                ...snapshot,
                prompt:
                  snapshotReads === 1
                    ? { status: "running", turnId: "turn-1" }
                    : {
                        status: "terminal",
                        turnId: "turn-1",
                        outcome: "interrupted",
                        text: "",
                      },
              }),
            );
          }
          if (path === "/interrupt" && method === "POST") {
            posts += 1;
            return Promise.resolve(
              Response.json(
                {
                  generation: identity.generation,
                  threadId: "thread-1",
                  turnId: "turn-1",
                  status: "interrupted",
                },
                { status: 202 },
              ),
            );
          }
          return Promise.reject(new Error("unexpected Codex request"));
        },
      });
      const result = yield* interruptCodexSandbox(identity, "thread-1", "turn-1").pipe(
        Effect.provide(layer),
      );
      assert.equal(result.outcome, "interrupted");
      assert.equal(result.snapshot.prompt.status, "terminal");
      assert.equal(posts, 1);
      assert.equal(snapshotReads, 2);
    }),
  );

  it.effect("does not report accepted when completion wins the interrupt race", () =>
    Effect.gen(function* () {
      let snapshotReads = 0;
      const layer = sandboxRuntimeLayer({
        ...sandboxRuntimeCapabilitiesFake(),
        fetchPort: (path, _port, method) => {
          if (path === "/snapshot")
            return Promise.resolve(
              Response.json({
                ...snapshot,
                prompt:
                  snapshotReads++ === 0
                    ? { status: "running", turnId: "turn-1" }
                    : {
                        status: "terminal",
                        turnId: "turn-1",
                        outcome: "completed",
                        text: "done",
                      },
              }),
            );
          if (path === "/interrupt" && method === "POST")
            return Promise.resolve(
              Response.json(
                {
                  generation: identity.generation,
                  threadId: "thread-1",
                  turnId: "turn-1",
                  status: "completed",
                },
                { status: 202 },
              ),
            );
          return Promise.reject(new Error("unexpected Codex request"));
        },
      });
      const result = yield* interruptCodexSandbox(identity, "thread-1", "turn-1").pipe(
        Effect.provide(layer),
      );
      assert.equal(result.outcome, "completed");
      assert.equal(result.snapshot.prompt.status, "terminal");
      assert.equal(snapshotReads, 2);
    }),
  );

  for (const failureMode of [
    "ambiguous-response",
    "malformed-admission",
    "post-admission-read",
  ] as const)
    it.effect(`preserves ${failureMode} as a typed post-dispatch ambiguity`, () =>
      Effect.gen(function* () {
        let posts = 0;
        let snapshotReads = 0;
        const layer = sandboxRuntimeLayer({
          ...sandboxRuntimeCapabilitiesFake(),
          fetchPort: (path, _port, method) => {
            if (path === "/snapshot") {
              snapshotReads += 1;
              if (failureMode === "post-admission-read" && snapshotReads === 2)
                return Promise.reject(new Error("post-admission snapshot unavailable"));
              return Promise.resolve(
                Response.json({ ...snapshot, prompt: { status: "running", turnId: "turn-1" } }),
              );
            }
            if (path === "/message" && method === "POST") {
              posts += 1;
              if (failureMode === "ambiguous-response")
                return Promise.resolve(
                  Response.json({ error: "host_failed", outcome: "ambiguous" }, { status: 502 }),
                );
              if (failureMode === "malformed-admission")
                return Promise.resolve(Response.json({ malformed: true }, { status: 202 }));
              return Promise.resolve(
                Response.json(
                  { generation: identity.generation, threadId: "thread-1", turnId: "turn-1" },
                  { status: 202 },
                ),
              );
            }
            return Promise.reject(new Error("unexpected Codex request"));
          },
        });
        const result = yield* sendCodexSandboxMessage(
          identity,
          "thread-1",
          "adjust",
          `message-${failureMode}`,
        ).pipe(Effect.provide(layer), Effect.result);
        assert.ok(Result.isFailure(result));
        assert.isTrue(Predicate.isTagged(result.failure, "CodexMessageAdmissionUnknown"));
        assert.equal(posts, 1);
        assert.equal(snapshotReads, failureMode === "post-admission-read" ? 2 : 1);
      }),
    );

  it.effect("bounds untrusted snapshots", () =>
    Effect.gen(function* () {
      const result = yield* readCodexSandbox(identity).pipe(
        Effect.provide(
          sandboxRuntimeLayer({
            ...sandboxRuntimeCapabilitiesFake(),
            fetchPort: () => Promise.resolve(new Response("x".repeat(512 * 1024 + 1))),
          }),
        ),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result));
    }),
  );
});
