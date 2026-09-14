import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Predicate,
  Queue,
  Result,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  decodeCodexClientMessage,
  CODEX_VERSION,
  decodeCodexDynamicToolResponse,
  decodeCodexNotification,
  type CodexClientMessage,
  type CodexDynamicToolResponse,
} from "../../../../protocol/codex-app-server";
import { makeFramer } from "../../../src/agent/codex/framing";
import { HatchFailure } from "../../../src/agent/codex/first-party-tools";
import { makeSession } from "../../../src/agent/codex/session";
import { makeCodexTools } from "../../../src/agent/codex/tools";
import type { CodexProcess } from "../../../src/agent/codex/process";

type SessionFixtureMode =
  | "normal"
  | "no-initialize"
  | "delayed"
  | "no-initialized-write"
  | "no-thread-response"
  | "no-interrupt-response"
  | "wrong-id"
  | "no-turn-response"
  | "steer-rejected"
  | "steer-malformed"
  | "sandbox"
  | "approval"
  | "durable-start"
  | "durable-resume"
  | "early-turn"
  | "early-wrong-turn"
  | "early-tool"
  | "early-many-advisories"
  | "hold-second-reply"
  | "tool";

const steerResponse = (mode: SessionFixtureMode, id: string | number, expectedTurnId: string) =>
  mode === "steer-rejected"
    ? { id, error: { code: 409, message: "synthetic rejection" } }
    : mode === "steer-malformed"
      ? { id, result: {} }
      : { id, result: { turnId: expectedTurnId } };

