import { assert, describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Result, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { decodeCodexClientMessage } from "../../../../protocol/codex-app-server";
import { makeSession } from "../../../src/agent/codex/session";
import type { CodexProcess } from "../../../src/agent/codex/process";
import { makeCodexRuntime, readCodexSnapshot } from "../../../src/agent/codex/runtime";

const fixture = Effect.fnUntraced(function* (accept = true, expiresAt = Number.MAX_SAFE_INTEGER) {
  const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const exited = yield* Deferred.make<void>();
  const prompted = yield* Deferred.make<void>();
  const emit = (value: unknown) =>
    Queue.offer(output, new TextEncoder().encode(`${JSON.stringify(value)}\n`)).pipe(Effect.asVoid);
  let stops = 0;
  let prompts = 0;
  const transport: CodexProcess = {
    pid: ChildProcessSpawner.ProcessId(100),
    platformOs: "linux",
    homes: { home: "/runtime/home", codexHome: "/runtime/codex-home", cwd: "/workspace" },
    options: {
      binary: "/codex",
      runtimeDir: "/runtime",
      workspace: "/workspace",
      model: "gpt-5.4",
      effort: "high",
      credential: { sentinel: "unused-synthetic", expiresAt },
      requestTimeoutMs: 100,
      turnTimeoutMs: 500,
      stopTimeoutMs: 10,
    },
    stdout: Stream.fromQueue(output),
    stderr: Stream.empty,
    writer: Effect.never,
    exit: Deferred.await(exited),
    stop: Effect.gen(function* () {
      stops++;
      yield* Deferred.succeed(exited, undefined);
      yield* Queue.end(output);
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
      const parsed = decodeCodexClientMessage(new TextDecoder().decode(bytes));
      assert.ok(Result.isSuccess(parsed));
      const message = parsed.success;
      if (message.method === "initialize")
        yield* emit({
          id: message.id,
          result: {
            userAgent: "scotty-component/0.153.4 fixture",
            codexHome: "/runtime/codex-home",
            platformFamily: "unix",
            platformOs: "linux",
          },
        });
      if (message.method === "thread/start")
        yield* emit({
          id: message.id,
          result: {
            thread: { id: "thread" },
            model: "gpt-5.4",
            modelProvider: "scotty-managed",
            cwd: "/workspace",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: "high",
          },
        });
      if (message.method === "turn/start") {
        prompts++;
        yield* Deferred.succeed(prompted, undefined);
        if (accept) {
          yield* emit({
            id: message.id,
            result: { turn: { id: "turn", status: "inProgress", items: [] } },
          });
          yield* emit({
            method: "turn/started",
            params: { threadId: "thread", turn: { id: "turn", status: "inProgress", items: [] } },
          });
        }
      }
    }),
  };
  const host = yield* makeSession(transport);
  const runtime = yield* makeCodexRuntime(host, "generation-1");
  const complete = (threadId = "thread") =>
    emit({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: "turn",
          status: "completed",
          items: [{ type: "agentMessage", id: "answer", text: "synthetic answer" }],
        },
      },
    });
  return {
    runtime,
    host,
    emit,
    complete,
    prompted,
    exited,
    stops: () => stops,
    prompts: () => prompts,
  };
});

