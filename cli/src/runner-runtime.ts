import { createHash } from "node:crypto";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Path,
  Predicate,
  Ref,
  Result,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  type IsolatedRuntimeCompute,
  type IsolatedRuntimeExecInput,
  type IsolatedRuntimeState,
  makeDockerRunnerCompute,
  makeRunnerComputeProcess,
  RunnerComputeFailure,
} from "./runner-docker";
import { makeRunnerOperationJournal } from "./runner-operation-journal";
import {
  type ExecRuntime,
  type RunnerFailure,
  type RunnerFailureCode,
  type RunnerOperation,
  type RunnerPhase,
  type RunnerResponse,
  type RunnerResult,
} from "../../protocol/runner";

const OUTPUT_LIMIT = 64 * 1024;

interface BoundedOutput {
  readonly chunks: Array<Uint8Array>;
  readonly size: number;
}

interface RuntimeRecord {
  readonly phase: Exclude<RunnerPhase, "absent">;
}

interface RunnerRuntimeShape {
  readonly handle: (operation: RunnerOperation) => Effect.Effect<RunnerResponse>;
  readonly mountedHttp: (
    identity: { readonly runtimeId: string; readonly sessionId: string },
    request: Request,
  ) => Effect.Effect<Response, unknown>;
}

export class RunnerRuntime extends Context.Service<RunnerRuntime, RunnerRuntimeShape>()(
  "scotty/cli/RunnerRuntime",
) {}

export interface RunnerRuntimeConfig {
  /**
   * A runner root may have exactly one live runtime writer.
   */
  readonly root: string;
  readonly childEnvironment: Readonly<Record<string, string>>;
  readonly runnerIdentity?: string;
  readonly hostFetch?: (request: Request) => Promise<Response>;
  readonly isolation:
    | { readonly type: "process" }
    | {
        readonly type: "docker";
        readonly image: string;
        readonly uid: number;
        readonly gid: number;
        readonly safePath: string;
      };
}

const encodeSessionId = (sessionId: string): string =>
  createHash("sha256").update(sessionId).digest("hex");

const failure = (operation: RunnerOperation, code: RunnerFailureCode): RunnerFailure => ({
  _tag: "RunnerFailure",
  version: 2,
  operationId: operation.operationId,
  sessionId: operation.sessionId,
  code,
});