const fixture = Effect.fnUntraced(function* (mode: SessionFixtureMode = "normal") {
  const stdout = yield* Queue.bounded<Uint8Array, Cause.Done>(8);
  const exited = yield* Deferred.make<void>();
  let stopped = 0;
  const sent: Array<string> = [];
  const messages: Array<CodexClientMessage> = [];
  const toolResponses = yield* Queue.unbounded<CodexDynamicToolResponse>();
  const secondTurnStarted = yield* Deferred.make<void>();
  const releaseSecondTurn = yield* Deferred.make<void>();
  let turns = 0;
  const emit = (value: unknown) =>
    Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(value)}\n`)).pipe(Effect.asVoid);
  const emitSteerResponse = (message: CodexClientMessage) =>
    message.method === "turn/steer"
      ? emit(steerResponse(mode, message.id, message.params.expectedTurnId))
      : Effect.void;
  const delaysInitialize = (message: CodexClientMessage) =>
    message.method === "initialize" &&
    (mode === "delayed" || mode === "no-thread-response" || mode === "no-initialized-write");
  const emitThreadStart = Effect.fnUntraced(function* (
    message: Extract<CodexClientMessage, { method: "thread/start" }>,
  ) {
    if (mode === "no-thread-response") return;
    if (mode === "delayed") yield* Effect.sleep(70);
    const durable = mode === "durable-start";
    yield* emit({
      id: message.id,
      result: {
        thread: {
          id: "thread",
          ...(durable ? { ephemeral: false, historyMode: "paginated" } : {}),
        },
        model: "gpt-5.2",
        modelProvider: "scotty-managed",
        cwd: "/isolated/workspace",
        approvalPolicy: mode === "approval" ? "on-request" : "never",
        approvalsReviewer: "user",
        sandbox: { type: mode === "sandbox" ? "readOnly" : "dangerFullAccess" },
        reasoningEffort: "high",
      },
    });
  });
  const emitThreadResume = Effect.fnUntraced(function* (
    message: Extract<CodexClientMessage, { method: "thread/resume" }>,
  ) {
    yield* emit({
      id: message.id,
      result: {
        thread: {
          id: "persisted-thread",
          ephemeral: false,
          historyMode: "paginated",
          path: "/private/unstable-rollout.jsonl",
          turns: [{ id: "discarded", items: [] }],
        },
        model: "gpt-5.2",
        modelProvider: "scotty-managed",
        cwd: "/isolated/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: "high",
      },
    });
  });
  const emitThreadRead = Effect.fnUntraced(function* (
    message: Extract<CodexClientMessage, { method: "thread/read" }>,
  ) {
    yield* emit({
      id: message.id,
      result: {
        thread: {
          id: "persisted-thread",
          ephemeral: false,
          historyMode: "paginated",
          path: "/private/unstable-rollout.jsonl",
          turns: [{ id: "discarded", items: [] }],
        },
      },
    });
  });
  const emitTurnStart = Effect.fnUntraced(function* (
    message: Extract<CodexClientMessage, { method: "turn/start" }>,
  ) {
    turns++;
    const turnId =
      (mode === "tool" || mode === "hold-second-reply") && turns > 1 ? `turn-${turns}` : "turn";
    const started = {
      method: "turn/started",
      params: {
        threadId: "thread",
        turn: {
          id: mode === "early-wrong-turn" ? "other" : turnId,
          status: "inProgress",
          items: [],
        },
      },
    };
    if (
      mode === "early-turn" ||
      mode === "early-wrong-turn" ||
      mode === "early-tool" ||
      mode === "early-many-advisories"
    )
      yield* emit(started);
    if (mode === "early-tool") {
      yield* emit({
        method: "item/started",
        params: {
          threadId: "thread",
          turnId,
          item: {
            type: "dynamicToolCall",
            id: "call-early",
            tool: "scotty_hatch",
            status: "inProgress",
          },
        },
      });
      yield* emit({
        method: "item/reasoning/textDelta",
        params: { threadId: "thread", turnId, delta: "private advisory" },
      });
      yield* emit({
        id: 71,
        method: "item/tool/call",
        params: {
          threadId: "thread",
          turnId,
          callId: "call-early",
          namespace: null,
          tool: "scotty_hatch",
          arguments: { operation: "status" },
        },
      });
    }
    if (mode === "early-many-advisories")
      for (let i = 0; i < 64; i++)
        yield* emit({
          method: "item/reasoning/textDelta",
          params: { threadId: "thread", turnId, delta: "private advisory" },
        });
    if (mode === "early-turn")
      yield* emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: turnId, status: "completed", items: [] } },
      });
    if (mode === "hold-second-reply" && turns === 2) {
      yield* Deferred.succeed(secondTurnStarted, undefined);
      yield* Deferred.await(releaseSecondTurn);
    }
    yield* emit({
      id: message.id,
      result: { turn: { id: turnId, status: "inProgress", items: [] } },
    });
    if (
      mode !== "early-turn" &&
      mode !== "early-wrong-turn" &&
      mode !== "early-tool" &&
      mode !== "early-many-advisories"
    )
      yield* emit(started);
  });
  const transport: CodexProcess = {
    pid: ChildProcessSpawner.ProcessId(100),
    platformOs: "linux",
    homes: {
      home: "/isolated/home",
      codexHome: "/isolated/codex-home",
      cwd: "/isolated/workspace",
    },
    options: {
      binary: "/isolated/codex",
      runtimeDir: "/isolated",
      workspace: "/isolated/workspace",
      model: "gpt-5.2",
      credential: { sentinel: "unused-transport-fixture", expiresAt: Number.MAX_SAFE_INTEGER },
      effort: "high",
      startupTimeoutMs: 300,
      requestTimeoutMs: 100,
      turnTimeoutMs: 200,
      stopTimeoutMs: 10,
    },
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.empty,
    writer: Effect.never,
    exit: Deferred.await(exited),
    stop: Effect.gen(function* () {
      stopped++;
      yield* Deferred.succeed(exited, undefined);
      yield* Queue.end(stdout);
      return {
        cleanup: "ambiguous",
        descendants: "unverified",
        parent: "exited",
        shutdown: "eof",
        exit: { code: 0, signal: null },
        failure: null,
      };
    }),
    write: Effect.fnUntraced(function* (bytes) {
      const line = new TextDecoder().decode(bytes);
      const toolResponse = decodeCodexDynamicToolResponse(line);
      if (Result.isSuccess(toolResponse)) {
        yield* Queue.offer(toolResponses, toolResponse.success);
        return;
      }
      const result = decodeCodexClientMessage(line);
      assert.ok(Result.isSuccess(result));
      const message = result.success;
      sent.push(message.method);
      messages.push(message);
      if (delaysInitialize(message)) yield* Effect.sleep(mode === "delayed" ? 140 : 70);
      if (message.method === "initialized" && mode === "no-initialized-write")
        return yield* Effect.never;
      if (message.method === "initialize" && mode !== "no-initialize")
        yield* emit({
          id: mode === "wrong-id" ? String(message.id) : message.id,
          result: {
            userAgent: `scotty-component/${CODEX_VERSION} test`,
            codexHome: "/isolated/codex-home",
            platformFamily: "unix",
            platformOs: "linux",
          },
        });
      if (message.method === "thread/start") {
        yield* emitThreadStart(message);
      }
      if (message.method === "thread/resume") {
        yield* emitThreadResume(message);
        yield* emit({ method: "thread/goal/cleared", params: { threadId: "persisted-thread" } });
      }
      if (message.method === "thread/read") yield* emitThreadRead(message);
      if (message.method === "turn/start" && mode !== "no-turn-response")
        yield* emitTurnStart(message);
      yield* emitSteerResponse(message);
      if (message.method === "turn/interrupt" && mode !== "no-interrupt-response")
        yield* emit({ id: message.id, result: {} });
    }),
  };
  return {
    transport,
    sent,
    messages,
    toolResponses,
    secondTurnStarted,
    releaseSecondTurn,
    stopped: () => stopped,
    emit,
    exited,
    endStdout: Queue.end(stdout),
    complete: emit({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "interrupted", items: [] } },
    }),
  };
});

describe("scoped Codex session", () => {
  it.effect("replays exact parent start and completion received before turn/start reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture("early-turn");
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      assert.equal(turn.turnId, "turn");
      assert.equal((yield* turn.completed).status, "completed");
      assert.deepEqual(
        host.drainEvents().map((event) => event.method),
        ["turn/started", "turn/completed"],
      );
      assert.equal(host.inspect().failure, null);
      yield* host.stop;
    }),
  );
  it.effect("rejects an early notification with a turn ID different from the reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture("early-wrong-turn");
      const host = yield* makeSession(f.transport);
      const outcome = yield* Effect.result(host.prompt("hello"));
      assert.ok(Result.isFailure(outcome));
      assert.equal(outcome.failure.code, "stale_notification");
      assert.deepEqual(host.drainEvents(), []);
      yield* host.closed;
    }),
  );
  it.effect("replays early tool and scoped advisory only after exact admission", () =>
    Effect.gen(function* () {
      const f = yield* fixture("early-tool");
      let executed = 0;
      const host = yield* makeSession(f.transport, undefined, {
        restore: async () => {},
        shutdown: async () => {},
        execute: async () => {
          executed++;
          return { text: "scotty-hatch:early", success: true };
        },
      });
      const turn = yield* host.prompt("hello");
      assert.equal(turn.turnId, "turn");
      assert.deepEqual((yield* Queue.take(f.toolResponses)).result, {
        contentItems: [{ type: "inputText", text: "scotty-hatch:early" }],
        success: true,
      });
      assert.equal(executed, 1);
      assert.deepEqual(
        host.drainEvents().map((event) => event.method),
        ["turn/started", "item/started"],
      );
      yield* f.complete;
      yield* turn.completed;
      yield* host.stop;
    }),
  );
  it.effect("replays more than 64 pre-reply advisories after admission", () =>
    Effect.gen(function* () {
      const f = yield* fixture("early-many-advisories");
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      assert.equal(turn.turnId, "turn");
      assert.equal(host.inspect().failure, null);
      yield* f.complete;
      yield* turn.completed;
      yield* host.stop;
    }),
  );
  it.effect("does not publish buffered messages when admission times out", () =>
    Effect.gen(function* () {
      const f = yield* fixture("no-turn-response");
      const host = yield* makeSession(f.transport);
      const pending = yield* host.prompt("hello").pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(1);
      yield* f.emit({
        method: "turn/started",
        params: { threadId: "thread", turn: { id: "turn", status: "inProgress", items: [] } },
      });
      yield* TestClock.adjust(101);
      const outcome = yield* Fiber.join(pending);
      assert.ok(Result.isFailure(outcome));
      assert.equal(outcome.failure.code, "request_timeout");
      assert.deepEqual(host.drainEvents(), []);
      yield* host.closed;
    }),
  );
  it.effect(
    "registers scoped tools, serves one admitted call once, and skips fresh Hatch restoration",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("tool");
        let restored = 0;
        let shutdown = 0;
        let executed = 0;
        const host = yield* makeSession(f.transport, undefined, {
          restore: async () => {
            restored++;
          },
          shutdown: async () => {
            shutdown++;
          },
          execute: async () => {
            executed++;
            return { text: "scotty-hatch:proof", success: true };
          },
        });
        assert.equal(restored, 0);
        assert.equal(f.messages[0]?.method, "initialize");
        if (f.messages[0]?.method !== "initialize") return;
        assert.equal(f.messages[0].params.capabilities.experimentalApi, true);
        assert.equal(f.messages[2]?.method, "thread/start");
        if (f.messages[2]?.method !== "thread/start") return;
        assert.deepEqual(
          f.messages[2].params.dynamicTools?.map((tool) => tool.name),
          ["scotty_hatch", "scotty_browser_test"],
        );
        for (const tool of f.messages[2].params.dynamicTools ?? []) {
          assert.include(JSON.stringify(tool.inputSchema), '"displayText"');
          assert.include(tool.description, "Include displayText on every call");
        }
        const turn = yield* host.prompt("hello");
        yield* f.emit({
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              type: "dynamicToolCall",
              id: "call-1",
              tool: "scotty_hatch",
              status: "inProgress",
            },
          },
        });
        const call = {
          id: 71,
          method: "item/tool/call",
          params: {
            threadId: "thread",
            turnId: "turn",
            callId: "call-1",
            namespace: null,
            tool: "scotty_hatch",
            arguments: { operation: "status", displayText: "Checking the invoice preview" },
          },
        };
        yield* f.emit(call);
        assert.deepEqual((yield* Queue.take(f.toolResponses)).result, {
          contentItems: [{ type: "inputText", text: "scotty-hatch:proof" }],
          success: true,
        });
        yield* f.emit({ ...call, id: 72 });
        assert.equal((yield* Queue.take(f.toolResponses)).id, 72);
        assert.equal(executed, 1);
        yield* f.emit({
          method: "item/completed",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              type: "dynamicToolCall",
              id: "call-1",
              tool: "scotty_hatch",
              status: "completed",
            },
          },
        });
        yield* f.emit({
          method: "turn/completed",
          params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
        });
        assert.equal((yield* turn.completed).status, "completed");
        assert.equal(host.inspect().tools[0]?.label, "Checking the invoice preview");
        yield* host.stop;
        assert.equal(shutdown, 1);
      }),
  );
  it.effect(
    "settles an interrupted tool and admits a fresh turn without replaying its receipt",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("tool");
        let calls = 0;
        let markStarted = () => {};
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const host = yield* makeSession(f.transport, undefined, {
          restore: async () => {},
          shutdown: async () => {},
          execute: async (_tool, _input, signal) => {
            calls++;
            if (calls > 1) return { text: "scotty-evidence:fresh", success: true };
            markStarted();
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(new Error("interrupted")), {
                once: true,
              });
            });
          },
        });
        const turn = yield* host.prompt("first");
        const item = (turnId: string) => ({
          method: "item/started",
          params: {
            threadId: "thread",
            turnId,
            item: {
              type: "dynamicToolCall",
              id: "call-1",
              tool: "scotty_browser_test",
              status: "inProgress",
            },
          },
        });
        const call = (id: number, turnId: string) => ({
          id,
          method: "item/tool/call",
          params: {
            threadId: "thread",
            turnId,
            callId: "call-1",
            namespace: null,
            tool: "scotty_browser_test",
            arguments: { port: 4174 },
          },
        });
        yield* f.emit(item("turn"));
        yield* f.emit(call(81, "foreign-turn"));
        assert.equal((yield* Queue.take(f.toolResponses)).result.success, false);
        assert.equal(calls, 0);
        yield* f.emit(call(82, "turn"));
        yield* Effect.promise(() => started);
        yield* f.emit({
          method: "turn/completed",
          params: { threadId: "thread", turn: { id: "turn", status: "interrupted", items: [] } },
        });
        assert.equal((yield* Queue.take(f.toolResponses)).result.success, false);
        assert.equal((yield* turn.completed).status, "interrupted");
        const next = yield* host.prompt("second");
        assert.equal(next.turnId, "turn-2");
        yield* f.emit(item("turn-2"));
        yield* f.emit(call(83, "turn-2"));
        assert.equal(
          (yield* Queue.take(f.toolResponses)).result.contentItems[0].text,
          "scotty-evidence:fresh",
        );
        assert.equal(calls, 2);
        yield* f.emit({
          method: "turn/completed",
          params: { threadId: "thread", turn: { id: "turn-2", status: "completed", items: [] } },
        });
        yield* next.completed;
        yield* host.stop;
      }),
  );
  for (const shutdown of ["stop", "failure"] as const)
    it.effect(
      `terminal publication reconciles ${shutdown} and receiver exits without defects`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const publishing = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const release = yield* Deferred.make<void>();
          const host = yield* makeSession(f.transport, (event) =>
            event.method === "turn/completed"
              ? Effect.gen(function* () {
                  const receiver = yield* Effect.withFiber(Effect.succeed);
                  yield* Deferred.succeed(publishing, receiver);
                  yield* Deferred.await(release);
                })
              : Effect.void,
          );
          const turn = yield* host.prompt("hello");
          yield* f.emit({
            method: "turn/completed",
            params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
          });
          const receiver = yield* Deferred.await(publishing);
          if (shutdown === "failure") yield* Deferred.succeed(f.exited, undefined);
          else yield* host.stop;
          const receipt = yield* host.closed;
          yield* Deferred.succeed(release, undefined);
          const exit = yield* Fiber.await(receiver);
          assert.ok(Exit.isSuccess(exit));
          const terminal = yield* Effect.result(turn.completed);
          assert.ok(Result.isFailure(terminal));
          assert.equal(terminal.failure.code, shutdown === "stop" ? "stopped" : "unexpected_exit");
          assert.equal(receipt.failure, shutdown === "stop" ? null : "unexpected_exit");
          assert.strictEqual(yield* host.stop, receipt);
          assert.equal(f.stopped(), 1);
          assert.equal(host.inspect().ready, false);
          assert.equal(host.inspect().activeTurnId, null);
        }),
    );

  for (const mode of ["normal", "no-turn-response"] as const)
    it.effect(
      `unowned clean stdout EOF closes ${mode === "normal" ? "idle" : "pending"} transport`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(mode);
          const host = yield* makeSession(f.transport);
          const pending = yield* (
            mode === "no-turn-response" ? host.prompt("hello") : Effect.void
          ).pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust(1);
          assert.equal(host.inspect().ready, true);
          assert.equal(f.stopped(), 0);
          yield* f.endStdout;
          const receipt = yield* host.closed;
          assert.equal(receipt.failure, "transport_failed");
          assert.equal(host.inspect().ready, false);
          assert.equal(host.inspect().failure, "transport_failed");
          assert.equal(f.stopped(), 1);
          const result = yield* Fiber.join(pending);
          assert.equal(
            Result.match(result, {
              onSuccess: () => null,
              onFailure: (error) => error.code,
            }),
            mode === "no-turn-response" ? "transport_failed" : null,
          );
          const late = yield* Effect.result(host.prompt("late"));
          assert.ok(Result.isFailure(late));
          assert.equal(late.failure.code, "not_ready");
          assert.strictEqual(yield* host.stop, receipt);
        }),
    );

  for (const mode of ["sandbox", "approval"] as const)
    it.effect(`rejects unexpected ${mode} readback before prompting`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(mode);
        const result = yield* Effect.result(makeSession(f.transport));
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.code, "invalid_message");
        assert.deepEqual(f.sent, ["initialize", "initialized", "thread/start"]);
        assert.equal(f.stopped(), 1);
        assert.equal(result.failure.cleanup?.descendants, "unverified");
      }),
    );

  it.effect("establishes settings before prompt and waits beyond interrupt acknowledgement", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      assert.deepEqual(f.sent, ["initialize", "initialized", "thread/start"]);
      assert.equal(host.inspect().settings.reasoningEffort, "high");
      assert.deepEqual(f.messages[2], {
        id: 2,
        method: "thread/start",
        params: {
          model: "gpt-5.2",
          modelProvider: "scotty-managed",
          cwd: "/isolated/workspace",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
        },
      });
      assert.equal(host.inspect().settings.approvalPolicy, "never");
      assert.deepEqual(host.inspect().settings.sandbox, { type: "dangerFullAccess" });
      const turn = yield* host.prompt("hello");
      const interrupt = yield* host.interrupt.pipe(Effect.forkChild);
      yield* TestClock.adjust(50);
      assert.equal(interrupt.pollUnsafe(), undefined);
      yield* f.complete;
      assert.equal((yield* Fiber.join(interrupt)).status, "interrupted");
      assert.equal((yield* turn.completed).status, "interrupted");
      const first = yield* host.stop;
      assert.strictEqual(yield* host.stop, first);
      assert.equal(first.cleanup, "ambiguous");
      assert.equal(f.stopped(), 1);
    }),
  );

  it.effect("starts an explicitly durable native thread with exact history readback", () =>
    Effect.gen(function* () {
      const f = yield* fixture("durable-start");
      const host = yield* makeSession({
        ...f.transport,
        options: { ...f.transport.options, ephemeral: false },
      });
      assert.deepEqual(f.sent, ["initialize", "initialized", "thread/start"]);
      assert.equal(f.messages[2].method, "thread/start");
      if (f.messages[2].method !== "thread/start") return;
      assert.equal(f.messages[2].params.ephemeral, false);
      assert.deepEqual(host.inspect().settings.thread, {
        id: "thread",
        ephemeral: false,
        historyMode: "paginated",
      });
      yield* host.stop;
    }),
  );

  it.effect("resumes only by thread ID and validates metadata-only readback", () =>
    Effect.gen(function* () {
      const f = yield* fixture("durable-resume");
      const host = yield* makeSession({
        ...f.transport,
        options: {
          ...f.transport.options,
          ephemeral: false,
          resumeThreadId: "persisted-thread",
        },
      });
      assert.deepEqual(f.sent, ["initialize", "initialized", "thread/resume", "thread/read"]);
      assert.deepEqual(f.messages[2], {
        id: 2,
        method: "thread/resume",
        params: {
          threadId: "persisted-thread",
          excludeTurns: true,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      });
      assert.deepEqual(f.messages[3], {
        id: 3,
        method: "thread/read",
        params: { threadId: "persisted-thread", includeTurns: false },
      });
      assert.equal(host.inspect().threadId, "persisted-thread");
      assert.equal(host.inspect().discarded, 1);
      assert.deepEqual(host.inspect().settings.thread, {
        id: "persisted-thread",
        ephemeral: false,
        historyMode: "paginated",
      });
      yield* host.stop;
    }),
  );

  it.effect("restores Hatch ownership before resumed native readiness", () =>
    Effect.gen(function* () {
      const f = yield* fixture("durable-resume");
      let restores = 0;
      const host = yield* makeSession(
        {
          ...f.transport,
          options: { ...f.transport.options, ephemeral: false, resumeThreadId: "persisted-thread" },
        },
        undefined,
        {
          restore: async () => {
            restores++;
          },
          shutdown: async () => {},
          execute: async () => ({ text: "synthetic", success: true }),
        },
      );
      assert.equal(restores, 1);
      assert.equal(host.inspect().ready, true);
      yield* host.stop;
    }),
  );

  it.effect("keeps the native handshake bounded while allowing a longer Hatch restore", () =>
    Effect.gen(function* () {
      const f = yield* fixture("durable-resume");
      const restoreStarted = yield* Deferred.make<void>();
      let finishRestore = () => {};
      const hostFiber = yield* makeSession(
        {
          ...f.transport,
          options: { ...f.transport.options, ephemeral: false, resumeThreadId: "persisted-thread" },
        },
        undefined,
        {
          restore: () => {
            Deferred.doneUnsafe(restoreStarted, Effect.void);
            return new Promise<void>((resolve) => {
              finishRestore = resolve;
            });
          },
          shutdown: async () => {},
          execute: async () => ({ text: "synthetic", success: true }),
        },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(restoreStarted);
      yield* TestClock.adjust("16 seconds");
      finishRestore();
      const host = yield* Fiber.join(hostFiber);
      assert.isTrue(host.inspect().ready);
      yield* host.stop;
    }),
  );

  it.effect("keeps the native host ready after a rejected nonfatal steer", () =>
    Effect.gen(function* () {
      const f = yield* fixture("steer-rejected");
      const host = yield* makeSession(f.transport);
      yield* host.prompt("hello");
      const result = yield* Effect.result(host.steer("adjust", "turn"));
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "rpc_rejected");
      assert.equal(host.inspect().ready, true);
      assert.equal(host.inspect().failure, null);
      yield* host.stop;
    }),
  );
  it.effect(
    "keeps a classified Hatch failure and bounded stderr tail in the native tool reply",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const host = yield* makeSession(f.transport, undefined, {
          restore: async () => {},
          shutdown: async () => {},
          execute: async () => {
            throw new HatchFailure(
              "preparation_failed",
              "stdout".repeat(400),
              "SCOTTY_HATCH_SAFE_TAIL",
              23,
            );
          },
        });
        yield* host.prompt("hatch");
        yield* f.emit({
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              type: "dynamicToolCall",
              id: "hatch-call",
              tool: "scotty_hatch",
              status: "inProgress",
            },
          },
        });
        yield* f.emit({
          id: 113,
          method: "item/tool/call",
          params: {
            threadId: "thread",
            turnId: "turn",
            callId: "hatch-call",
            namespace: null,
            tool: "scotty_hatch",
            arguments: { operation: "ensure" },
          },
        });
        const reply = (yield* Queue.take(f.toolResponses)).result;
        assert.equal(reply.success, false);
        assert.match(reply.contentItems[0].text, /^Hatch failed \(preparation_failed\)/u);
        assert.include(reply.contentItems[0].text, "SCOTTY_HATCH_SAFE_TAIL");
        assert.isAbove(new TextEncoder().encode(reply.contentItems[0].text).byteLength, 1200);
        assert.equal(host.inspect().ready, true);
        yield* host.stop;
      }),
  );

  it.effect("keeps malformed nonfatal steer responses fatal", () =>
    Effect.gen(function* () {
      const f = yield* fixture("steer-malformed");
      const host = yield* makeSession(f.transport);
      yield* host.prompt("hello");
      const result = yield* Effect.result(host.steer("adjust", "turn"));
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "invalid_message");
      assert.equal(host.inspect().ready, false);
      assert.equal(host.inspect().failure, "invalid_message");
      assert.equal((yield* host.closed).failure, "invalid_message");
    }),
  );

  it.effect("discards pinned informational events around command and steer progress", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* f.emit({
        method: "item/started",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "commandExecution",
            id: "command",
            command: "printf PROOF",
            status: "inProgress",
          },
        },
      });
      yield* f.emit({
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thread", turnId: "turn", itemId: "command", delta: "PROOF" },
      });
      yield* f.emit({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "reasoning",
          delta: "planning",
          summaryIndex: 0,
        },
      });
      assert.deepEqual(yield* host.steer("adjust", "turn"), { turnId: "turn" });
      for (const event of [
        {
          method: "item/reasoning/summaryPartAdded",
          params: { threadId: "thread", turnId: "turn", itemId: "reasoning", summaryIndex: 0 },
        },
        {
          method: "item/reasoning/textDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "reasoning",
            delta: "details",
            contentIndex: 0,
          },
        },
        {
          method: "item/plan/delta",
          params: { threadId: "thread", turnId: "turn", itemId: "plan", delta: "step" },
        },
        {
          method: "turn/diff/updated",
          params: { threadId: "thread", turnId: "turn", diff: "diff" },
        },
        {
          method: "turn/plan/updated",
          params: { threadId: "thread", turnId: "turn", explanation: null, plan: [] },
        },
        {
          method: "item/commandExecution/terminalInteraction",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "command",
            processId: "process",
            stdin: "",
          },
        },
      ] as const)
        yield* f.emit(event);
      yield* f.emit({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "commandExecution",
            id: "command",
            command: "printf PROOF",
            status: "completed",
            aggregatedOutput: "PROOF",
          },
        },
      });
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
      });
      assert.equal((yield* turn.completed).status, "completed");
      assert.equal(host.inspect().ready, true);
      assert.equal(host.inspect().failure, null);
      assert.ok(host.inspect().discarded >= 7);
      yield* host.stop;
    }),
  );

  it.effect(
    "routes a known late command to its original turn while idle and during a new turn",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("tool");
        let toolExecutions = 0;
        const host = yield* makeSession(f.transport, undefined, {
          restore: async () => {},
          shutdown: async () => {},
          execute: async () => {
            toolExecutions++;
            return { text: "unexpected", success: true };
          },
        });
        const first = yield* host.prompt("first");
        yield* f.emit({
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              type: "commandExecution",
              id: "command",
              command: "printf safe",
              status: "inProgress",
            },
          },
        });
        yield* f.emit({
          method: "turn/completed",
          params: {
            threadId: "thread",
            turn: { id: "turn", status: "completed", items: [] },
          },
        });
        yield* first.completed;
        yield* f.emit({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "command",
            delta: "safe",
          },
        });
        const second = yield* host.prompt("second");
        assert.equal(second.turnId, "turn-2");
        yield* f.emit({
          method: "item/completed",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              type: "commandExecution",
              id: "command",
              command: "printf safe",
              status: "completed",
              aggregatedOutput: "safe",
            },
          },
        });
        yield* TestClock.adjust(1);
        assert.equal(host.inspect().ready, true);
        assert.deepEqual(host.inspect().tools, []);
        assert.equal(toolExecutions, 0);
        assert.deepEqual(
          host
            .drainEvents()
            .flatMap((event) => (event.method === "item/completed" ? [event.params.turnId] : [])),
          ["turn"],
        );
        yield* host.stop;
      }),
  );

  it.effect("rejects a duplicate completion for a known old command", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("first");
      yield* f.emit({
        method: "item/started",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "commandExecution",
            id: "command",
            command: "printf safe",
            status: "inProgress",
          },
        },
      });
      yield* f.emit({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "turn", status: "completed", items: [] },
        },
      });
      yield* turn.completed;
      const completion = {
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "commandExecution",
            id: "command",
            command: "printf safe",
            status: "completed",
          },
        },
      };
      yield* f.emit(completion);
      yield* TestClock.adjust(1);
      assert.equal(host.inspect().ready, true);
      yield* f.emit(completion);
      assert.equal((yield* host.closed).failure, "stale_notification");
    }),
  );

  it.effect("admits more than 64 sequential commands in one turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("run commands");
      for (let i = 0; i < 65; i++) {
        const item = {
          type: "commandExecution" as const,
          id: `command-${i}`,
          command: "true",
          status: "inProgress" as const,
        };
        yield* f.emit({
          method: "item/started",
          params: { threadId: "thread", turnId: "turn", item },
        });
        yield* f.emit({
          method: "item/completed",
          params: { threadId: "thread", turnId: "turn", item: { ...item, status: "completed" } },
        });
      }
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
      });
      assert.equal((yield* turn.completed).status, "completed");
      assert.equal(host.inspect().failure, null);
      yield* host.stop;
    }),
  );

  it.effect(
    "discards a late terminal interaction for the original command while idle and during a new turn",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("tool");
        const host = yield* makeSession(f.transport);
        const first = yield* host.prompt("first");
        yield* f.emit({
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              type: "commandExecution",
              id: "command",
              command: "sleep 90",
              status: "inProgress",
            },
          },
        });
        yield* f.emit({
          method: "turn/completed",
          params: { threadId: "thread", turn: { id: "turn", status: "interrupted", items: [] } },
        });
        assert.equal((yield* first.completed).status, "interrupted");
        const interaction = {
          method: "item/commandExecution/terminalInteraction",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "command",
            processId: "private-process",
            stdin: "private-input",
          },
        } as const;
        yield* f.emit(interaction);
        yield* TestClock.adjust(1);
        assert.equal(host.inspect().ready, true);
        const second = yield* host.prompt("queued follow-up");
        assert.equal(second.turnId, "turn-2");
        yield* f.emit(interaction);
        yield* TestClock.adjust(1);
        assert.equal(host.inspect().ready, true);
        assert.equal(host.inspect().failure, null);
        assert.notInclude(JSON.stringify(host.inspect()), "private-input");
        yield* f.emit({
          method: "turn/completed",
          params: { threadId: "thread", turn: { id: "turn-2", status: "completed", items: [] } },
        });
        assert.equal((yield* second.completed).status, "completed");
        yield* host.stop;
      }),
  );

  it.effect("discards a late terminal interaction without command ownership", () =>
    Effect.gen(function* () {
      const f = yield* fixture("tool");
      const host = yield* makeSession(f.transport);
      const first = yield* host.prompt("first");
      yield* f.emit({
        method: "item/started",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "commandExecution",
            id: "command",
            command: "sleep 90",
            status: "inProgress",
          },
        },
      });
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "interrupted", items: [] } },
      });
      yield* first.completed;
      yield* host.prompt("queued follow-up");
      yield* f.emit({
        method: "item/commandExecution/terminalInteraction",
        params: { threadId: "thread", turnId: "turn", itemId: "unknown-command" },
      });
      assert.equal(host.inspect().ready, true);
      yield* host.stop;
    }),
  );

  it.effect("does not buffer an old command interaction behind a pending new turn reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture("hold-second-reply");
      const host = yield* makeSession(f.transport);
      const first = yield* host.prompt("first");
      yield* f.emit({
        method: "item/started",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "commandExecution",
            id: "command",
            command: "sleep 90",
            status: "inProgress",
          },
        },
      });
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "interrupted", items: [] } },
      });
      yield* first.completed;
      const secondFiber = yield* host.prompt("queued follow-up").pipe(Effect.forkChild);
      yield* Deferred.await(f.secondTurnStarted);
      yield* f.emit({
        method: "item/commandExecution/terminalInteraction",
        params: { threadId: "thread", turnId: "turn", itemId: "command" },
      });
      yield* TestClock.adjust(1);
      assert.equal(host.inspect().ready, true);
      assert.equal(host.inspect().failure, null);
      yield* Deferred.succeed(f.releaseSecondTurn, undefined);
      const second = yield* Fiber.join(secondFiber);
      assert.equal(second.turnId, "turn-2");
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn-2", status: "completed", items: [] } },
      });
      assert.equal((yield* second.completed).status, "completed");
      yield* host.stop;
    }),
  );

  it.effect("ignores a fenced retryable upstream error until terminal completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* f.emit({
        method: "error",
        params: {
          threadId: "thread",
          turnId: "turn",
          willRetry: true,
          error: { message: "untrusted transient detail", codexErrorInfo: "other" },
        },
      });
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
      });
      assert.equal((yield* turn.completed).status, "completed");
      assert.equal(host.inspect().ready, true);
      assert.equal(host.inspect().failure, null);
      assert.ok(host.inspect().discarded >= 1);
      assert.notInclude(JSON.stringify(host.inspect()), "untrusted transient detail");
      yield* host.stop;
    }),
  );

  it.effect("keeps retryable upstream errors turn-fenced", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* f.emit({
        method: "error",
        params: {
          threadId: "old-thread",
          turnId: "turn",
          willRetry: true,
          error: { message: "untrusted transient detail" },
        },
      });
      const result = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "stale_notification");
      assert.equal(result.failure.staleDiagnostic, "error foreign active none");
      assert.equal((yield* host.closed).failure, "stale_notification");
    }),
  );

  it.effect("discards informational notifications from an unrelated thread", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* f.emit({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "other-thread",
          turnId: "turn",
          itemId: "reasoning",
          delta: "stale",
          contentIndex: 0,
        },
      });
      assert.equal(host.inspect().ready, true);
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
      });
      assert.equal((yield* turn.completed).status, "completed");
      yield* host.stop;
    }),
  );

  it.effect("ignores only child threads identified by a parent-fenced activity item", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("delegate");
      yield* f.emit({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "subAgentActivity",
            id: "activity",
            agentThreadId: "child",
            kind: "started",
            agentPath: "/root/child",
          },
        },
      });
      yield* f.emit({
        method: "turn/started",
        params: { threadId: "child", turn: { id: "child-turn", status: "inProgress", items: [] } },
      });
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "child", turn: { id: "child-turn", status: "completed", items: [] } },
      });
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
      });
      assert.equal((yield* turn.completed).status, "completed");
      assert.equal(host.inspect().failure, null);
      assert.ok(host.inspect().discarded >= 2);
      assert.ok(host.drainEvents().every((event) => event.params.threadId === "thread"));
      yield* host.stop;
    }),
  );

  for (const event of [
    { method: "item/started", params: { threadId: "thread", turnId: "turn", item: {} } },
    { method: "future/notification", params: null },
  ] as const)
    it.effect(`rejects malformed notification envelope or consumed event ${event.method}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const host = yield* makeSession(f.transport);
        const turn = yield* host.prompt("hello");
        yield* f.emit(event);
        const result = yield* Effect.result(turn.completed);
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.code, "invalid_message");
        assert.equal((yield* host.closed).failure, result.failure.code);
      }),
    );

  it.effect("readiness can exceed the request budget within one startup budget", () =>
    Effect.gen(function* () {
      const f = yield* fixture("delayed");
      const fiber = yield* makeSession(f.transport).pipe(Effect.forkChild);
      yield* TestClock.adjust(209);
      assert.equal(fiber.pollUnsafe(), undefined);
      assert.equal(f.stopped(), 0);
      yield* TestClock.adjust(1);
      const host = yield* Fiber.join(fiber);
      assert.equal(host.inspect().ready, true);
      assert.deepEqual(f.sent, ["initialize", "initialized", "thread/start"]);
      yield* host.stop;
      assert.equal(f.stopped(), 1);
    }),
  );

  for (const mode of ["no-initialize", "no-initialized-write", "no-thread-response"] as const)
    it.effect(`one startup deadline stops stalled ${mode} exactly once`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(mode);
        const scope = yield* Scope.make();
        const fiber = yield* makeSession(f.transport).pipe(
          Scope.provide(scope),
          Effect.result,
          Effect.forkChild,
        );
        yield* TestClock.adjust(299);
        assert.equal(fiber.pollUnsafe(), undefined);
        assert.equal(f.stopped(), 0);
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(fiber);
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.code, "startup_timeout");
        assert.equal(result.failure.cleanup?.failure, "startup_timeout");
        assert.equal(result.failure.cleanup?.descendants, "unverified");
        assert.equal(f.sent.includes("turn/start"), false);
        yield* Scope.close(scope, Exit.void);
        assert.equal(f.stopped(), 1);
      }),
    );

  for (const correction of [-15000, 15000])
    it.effect(`wall-clock correction ${correction}ms preserves the 15000ms startup cap`, () =>
      Effect.gen(function* () {
        const f = yield* fixture("no-thread-response");
        const clock = yield* Clock.Clock;
        const scope = yield* Scope.make();
        let wallOffset = 0;
        let writes = 0;
        const fiber = yield* makeSession({
          ...f.transport,
          options: { ...f.transport.options, startupTimeoutMs: 15000 },
          write: (bytes) =>
            f.transport.write(bytes).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (++writes === 1) wallOffset = correction;
                }),
              ),
            ),
        }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + wallOffset,
            currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + wallOffset),
          }),
          Scope.provide(scope),
          Effect.result,
          Effect.forkChild,
        );
        yield* TestClock.adjust(14999);
        assert.equal(wallOffset, correction);
        assert.deepEqual(f.sent, ["initialize", "initialized", "thread/start"]);
        assert.equal(fiber.pollUnsafe(), undefined);
        assert.equal(f.stopped(), 0);
        yield* TestClock.adjust(1);
        assert.notEqual(fiber.pollUnsafe(), undefined);
        const result = yield* Fiber.join(fiber);
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.code, "startup_timeout");
        assert.equal(result.failure.cleanup?.failure, "startup_timeout");
        assert.equal(f.stopped(), 1);
        yield* Scope.close(scope, Exit.void);
        assert.equal(f.stopped(), 1);
      }),
    );

  for (const mode of ["no-turn-response", "no-interrupt-response"] as const)
    it.effect(`post-ready ${mode} retains the short request deadline`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(mode);
        const host = yield* makeSession(f.transport);
        if (mode === "no-interrupt-response") yield* host.prompt("hello");
        const fiber = yield* (
          mode === "no-turn-response"
            ? host.prompt("hello").pipe(Effect.asVoid)
            : host.interrupt.pipe(Effect.asVoid)
        ).pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust(99);
        assert.equal(fiber.pollUnsafe(), undefined);
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(fiber);
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.code, "request_timeout");
        assert.equal((yield* host.closed).failure, "request_timeout");
        assert.equal(host.inspect().ready, false);
        assert.equal(f.stopped(), 1);
      }),
    );

  it.effect("pre-ready server-request replies retain their request write deadline", () =>
    Effect.gen(function* () {
      const f = yield* fixture("no-initialize");
      let writes = 0;
      const fiber = yield* makeSession({
        ...f.transport,
        write: (bytes) =>
          Effect.suspend(() => (++writes === 1 ? f.transport.write(bytes) : Effect.never)),
      }).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(1);
      yield* f.emit({
        id: "approval",
        method: "item/commandExecution/requestApproval",
        params: {},
      });
      yield* TestClock.adjust(99);
      assert.equal(writes, 2);
      assert.equal(fiber.pollUnsafe(), undefined);
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(fiber);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "request_timeout");
      assert.equal(result.failure.cleanup?.failure, "request_timeout");
      assert.equal(f.stopped(), 1);
    }),
  );

  it.effect("an explicit turn deadline fails and cleans up without terminal success", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* TestClock.adjust(200);
      const terminal = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(terminal));
      assert.equal(terminal.failure.code, "turn_timeout");
      assert.equal((yield* host.closed).failure, "turn_timeout");
    }),
  );

  it.effect("an unset turn deadline lets an active turn exceed 30 seconds and complete", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession({
        ...f.transport,
        options: { ...f.transport.options, turnTimeoutMs: undefined },
      });
      const turn = yield* host.prompt("hello");
      yield* TestClock.adjust(30001);
      assert.equal(f.stopped(), 0);
      assert.equal(host.inspect().ready, true);
      assert.equal(host.inspect().activeTurnId, "turn");
      yield* f.emit({
        method: "turn/completed",
        params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
      });
      assert.equal((yield* turn.completed).status, "completed");
      assert.equal(host.inspect().failure, null);
      yield* host.stop;
      assert.equal(f.stopped(), 1);
    }),
  );

  it.effect("an interrupt acknowledgement without a terminal uses the request deadline", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession({
        ...f.transport,
        options: { ...f.transport.options, turnTimeoutMs: undefined },
      });
      const turn = yield* host.prompt("hello");
      const interrupt = yield* host.interrupt.pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(99);
      assert.equal(interrupt.pollUnsafe(), undefined);
      assert.equal(f.stopped(), 0);
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(interrupt);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "request_timeout");
      const terminal = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(terminal));
      assert.equal(terminal.failure.code, "request_timeout");
      assert.equal((yield* host.closed).failure, "request_timeout");
      assert.equal(f.stopped(), 1);
    }),
  );

  it.effect("exact response ID retains number/string identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture("wrong-id");
      const result = yield* Effect.result(makeSession(f.transport));
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "unexpected_response_id");
    }),
  );

  it.effect("caller interruption during initialization closes the owned scope", () =>
    Effect.gen(function* () {
      const f = yield* fixture("no-initialize");
      const fiber = yield* Effect.scoped(makeSession(f.transport)).pipe(Effect.forkChild);
      yield* TestClock.adjust(1);
      yield* Fiber.interrupt(fiber);
      assert.equal(f.stopped(), 1);
      assert.deepEqual(f.sent, ["initialize"]);
    }),
  );

  it.effect("scope disposal stops active turns without inventing completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const scope = yield* Scope.make();
      const host = yield* makeSession(f.transport).pipe(Scope.provide(scope));
      const turn = yield* host.prompt("hello");
      yield* Scope.close(scope, Exit.void);
      const result = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "stopped");
      assert.equal((yield* host.closed).failure, null);
      assert.equal(f.stopped(), 1);
    }),
  );

  it.effect("interrupting an in-flight prompt fails the generation rather than retrying it", () =>
    Effect.gen(function* () {
      const f = yield* fixture("no-turn-response");
      const host = yield* makeSession(f.transport);
      const prompt = yield* host.prompt("hello").pipe(Effect.forkChild);
      yield* TestClock.adjust(1);
      yield* Fiber.interrupt(prompt);
      assert.equal((yield* host.closed).failure, "interrupted");
      assert.equal(f.sent.filter((method) => method === "turn/start").length, 1);
      assert.equal(f.stopped(), 1);
    }),
  );

  it.effect("unexpected exit fails a pending turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* Deferred.succeed(f.exited, undefined);
      const result = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "unexpected_exit");
    }),
  );
});

