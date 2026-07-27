import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Match, Path, Ref, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  encodeRunnerOperation,
  type ExecRuntime,
  type RunnerFailure,
  type RunnerFailureCode,
  type RunnerOperation,
  type RunnerPhase,
  type RunnerResponse,
  type RunnerResult,
} from "./runner-protocol";

const OUTPUT_LIMIT = 64 * 1024;

interface BoundedOutput {
  readonly chunks: Array<Uint8Array>;
  readonly size: number;
}

interface RuntimeRecord {
  readonly phase: Exclude<RunnerPhase, "absent">;
}

interface Receipt {
  readonly intent: string;
  readonly response: RunnerResponse;
}

interface RunnerRuntimeShape {
  readonly handle: (operation: RunnerOperation) => Effect.Effect<RunnerResponse>;
}

export class RunnerRuntime extends Context.Service<RunnerRuntime, RunnerRuntimeShape>()(
  "scotty/cli/RunnerRuntime",
) {}

export interface RunnerRuntimeConfig {
  readonly root: string;
  readonly childEnvironment: Readonly<Record<string, string>>;
}

const encodeSessionId = (sessionId: string): string =>
  createHash("sha256").update(sessionId).digest("hex");

const failure = (operation: RunnerOperation, code: RunnerFailureCode): RunnerFailure => ({
  _tag: "RunnerFailure",
  version: 1,
  operationId: operation.operationId,
  sessionId: operation.sessionId,
  code,
});

const success = (operation: RunnerOperation, result: RunnerResult): RunnerResponse => ({
  _tag: "RunnerSuccess",
  version: 1,
  operationId: operation.operationId,
  sessionId: operation.sessionId,
  result,
});

const mapExternalFailure =
  (operation: RunnerOperation, code: "filesystem_failed" | "process_failed") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RunnerFailure, R> =>
    Effect.mapError(effect, () => failure(operation, code));

const collectOutput = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<string, E, R> =>
  Stream.runFold(
    stream,
    (): BoundedOutput => ({ chunks: [], size: 0 }),
    (output, chunk) => {
      const remaining = OUTPUT_LIMIT - output.size;
      if (remaining <= 0) return output;
      const retained = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      output.chunks.push(retained);
      return {
        chunks: output.chunks,
        size: output.size + retained.byteLength,
      };
    },
  ).pipe(
    Effect.map(({ chunks, size }) => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }),
  );