const success = (operation: RunnerOperation, result: RunnerResult): RunnerResponse => ({
  _tag: "RunnerSuccess",
  version: 2,
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

const makeProcessRunnerCompute = Effect.fnUntraced(function* (
  config: RunnerRuntimeConfig,
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(config.root);
  const runtimes = yield* Ref.make(new Map<string, RuntimeRecord>());

  const coordinates = (sessionId: string) => {
    const encoded = encodeSessionId(sessionId);
    return {
      workspace: path.join(root, "sessions", `session-${encoded}`),
      resourceId: `runner-v1:${encoded}`,
    };
  };

  const observe = Effect.fnUntraced(function* (sessionId: string) {
    const { workspace } = coordinates(sessionId);
    const exists = yield* fs
      .exists(workspace)
      .pipe(Effect.mapError(() => new RunnerComputeFailure({ code: "filesystem_failed" })));
    if (!exists) {
      yield* Ref.update(runtimes, (records) => {
        const next = new Map(records);
        next.delete(sessionId);
        return next;
      });
      return "absent";
    }
    return (yield* Ref.get(runtimes)).get(sessionId)?.phase ?? "stopped";
  });

  const state = (sessionId: string, phase: RunnerPhase): IsolatedRuntimeState => {
    const { resourceId, workspace } = coordinates(sessionId);
    return { phase, resourceId, workspace };
  };

  const ensure = Effect.fnUntraced(function* (sessionId: string) {
    const { workspace } = coordinates(sessionId);
    const phase = yield* observe(sessionId);
    if (phase === "absent") {
      yield* fs
        .makeDirectory(workspace, { recursive: true })
        .pipe(Effect.mapError(() => new RunnerComputeFailure({ code: "filesystem_failed" })));
    }
    yield* Ref.update(runtimes, (records) => {
      const next = new Map(records);
      next.set(sessionId, { phase: "running" });
      return next;
    });
    return state(sessionId, "running");
  });

  const inspect = Effect.fnUntraced(function* (sessionId: string) {
    return state(sessionId, yield* observe(sessionId));
  });

  const exec = Effect.fnUntraced(function* (sessionId: string, input: IsolatedRuntimeExecInput) {
    if ((yield* observe(sessionId)) !== "running") {
      return yield* new RunnerComputeFailure({ code: "runtime_not_running" });
    }
    const { workspace } = coordinates(sessionId);
    const cwd =
      input.relativeCwd === undefined ? workspace : path.resolve(workspace, input.relativeCwd);
    const command = ChildProcess.make(input.argv[0], input.argv.slice(1), {
      cwd,
      env: { ...config.childEnvironment },
      extendEnv: false,
      forceKillAfter: "2 seconds",
      killSignal: "SIGTERM",
      shell: false,
    });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* command;
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collectOutput(handle.stdout), collectOutput(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return {
          exitCode: Number(exitCode),
          stdout,
          stderr,
        };
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
    ).pipe(Effect.mapError(() => new RunnerComputeFailure({ code: "process_failed" })));
  });

  const stop = Effect.fnUntraced(function* (sessionId: string) {
    const phase = yield* observe(sessionId);
    if (phase === "running") {
      yield* Ref.update(runtimes, (records) => {
        const next = new Map(records);
        next.set(sessionId, { phase: "stopped" });
        return next;
      });
    }
    return state(sessionId, phase === "absent" ? "absent" : "stopped");
  });

  const remove = Effect.fnUntraced(function* (sessionId: string) {
    const { workspace } = coordinates(sessionId);
    yield* fs
      .remove(workspace, { recursive: true, force: true })
      .pipe(Effect.mapError(() => new RunnerComputeFailure({ code: "filesystem_failed" })));
    yield* Ref.update(runtimes, (records) => {
      const next = new Map(records);
      next.delete(sessionId);
      return next;
    });
    return state(sessionId, "absent");
  });

  const mountedHttp = () => Effect.fail(new RunnerComputeFailure({ code: "runtime_not_running" }));

  return { ensure, inspect, exec, stop, remove, mountedHttp } satisfies IsolatedRuntimeCompute;
});

export const makeRunnerRuntimeWithCompute = Effect.fnUntraced(function* (
  config: RunnerRuntimeConfig,
  compute: IsolatedRuntimeCompute,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(config.root);
  const journal = yield* makeRunnerOperationJournal(root);
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
    };
  };

  const resolveRelativeCwd = Effect.fnUntraced(function* (
    operation: ExecRuntime,
    workspace: string,
  ) {
    if (operation.cwd === undefined) return undefined;
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
    return realRelative;
  });

  const computeResult = <A>(
    operation: RunnerOperation,
    effect: Effect.Effect<A, RunnerComputeFailure>,
  ): Effect.Effect<A, RunnerFailure> =>
    Effect.mapError(effect, (computeFailure) => failure(operation, computeFailure.code));

  const stateResult = (
    resultTag:
      | "EnsureRuntimeResult"
      | "InspectRuntimeResult"
      | "StopRuntimeResult"
      | "RemoveRuntimeResult",
    state: IsolatedRuntimeState,
  ): RunnerResult => ({ _tag: resultTag, ...state });

  const execute = (operation: RunnerOperation) =>
    Match.value(operation).pipe(
      Match.tagsExhaustive({
        EnsureRuntime: (operation) =>
          Effect.map(computeResult(operation, compute.ensure(operation.sessionId)), (state) =>
            success(operation, stateResult("EnsureRuntimeResult", state)),
          ),
        InspectRuntime: (operation) =>
          Effect.map(computeResult(operation, compute.inspect(operation.sessionId)), (state) =>
            success(operation, stateResult("InspectRuntimeResult", state)),
          ),
        ExecRuntime: (operation) =>
          Effect.gen(function* () {
            const { workspace } = coordinates(operation.sessionId);
            const relativeCwd = yield* resolveRelativeCwd(operation, workspace);
            const output = yield* computeResult(
              operation,
              compute.exec(operation.sessionId, {
                argv: operation.argv,
                ...(relativeCwd === undefined ? {} : { relativeCwd }),
              }),
            );
            return success(operation, {
              _tag: "ExecRuntimeResult",
              exitCode: output.exitCode,
              stdout: output.stdout,
              stderr: output.stderr,
            });
          }),
        StopRuntime: (operation) =>
          Effect.map(computeResult(operation, compute.stop(operation.sessionId)), (state) =>
            success(operation, stateResult("StopRuntimeResult", state)),
          ),
        RemoveRuntime: (operation) =>
          Effect.map(computeResult(operation, compute.remove(operation.sessionId)), (state) =>
            success(operation, stateResult("RemoveRuntimeResult", state)),
          ),
      }),
    );

  const handle = Effect.fnUntraced(function* (operation: RunnerOperation) {
    const preparedReceipt = yield* Effect.result(
      journal.prepare(operation).pipe(mapExternalFailure(operation, "filesystem_failed")),
    );
    if (Result.isFailure(preparedReceipt)) {
      return preparedReceipt.failure;
    }
    const preparation = preparedReceipt.success;
    const prepared = Match.value(preparation).pipe(
      Match.tagsExhaustive({
        ExecuteOperation: () => undefined,
        OperationConflict: () => failure(operation, "idempotency_conflict"),
        OperationUnknown: () => failure(operation, "operation_unknown"),
        RecoveryRequired: () => failure(operation, "recovery_required"),
        ReplayOperation: ({ response }) => response,
      }),
    );
    if (prepared !== undefined) return prepared;

    const response = yield* execute(operation).pipe(
      Effect.catch((runnerFailure) => Effect.succeed(runnerFailure)),
    );
    const completed = yield* Effect.result(journal.complete(operation, response));
    if (Result.isFailure(completed)) {
      return failure(operation, "operation_unknown");
    }
    const clearsRecoveryFence =
      Predicate.isTagged(operation, "ExecRuntime") ||
      (Predicate.isTagged(operation, "StopRuntime") &&
        Predicate.isTagged(response, "RunnerSuccess"));
    if (clearsRecoveryFence) {
      const cleared = yield* Effect.result(journal.clearRecoveryFence(operation.sessionId));
      if (Result.isFailure(cleared)) {
        return failure(operation, "operation_unknown");
      }
    }
    return response;
  });

  return RunnerRuntime.of({
    handle: (operation) => sessionMutex(operation.sessionId).withPermit(handle(operation)),
    mountedHttp: (identity, request) => {
      const hostFetch = config.hostFetch;
      return hostFetch === undefined
        ? Effect.fail(new RunnerComputeFailure({ code: "process_failed" }))
        : compute.mountedHttp(identity, request, hostFetch);
    },
  });
});

export const makeRunnerRuntime = Effect.fnUntraced(function* (config: RunnerRuntimeConfig) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const isolation = config.isolation;
  const compute =
    isolation.type === "docker"
      ? yield* makeDockerRunnerCompute(
          {
            root: config.root,
            image: isolation.image,
            uid: isolation.uid,
            gid: isolation.gid,
            safePath: isolation.safePath,
            childEnvironment: config.childEnvironment,
            runnerIdentity: config.runnerIdentity,
          },
          makeRunnerComputeProcess(childProcessSpawner, "/usr/bin/docker"),
        )
      : yield* makeProcessRunnerCompute(config, childProcessSpawner);
  return yield* makeRunnerRuntimeWithCompute(config, compute);
});

export const runnerRuntimeLayer = (
  config: RunnerRuntimeConfig,
): Layer.Layer<
  RunnerRuntime,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(RunnerRuntime)(makeRunnerRuntime(config));