it.effect("framing preserves split UTF-8 and delivers large records and later lines", () =>
  Effect.gen(function* () {
    const framer = makeFramer();
    const lines: Array<string> = [];
    const receive = (line: string) =>
      Effect.sync(() => {
        lines.push(line);
      });
    yield* framer.push(new Uint8Array([0xc3]), receive);
    yield* framer.push(new Uint8Array([0xa9, 10]), receive);
    assert.deepEqual(lines, ["é"]);
    yield* framer.end;
    for (let i = 0; i < 4097; i++) yield* framer.push(new Uint8Array([120, 10]), receive);
    assert.equal(lines.length, 4098);
    const large = `${"x".repeat(2 * 1024 * 1024 + 1)}\nnext\n`;
    yield* framer.push(new TextEncoder().encode(large), receive);
    yield* framer.end;
    assert.equal(lines.at(-2)?.length, 2 * 1024 * 1024 + 1);
    assert.equal(lines.at(-1), "next");
  }),
);

it.effect("delivers an oversized command completion and the next record", () =>
  Effect.gen(function* () {
    const aggregate = '😀"\n'.repeat(500_000);
    const completion = JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          type: "commandExecution",
          id: "command",
          command: 'printf "aggregatedOutput":',
          status: "completed",
          aggregatedOutput: aggregate,
          exitCode: 0,
        },
      },
    });
    const terminal = JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
    });
    const bytes = new TextEncoder().encode(`${completion}\n${terminal}\n`);
    assert.ok(bytes.length > 2 * 1024 * 1024);
    const split = completion.indexOf("aggregatedOutput", completion.indexOf("item/completed")) + 5;
    const framer = makeFramer();
    const lines: Array<string> = [];
    const receive = (line: string) =>
      Effect.sync(() => {
        lines.push(line);
      });
    yield* framer.push(bytes.subarray(0, split), receive);
    yield* framer.push(bytes.subarray(split, split + 8191), receive);
    yield* framer.push(bytes.subarray(split + 8191), receive);
    yield* framer.end;
    assert.equal(lines.length, 2);
    const first = decodeCodexNotification(lines[0]);
    assert.ok(Result.isSuccess(first));
    assert.equal(first.success.method, "item/completed");
    if (first.success.method !== "item/completed") return;
    assert.equal(first.success.params.item.type, "commandExecution");
    if (!Predicate.hasProperty(first.success.params.item, "command")) return;
    assert.equal(first.success.params.item.id, "command");
    assert.equal(first.success.params.item.status, "completed");
    assert.equal(first.success.params.item.aggregatedOutput, aggregate);
    const tools = makeCodexTools();
    tools.accept(first.success);
    assert.equal(tools.snapshot().tools[0]?.state, "completed");
    assert.equal(tools.snapshot().toolsTruncated, false);
    assert.equal(tools.snapshot().tools[0]?.output, aggregate);
    const second = decodeCodexNotification(lines[1]);
    assert.ok(Result.isSuccess(second));
    assert.equal(second.success.method, "turn/completed");
  }),
);