export const makeRunnerRuntime = Effect.fnUntraced(function* (config: RunnerRuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.resolve(config.root);
  const runtimes = yield* Ref.make(new Map<string, RuntimeRecord>());
  const receipts = yield* Ref.make(new Map<string, Receipt>());
  const sessionMutexes = new Map<string, Semaphore.Semaphore>();

  const sessionMutex = (sessionId: string): Semaphore.Semaphore => {
    const existing = sessionMutexes.get(sessionId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    sessionMutexes.set(sessionId, created);
    return created;
  };

  const coordinates = (sessionId: string) => {
    const encoded = encodeSessionId(sessionId);
    return {
      workspace: path.join(root, "sessions", `session-${encoded}`),
      resourceId: `runner-v1:${encoded}`,
    };
  };

  const observe = Effect.fnUntraced(function* (operation: RunnerOperation) {
    const { workspace } = coordinates(operation.sessionId);
    const exists = yield* fs
      .exists(workspace)
      .pipe(mapExternalFailure(operation, "filesystem_failed"));
    if (!exists) {
      yield* Ref.update(runtimes, (records) => {
        const next = new Map(records);
        next.delete(operation.sessionId);
        return next;
      });
      return "absent";
    }
    return (yield* Ref.get(runtimes)).get(operation.sessionId)?.phase ?? "stopped";
  });

  const stateResult = (
    operation: RunnerOperation,
    resultTag:
      | "EnsureRuntimeResult"
      | "InspectRuntimeResult"
      | "StopRuntimeResult"
      | "RemoveRuntimeResult",
    phase: RunnerPhase,
  ): RunnerResult => {
    const { resourceId, workspace } = coordinates(operation.sessionId);
    return { _tag: resultTag, phase, resourceId, workspace };
  };

  const resolveCwd = Effect.fnUntraced(function* (operation: ExecRuntime, workspace: string) {
    if (operation.cwd === undefined) {
      return workspace;
    }
    if (path.isAbsolute(operation.cwd)) {
      return yield* Effect.fail(failure(operation, "invalid_cwd"));
    }
    const target = path.resolve(workspace, operation.cwd);
    const relative = path.relative(workspace, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* Effect.fail(failure(operation, "invalid_cwd"));
    }
    const [realWorkspace, realTarget] = yield* Effect.all([
      fs.realPath(workspace),
      fs.realPath(target),
    ]).pipe(mapExternalFailure(operation, "filesystem_failed"));
    const realRelative = path.relative(realWorkspace, realTarget);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      return yield* Effect.fail(failure(operation, "invalid_cwd"));
    }
    return realTarget;
  });

  const execute = (operation: RunnerOperation) => {
    const { workspace } = coordinates(operation.sessionId);
    return Match.value(operation).pipe(
      Match.tagsExhaustive({
        EnsureRuntime: (operation) =>
          Effect.gen(function* () {
            const phase = yield* observe(operation);
            if (phase === "absent") {
              yield* fs
                .makeDirectory(workspace, { recursive: true })
                .pipe(mapExternalFailure(operation, "filesystem_failed"));
            }
            yield* Ref.update(runtimes, (records) => {
              const next = new Map(records);
              next.set(operation.sessionId, { phase: "running" });
              return next;
            });
            return success(operation, stateResult(operation, "EnsureRuntimeResult", "running"));
          }),
        InspectRuntime: (operation) =>
          Effect.map(observe(operation), (phase) =>
            success(operation, stateResult(operation, "InspectRuntimeResult", phase)),
          ),
        ExecRuntime: (operation) =>
          Effect.gen(function* () {
            const phase = yield* observe(operation);
            if (phase !== "running") {
              return failure(operation, "runtime_not_running");
            }
            const cwd = yield* resolveCwd(operation, workspace);
            const command = ChildProcess.make(operation.argv[0], operation.argv.slice(1), {
              cwd,
              env: { ...config.childEnvironment },
              extendEnv: false,
              forceKillAfter: "2 seconds",
              killSignal: "SIGTERM",
              shell: false,
            });
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* command;
                const [stdout, stderr, exitCode] = yield* Effect.all(
                  [collectOutput(handle.stdout), collectOutput(handle.stderr), handle.exitCode],
                  { concurrency: "unbounded" },
                );
                return {
                  _tag: "ExecRuntimeResult" as const,
                  exitCode: Number(exitCode),
                  stdout,
                  stderr,
                };
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              ),
            ).pipe(mapExternalFailure(operation, "process_failed"));
            return success(operation, result);
          }),
        StopRuntime: (operation) =>
          Effect.gen(function* () {
            const phase = yield* observe(operation);
            if (phase === "running") {
              yield* Ref.update(runtimes, (records) => {
                const next = new Map(records);
                next.set(operation.sessionId, { phase: "stopped" });
                return next;
              });
            }
            const stoppedPhase = phase === "absent" ? "absent" : "stopped";
            return success(operation, stateResult(operation, "StopRuntimeResult", stoppedPhase));
          }),
        RemoveRuntime: (operation) =>
          Effect.gen(function* () {
            yield* fs
              .remove(workspace, { recursive: true, force: true })
              .pipe(mapExternalFailure(operation, "filesystem_failed"));
            yield* Ref.update(runtimes, (records) => {
              const next = new Map(records);
              next.delete(operation.sessionId);
              return next;
            });
            return success(operation, stateResult(operation, "RemoveRuntimeResult", "absent"));
          }),
      }),
    );
  };

  const handle = Effect.fnUntraced(function* (operation: RunnerOperation) {
    const key = `${operation.sessionId}\0${operation.operationId}`;
    const intent = encodeRunnerOperation(operation);
    const existing = (yield* Ref.get(receipts)).get(key);
    if (existing !== undefined) {
      return existing.intent === intent
        ? existing.response
        : failure(operation, "idempotency_conflict");
    }
    const response = yield* execute(operation).pipe(
      Effect.catch((runnerFailure) => Effect.succeed(runnerFailure)),
    );
    yield* Ref.update(receipts, (entries) => {
      const next = new Map(entries);
      next.set(key, { intent, response });
      return next;
    });
    return response;
  });

  return RunnerRuntime.of({
    handle: (operation) => sessionMutex(operation.sessionId).withPermit(handle(operation)),
  });
});

export const runnerRuntimeLayer = (
  config: RunnerRuntimeConfig,
): Layer.Layer<
  RunnerRuntime,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(RunnerRuntime)(makeRunnerRuntime(config));
