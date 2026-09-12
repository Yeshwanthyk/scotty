import { assert, describe, it } from "@effect/vitest";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Result, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  decodeCodexClientMessage,
  type CodexClientMessage,
} from "../../../../protocol/codex-app-server";
import { makeFramer } from "../../../src/agent/codex/framing";
import { makeSession } from "../../../src/agent/codex/session";
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
  | "durable-resume";

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
  const emit = (value: unknown) =>
    Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(value)}\n`)).pipe(Effect.asVoid);
  const emitSteerResponse = (message: CodexClientMessage) =>
    message.method === "turn/steer"
      ? emit(steerResponse(mode, message.id, message.params.expectedTurnId))
      : Effect.void;
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
      const result = decodeCodexClientMessage(new TextDecoder().decode(bytes));
      assert.ok(Result.isSuccess(result));
      const message = result.success;
      sent.push(message.method);
      messages.push(message);
      if (
        message.method === "initialize" &&
        (mode === "delayed" || mode === "no-thread-response" || mode === "no-initialized-write")
      )
        yield* Effect.sleep(mode === "delayed" ? 140 : 70);
      if (message.method === "initialized" && mode === "no-initialized-write")
        return yield* Effect.never;
      if (message.method === "initialize" && mode !== "no-initialize")
        yield* emit({
          id: mode === "wrong-id" ? String(message.id) : message.id,
          result: {
            userAgent: "scotty-component/0.153.4 test",
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
      if (message.method === "turn/start" && mode !== "no-turn-response") {
        yield* emit({
          id: message.id,
          result: { turn: { id: "turn", status: "inProgress", items: [] } },
        });
        yield* emit({
          method: "turn/started",
          params: { threadId: "thread", turn: { id: "turn", status: "inProgress", items: [] } },
        });
      }
      yield* emitSteerResponse(message);
      if (message.method === "turn/interrupt" && mode !== "no-interrupt-response")
        yield* emit({ id: message.id, result: {} });
    }),
  };
  return {
    transport,
    sent,
    messages,
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

  it.effect("keeps informational notifications turn-fenced", () =>
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
      const result = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "stale_notification");
      assert.equal(result.failure.staleDiagnostic, "item/reasoning/textDelta foreign active none");
      assert.equal((yield* host.closed).failure, "stale_notification");
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
    {
      method: "item/reasoning/textDelta",
      params: { threadId: "thread", itemId: "reasoning", delta: "missing turn", contentIndex: 0 },
    },
    { method: "future/notification", params: {} },
    { method: "item/started", params: { threadId: "thread", turnId: "turn", item: {} } },
  ] as const)
    it.effect(`rejects malformed or unknown notification ${event.method}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const host = yield* makeSession(f.transport);
        const turn = yield* host.prompt("hello");
        yield* f.emit(event);
        const result = yield* Effect.result(turn.completed);
        assert.ok(Result.isFailure(result));
        assert.equal(
          result.failure.code,
          event.method === "item/started" ? "invalid_message" : "unsupported_notification",
        );
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

it.effect("framing bounds bytes before decoding and preserves split UTF-8", () =>
  Effect.gen(function* () {
    const framer = makeFramer(1024);
    const lines: Array<string> = [];
    const receive = (line: string) =>
      Effect.sync(() => {
        lines.push(line);
      });
    yield* framer.push(new Uint8Array([0xc3]), receive);
    yield* framer.push(new Uint8Array([0xa9, 10]), receive);
    assert.deepEqual(lines, ["é"]);
    yield* framer.end;
    const result = yield* Effect.result(framer.push(new Uint8Array(1025), receive));
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure.code, "output_budget");
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

for (const stale of [false, true])
  it.effect(`native upstream failure is bounded and turn-fenced: stale=${stale}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const host = yield* makeSession(f.transport);
      const turn = yield* host.prompt("hello");
      yield* f.emit({
        method: "error",
        params: {
          threadId: stale ? "old-thread" : "thread",
          turnId: "turn",
          willRetry: false,
          error: { message: "untrusted credential detail", codexErrorInfo: "other" },
        },
      });
      const result = yield* Effect.result(turn.completed);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, stale ? "stale_notification" : "upstream_failed");
      assert.notInclude(JSON.stringify(result.failure), "untrusted credential detail");
      assert.equal((yield* host.closed).failure, stale ? "stale_notification" : "upstream_failed");
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
    const result = yield* Effect.result(turn.completed);
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure.code, "upstream_failed");
    assert.equal(host.inspect().failureDiagnostic, "httpConnectionFailed:503");
    assert.notInclude(JSON.stringify(host.inspect()), "untrusted upstream body");
  }),
);

it.effect("rejects a goal-cleared notification for a different thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const host = yield* makeSession(f.transport);
    yield* f.emit({ method: "thread/goal/cleared", params: { threadId: "another-thread" } });
    assert.equal((yield* host.closed).failure, "stale_notification");
  }),
);