it.effect("expired credential blocks a new prompt without writing a turn", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession({
      ...f.transport,
      options: {
        ...f.transport.options,
        credential: { sentinel: "unused-transport-fixture", expiresAt: 100 },
      },
    });
    yield* TestClock.adjust(100);
    const result = yield* Effect.result(host.prompt("late"));
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure.code, "credential_expired");
    assert.deepEqual(f.sent, ["initialize", "initialized", "thread/start"]);
  }),
);

it.effect("native upstream failure remains a failed turn with ready host", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    const turn = yield* host.prompt("hello");
    yield* f.emit({
      method: "error",
      params: {
        threadId: "thread",
        turnId: "turn",
        willRetry: false,
        error: { message: "untrusted credential detail", codexErrorInfo: "other" },
      },
    });
    yield* f.emit({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "turn", status: "failed", items: [], error: { message: "hidden" } },
      },
    });
    assert.equal((yield* turn.completed).status, "failed");
    assert.equal(host.inspect().ready, true);
    assert.notInclude(JSON.stringify(host.inspect()), "untrusted credential detail");
    yield* host.stop;
  }),
);

it.effect("native upstream error from a foreign thread remains fatal", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    const turn = yield* host.prompt("hello");
    yield* f.emit({
      method: "error",
      params: {
        threadId: "old-thread",
        turnId: "turn",
        willRetry: false,
        error: { message: "untrusted credential detail", codexErrorInfo: "other" },
      },
    });
    const result = yield* Effect.result(turn.completed);
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure.code, "stale_notification");
    assert.equal((yield* host.closed).failure, "stale_notification");
    assert.notInclude(JSON.stringify(result), "untrusted credential detail");
  }),
);

