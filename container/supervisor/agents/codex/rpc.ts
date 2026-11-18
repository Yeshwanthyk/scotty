import { Cause, Deferred, Effect, Exit, Option, Queue, Result, Schema, Stream } from "effect";
import type { PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { AgentError, type AgentOutput } from "../../runner.js";
import { serverReply } from "./server-requests.js";
import { decodeRpcLine, RpcFailure } from "./rpc-schema.js";

type Outgoing = { line: string; written: Deferred.Deferred<void, AgentError> };
const redact = (line: string) =>
  line
    .replaceAll(String.fromCharCode(27), "")
    .replace(/\[[0-9;]*m/g, "")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]")
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);
const endedBy = (cause: Cause.Cause<PlatformError.PlatformError | Cause.TimeoutError>) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error) || error.value._tag !== "PlatformError") return "status unknown";
  const inner = error.value.cause;
  const signal = inner instanceof Error ? /SIG[A-Z0-9]+/.exec(inner.message)?.[0] : undefined;
  return signal ?? "killed by a signal";
};
export class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Deferred.Deferred<unknown, AgentError>>();
  private readonly outgoing: Queue.Queue<Outgoing>;
  private readonly writes = new Set<Deferred.Deferred<void, AgentError>>();
  private failed = false;
  private readonly stderr: string[] = [];
  private readonly eventsQueue: Queue.Queue<AgentOutput>;
  readonly events: Stream.Stream<AgentOutput>;

  constructor(
    private readonly child: ChildProcessSpawner.ChildProcessHandle,
    outgoing: Queue.Queue<Outgoing>,
    events: Queue.Queue<AgentOutput>,
  ) {
    this.outgoing = outgoing;
    this.eventsQueue = events;
    this.events = Stream.fromQueue(events);
  }
  static make(child: ChildProcessSpawner.ChildProcessHandle) {
    return Effect.gen(function* () {
      const outgoing = yield* Queue.unbounded<Outgoing>();
      const events = yield* Queue.unbounded<AgentOutput>();
      return new CodexRpc(child, outgoing, events);
    });
  }

  start = Effect.gen({ self: this }, function* () {
    yield* Stream.fromQueue(this.outgoing).pipe(
      Stream.runForEach(({ line, written }) =>
        Stream.run(Stream.make(new TextEncoder().encode(line)), this.child.stdin).pipe(
          Effect.tap(() => Deferred.succeed(written, undefined)),
          Effect.uninterruptible,
        ),
      ),
      Effect.catchCause(() =>
        this.failAll(new AgentError({ code: "exit", message: "Codex stdin closed" })),
      ),
      Effect.forkScoped,
    );
    yield* this.child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          this.stderr.push(redact(line));
          if (this.stderr.length > 20) this.stderr.shift();
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* this.child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => this.receive(line)),
      Effect.exit,
      Effect.andThen(
        this.exited("Codex stdout closed", this.child.exitCode.pipe(Effect.timeout("5 seconds"))),
      ),
      Effect.forkScoped,
    );
    yield* this.exited("Codex exited", this.child.exitCode).pipe(Effect.forkScoped);
  });

  private exited(
    what: string,
    status: Effect.Effect<number, PlatformError.PlatformError | Cause.TimeoutError>,
  ) {
    return status.pipe(
      Effect.exit,
      Effect.flatMap((exit) => {
        const ended = Exit.isSuccess(exit) ? `code ${exit.value}` : endedBy(exit.cause);
        const tail = this.stderr.slice(-5).join(" | ");
        return this.failAll(
          new AgentError({
            code: "exit",
            message: `${what} (${ended})${tail ? `: ${tail}` : ""}`.slice(0, 1000),
          }),
        );
      }),
    ) satisfies Effect.Effect<void>;
  }

  private failAll(error: AgentError) {
    return Effect.gen({ self: this }, function* () {
      if (this.failed) return;
      this.failed = true;
      for (const deferred of this.pending.values()) yield* Deferred.fail(deferred, error);
      this.pending.clear();
      for (const deferred of this.writes) yield* Deferred.fail(deferred, error);
      yield* Queue.offer(this.eventsQueue, {
        type: "error",
        code: error.code,
        message: error.message,
      });
    }) satisfies Effect.Effect<void>;
  }

  private receive(line: string) {
    return Effect.gen({ self: this }, function* () {
      const decoded = yield* decodeRpcLine(line).pipe(Effect.option);
      if (Option.isNone(decoded)) {
        yield* Queue.offer(this.eventsQueue, {
          type: "error",
          code: "protocol",
          message: "invalid Codex JSON-RPC",
        });
        return;
      }
      const { message, raw } = decoded.value;
      if (message.method !== undefined) {
        yield* Queue.offer(this.eventsQueue, {
          type: "agent",
          kind: "codex",
          event: raw,
        });
        if (message.id !== undefined) {
          yield* this.write(`${serverReply(message.method, message.id)}\n`).pipe(
            Effect.uninterruptible,
          );
          return;
        }
        return;
      }
      if (typeof message.id === "number") {
        const deferred = this.pending.get(message.id);
        if (deferred === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          const failure = Schema.decodeUnknownResult(RpcFailure)(message.error);
          yield* Deferred.fail(
            deferred,
            Result.isSuccess(failure)
              ? new AgentError({
                  code: String(failure.success.code),
                  message: failure.success.message,
                })
              : new AgentError({ code: "protocol", message: "invalid RPC error" }),
          );
        } else yield* Deferred.succeed(deferred, message.result);
      }
    }) satisfies Effect.Effect<void, AgentError>;
  }

  private write(line: string) {
    return Effect.gen({ self: this }, function* () {
      if (this.failed) return yield* new AgentError({ code: "exit", message: "Codex unavailable" });
      const written = yield* Deferred.make<void, AgentError>();
      this.writes.add(written);
      yield* Queue.offer(this.outgoing, { line, written });
      return yield* Deferred.await(written).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(new AgentError({ code: "timeout", message: "Codex stdin stalled" })),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            this.writes.delete(written);
          }),
        ),
      );
    }) satisfies Effect.Effect<void, AgentError>;
  }
  notify(method: string) {
    return this.write(`${JSON.stringify({ method })}\n`) satisfies Effect.Effect<void, AgentError>;
  }
  request(method: string, params: unknown) {
    return Effect.gen({ self: this }, function* () {
      if (this.failed) return yield* new AgentError({ code: "exit", message: "Codex unavailable" });
      const id = this.nextId++;
      const deferred = yield* Deferred.make<unknown, AgentError>();
      this.pending.set(id, deferred);
      return yield* this.write(`${JSON.stringify({ id, method, params })}\n`).pipe(
        Effect.flatMap(() =>
          Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () =>
                Effect.fail(new AgentError({ code: "timeout", message: `${method} timed out` })),
            }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.pending.delete(id);
          }),
        ),
      );
    }) satisfies Effect.Effect<unknown, AgentError>;
  }
}