const command = { threadId: "thread", text: "hello" };
describe("Codex generation bridge over production session adapter", () => {
  it.effect(
    "closing the generation scope stops an outstanding turn through the existing host",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const f = yield* fixture().pipe(Scope.provide(scope));
        yield* f.runtime.admit(command);
        yield* Scope.close(scope, Exit.void);
        assert.equal(f.stops(), 1);
        assert.equal((yield* f.runtime.snapshot).ready, false);
        assert.equal((yield* f.runtime.snapshot).cleanup?.cleanup, "ambiguous");
      }),
  );

  it.effect(
    "returns native admission before terminal and retains one correlated bounded read",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal((yield* f.runtime.snapshot).settings.sandbox, "dangerFullAccess");
        const admitted = yield* f.runtime.admit(command);
        assert.deepEqual(admitted, {
          generation: "generation-1",
          threadId: "thread",
          turnId: "turn",
        });
        assert.deepEqual((yield* f.runtime.snapshot).prompt, { status: "running", turnId: "turn" });
        const busy = yield* Effect.result(f.runtime.admit(command));
        assert.ok(Result.isFailure(busy));
        assert.equal(busy.failure.code, "busy");
        yield* f.complete();
        yield* TestClock.adjust(1);
        const snapshot = yield* f.runtime.snapshot;
        assert.deepEqual(snapshot.prompt, {
          status: "terminal",
          turnId: "turn",
          outcome: "completed",
          text: "synthetic answer",
        });
        assert.deepEqual(
          yield* readCodexSnapshot(JSON.stringify(snapshot), {
            generation: "generation-1",
            threadId: "thread",
          }),
          snapshot,
        );
        const replay = yield* Effect.result(f.runtime.admit(command));
        assert.ok(Result.isFailure(replay));
        assert.equal(replay.failure.code, "already_admitted");
        assert.equal(f.prompts(), 1);
        assert.equal(JSON.stringify(snapshot).includes("sentinel"), false);
      }),
  );

  it.effect("rejects wrong thread and malformed/oversized prompt before any native write", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const input of [
        { ...command, threadId: "wrong" },
        { ...command, text: "💥".repeat(17000) },
        { ...command, credential: "forbidden" },
      ]) {
        const result = yield* Effect.result(f.runtime.admit(input));
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.outcome, "rejected");
      }
      assert.equal(f.prompts(), 0);
      assert.equal((yield* f.runtime.snapshot).prompt.status, "idle");
    }),
  );

  it.effect(
    "admitting is fenced; caller cancellation does not cancel generation-owned observation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false);
        const caller = yield* f.runtime.admit(command).pipe(Effect.forkChild);
        yield* Deferred.await(f.prompted);
        const busy = yield* Effect.result(f.runtime.admit(command));
        assert.ok(Result.isFailure(busy));
        assert.equal(busy.failure.code, "busy");
        yield* Fiber.interrupt(caller);
        assert.equal((yield* f.runtime.snapshot).prompt.status, "admitting");
        yield* TestClock.adjust(101);
        const snapshot = yield* f.runtime.snapshot;
        assert.equal(snapshot.ready, false);
        assert.equal(snapshot.failure, "request_timeout");
        assert.equal(snapshot.prompt.status, "failed");
        assert.equal(f.stops(), 1);
      }),
  );

  it.effect(
    "a cancelled admission caller can later read the accepted terminal without replay",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false);
        const caller = yield* f.runtime.admit(command).pipe(Effect.forkChild);
        yield* Deferred.await(f.prompted);
        yield* Fiber.interrupt(caller);
        yield* f.emit({ id: 3, result: { turn: { id: "turn", status: "inProgress", items: [] } } });
        yield* f.emit({
          method: "turn/started",
          params: { threadId: "thread", turn: { id: "turn", status: "inProgress", items: [] } },
        });
        yield* f.complete();
        yield* TestClock.adjust(1);
        const proof = yield* readCodexSnapshot(JSON.stringify(yield* f.runtime.snapshot), {
          generation: "generation-1",
          threadId: "thread",
          turnId: "turn",
        });
        assert.equal(proof.prompt.status, "terminal");
        assert.equal(f.prompts(), 1);
        const stale = yield* Effect.result(
          readCodexSnapshot(JSON.stringify(proof), { generation: "generation-1", turnId: "other" }),
        );
        assert.ok(Result.isFailure(stale));
        assert.equal(stale.failure.code, "wrong_turn");
      }),
  );

  it.effect(
    "retains typed credential expiry instead of misclassifying it as an invalid snapshot",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, 1);
        yield* TestClock.adjust(2);
        const result = yield* Effect.result(f.runtime.admit(command));
        assert.ok(Result.isFailure(result));
        const proof = yield* f.runtime.snapshot;
        assert.equal(proof.ready, false);
        assert.equal(proof.failure, "credential_expired");
        assert.equal(f.prompts(), 0);
      }),
  );

  it.effect("native admission timeout is typed ambiguous, never a successful create", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const caller = yield* f.runtime.admit(command).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(f.prompted);
      yield* TestClock.adjust(101);
      const result = yield* Fiber.join(caller);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.code, "host_failed");
      assert.equal(result.failure.outcome, "ambiguous");
    }),
  );

  for (const failure of ["wrong-thread", "exit", "turn-timeout"] as const)
    it.effect(`exposes ${failure} through read and invokes existing host cleanup`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.runtime.admit(command);
        if (failure === "wrong-thread") yield* f.complete("stale-thread");
        if (failure === "exit") yield* Deferred.succeed(f.exited, undefined);
        yield* TestClock.adjust(failure === "turn-timeout" ? 501 : 1);
        const snapshot = yield* f.runtime.snapshot;
        assert.equal(snapshot.ready, false);
        assert.equal(
          snapshot.failure,
          failure === "wrong-thread"
            ? "stale_notification"
            : failure === "exit"
              ? "unexpected_exit"
              : "turn_timeout",
        );
        assert.equal(snapshot.prompt.status, "failed");
        assert.equal(snapshot.cleanup?.cleanup, "ambiguous");
        assert.equal(f.stops(), 1);
      }),
    );

  it.effect("stop is cached graceful host evidence, not full runtime destruction", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.runtime.admit(command);
      const receipt = yield* f.runtime.stop;
      assert.strictEqual(yield* f.runtime.stop, receipt);
      yield* TestClock.adjust(1);
      const snapshot = yield* f.runtime.snapshot;
      assert.equal(snapshot.ready, false);
      assert.equal(snapshot.cleanup?.shutdown, "eof");
      assert.equal(snapshot.cleanup?.descendants, "unverified");
      assert.equal(snapshot.cleanup?.cleanup, "ambiguous");
      assert.equal(f.stops(), 1);
    }),
  );

  it.effect("rejects invalid, oversized, stale-generation and wrong-thread read proofs", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const snapshot = yield* f.runtime.snapshot;
      for (const [body, expected, code] of [
        ["not-json", { generation: "generation-1" }, "invalid_snapshot"],
        [" ".repeat(524289), { generation: "generation-1" }, "invalid_snapshot"],
        [
          JSON.stringify({ ...snapshot, settings: { ...snapshot.settings, sandbox: "readOnly" } }),
          { generation: "generation-1" },
          "invalid_snapshot",
        ],
        [JSON.stringify(snapshot), { generation: "other" }, "stale_generation"],
        [
          JSON.stringify(snapshot),
          { generation: "generation-1", threadId: "other" },
          "wrong_thread",
        ],
      ] as const) {
        const result = yield* Effect.result(readCodexSnapshot(body, expected));
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure.code, code);
      }
    }),
  );
});