it.effect(
  "nonretryable model error without native terminal settles within a bounded deadline",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession({
        ...f.transport,
        options: {
          ...f.transport.options,
          turnTimeoutMs: undefined,
        },
      });
      const turn = yield* host.prompt("hello");
      yield* f.emit({
        method: "error",
        params: {
          threadId: "thread",
          turnId: "turn",
          willRetry: false,
          error: { message: "private upstream body", codexErrorInfo: "other" },
        },
      });
      yield* TestClock.adjust(1);
      assert.equal(host.inspect().discarded, 1);
      yield* TestClock.adjust(4998);
      assert.equal(host.inspect().ready, true);
      yield* TestClock.adjust(1);
      const result = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "upstream_failed");
      assert.equal(host.inspect().failureDiagnostic, "other");
      assert.equal((yield* host.closed).failure, "upstream_failed");
      assert.notInclude(JSON.stringify(host.inspect()), "private upstream body");
    }),
);

it.effect("projects only structured upstream category and numeric HTTP status", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    const turn = yield* host.prompt("hello");
    yield* f.emit({
      method: "error",
      params: {
        threadId: "thread",
        turnId: "turn",
        willRetry: false,
        error: {
          message: "untrusted upstream body and secret",
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        },
      },
    });
    yield* f.emit({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "turn", status: "failed", items: [], error: { message: "hidden" } },
      },
    });
    assert.equal((yield* turn.completed).status, "failed");
    assert.equal(host.inspect().ready, true);
    assert.notInclude(JSON.stringify(host.inspect()), "untrusted upstream body");
    yield* host.stop;
  }),
);

it.effect(
  "classifies the pinned activeTurnNotSteerable object without publishing error prose",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* f.emit({
        method: "error",
        params: {
          threadId: "thread",
          turnId: "turn",
          willRetry: false,
          error: {
            message: "SECRET ERROR PROSE",
            codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
          },
        },
      });
      yield* f.emit({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: {
            id: "turn",
            status: "failed",
            items: [],
            error: { message: "SECRET ERROR PROSE" },
          },
        },
      });
      assert.equal((yield* turn.completed).status, "failed");
      assert.equal(host.inspect().turnFailureDiagnostic, "activeTurnNotSteerable:review");
      assert.notInclude(JSON.stringify(host.inspect()), "SECRET ERROR PROSE");
      yield* host.stop;
    }),
);

it.effect("discards a goal-cleared notification for a different thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    yield* f.emit({ method: "thread/goal/cleared", params: { threadId: "another-thread" } });
    assert.equal(host.inspect().ready, true);
    yield* host.stop;
  }),
);

const matchingSettings = {
  model: "gpt-5.2",
  modelProvider: "scotty-managed",
  cwd: "/isolated/workspace",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "dangerFullAccess" },
  effort: "high",
};

for (const method of ["thread/closed", "thread/deleted"] as const) {
  it.effect(`invalidates readiness for the matching ${method}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      yield* f.emit({ method, params: { threadId: "other-thread" }, emittedAtMs: 42 });
      assert.equal(host.inspect().ready, true);
      yield* f.emit({ method, params: { threadId: "thread" }, emittedAtMs: 43 });
      assert.equal((yield* host.closed).failure, "not_ready");
    }),
  );
}

it.effect("checks matching settings and ignores child settings", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    yield* f.emit({
      method: "thread/settings/updated",
      params: { threadId: "child", threadSettings: { ...matchingSettings, model: "other" } },
      emittedAtMs: 42,
    });
    yield* f.emit({
      method: "thread/settings/updated",
      params: { threadId: "thread", threadSettings: matchingSettings },
      emittedAtMs: 43,
    });
    assert.equal(host.inspect().ready, true);
    yield* f.emit({
      method: "thread/settings/updated",
      params: {
        threadId: "thread",
        threadSettings: { ...matchingSettings, sandboxPolicy: { type: "readOnly" } },
      },
      emittedAtMs: 44,
    });
    assert.equal((yield* host.closed).failure, "settings_mismatch");
  }),
);

it.effect("rejects a reroute away from the selected model while retaining child isolation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    yield* f.emit({
      method: "model/rerouted",
      params: {
        threadId: "child",
        turnId: "child-turn",
        fromModel: "gpt-5.2",
        toModel: "other",
        reason: "test",
      },
      emittedAtMs: 42,
    });
    const turn = yield* host.prompt("hello");
    yield* f.emit({
      method: "model/rerouted",
      params: {
        threadId: "thread",
        turnId: "turn",
        fromModel: "gpt-5.2",
        toModel: "other",
        reason: "test",
      },
      emittedAtMs: 43,
    });
    assert.ok(Result.isFailure(yield* Effect.result(turn.completed)));
    assert.equal((yield* host.closed).failure, "settings_mismatch");
  }),
);

it.effect("discards private advisory content before and after a turn without retaining prose", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    yield* f.emit({
      method: "item/reasoning/textDelta",
      params: { delta: "PRIVATE_ADVISORY" },
      emittedAtMs: 42,
    });
    const turn = yield* host.prompt("hello");
    yield* f.emit({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
    });
    yield* turn.completed;
    yield* f.emit({ method: "thread/goal/cleared", params: {}, emittedAtMs: 43 });
    assert.equal(host.inspect().ready, true);
    assert.notInclude(JSON.stringify(host.inspect()), "PRIVATE_ADVISORY");
    yield* host.stop;
  }),
);
