import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PIDS_LIMIT = 512;
const CHILD_ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "SHELL", "TERM", "TZ", "USER"] as const;

export const RunnerComputeFailureCodeSchema = Schema.Literals([
  "filesystem_failed",
  "invalid_cwd",
  "process_failed",
  "runtime_not_running",
]);
export type RunnerComputeFailureCode = typeof RunnerComputeFailureCodeSchema.Type;

export class RunnerComputeFailure extends Schema.TaggedErrorClass<RunnerComputeFailure>(
  "RunnerComputeFailure",
)("RunnerComputeFailure", {
  code: RunnerComputeFailureCodeSchema,
}) {
  override readonly message = "Runner compute operation failed";
}

export interface RunnerComputeCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunnerComputeProcess {
  readonly run: (
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<RunnerComputeCommandOutput, RunnerComputeFailure>;
}

export type IsolatedRuntimePhase = "absent" | "running" | "stopped";

export interface IsolatedRuntimeState {
  readonly phase: IsolatedRuntimePhase;
  readonly resourceId: string;
  readonly workspace: string;
}

export interface IsolatedRuntimeExecInput {
  readonly argv: readonly [string, ...Array<string>];
  /**
   * The caller must first enforce canonical, symlink-aware containment against
   * the host workspace. This driver only maps the retained relative path into
   * the container's fixed /workspace mount.
   */
  readonly relativeCwd?: string;
}

export interface IsolatedRuntimeCompute {
  readonly ensure: (sessionId: string) => Effect.Effect<IsolatedRuntimeState, RunnerComputeFailure>;
  readonly inspect: (
    sessionId: string,
  ) => Effect.Effect<IsolatedRuntimeState, RunnerComputeFailure>;
  /**
   * Interruption only terminates the local Docker CLI handle. It does not prove
   * that the in-container process stopped, so callers must record an ambiguous
   * execution as unknown and require an explicit runtime stop before recovery.
   */
  readonly exec: (
    sessionId: string,
    input: IsolatedRuntimeExecInput,
  ) => Effect.Effect<RunnerComputeCommandOutput, RunnerComputeFailure>;
  readonly stop: (sessionId: string) => Effect.Effect<IsolatedRuntimeState, RunnerComputeFailure>;
  readonly remove: (sessionId: string) => Effect.Effect<IsolatedRuntimeState, RunnerComputeFailure>;
}

export interface DockerRunnerComputeConfig {
  readonly root: string;
  readonly image: string;
  readonly uid: number;
  readonly gid: number;
  readonly safePath: string;
  readonly childEnvironment: Readonly<Record<string, string>>;
  readonly memoryBytes?: number;
  readonly pidsLimit?: number;
}

interface BoundedOutput {
  readonly chunks: Array<Uint8Array>;
  readonly size: number;
}

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

export const makeRunnerComputeProcess = (
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  executable = "/usr/bin/docker",
): RunnerComputeProcess => ({
  run: (argv) => {
    const command = ChildProcess.make(executable, argv, {
      env: {},
      extendEnv: false,
      forceKillAfter: "2 seconds",
      killSignal: "SIGTERM",
      shell: false,
    });
    return Effect.scoped(
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
  },
});

const encodeSessionId = (sessionId: string): string =>
  createHash("sha256").update(sessionId).digest("hex");

const fixedFailure =
  (code: RunnerComputeFailureCode) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RunnerComputeFailure, R> =>
    Effect.mapError(effect, () => new RunnerComputeFailure({ code }));

const childEnvironmentArguments = (
  safePath: string,
  environment: Readonly<Record<string, string>>,
): ReadonlyArray<string> => {
  const argv: Array<string> = [
    "--env",
    "HOME=/workspace/.home",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    `PATH=${safePath}`,
  ];
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) argv.push("--env", `${key}=${value}`);
  }
  return argv;
};

const containerWorkingDirectory = (
  relativeCwd: string | undefined,
): Effect.Effect<string, RunnerComputeFailure> => {
  if (relativeCwd === undefined || relativeCwd === "" || relativeCwd === ".") {
    return Effect.succeed("/workspace");
  }
  if (posix.isAbsolute(relativeCwd)) {
    return Effect.fail(new RunnerComputeFailure({ code: "invalid_cwd" }));
  }
  const normalized = posix.normalize(relativeCwd);
  if (normalized === ".." || normalized.startsWith("../")) {
    return Effect.fail(new RunnerComputeFailure({ code: "invalid_cwd" }));
  }
  return Effect.succeed(posix.join("/workspace", normalized));
};

export const makeDockerRunnerCompute = Effect.fnUntraced(function* (
  config: DockerRunnerComputeConfig,
  process: RunnerComputeProcess,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(config.root);
  const memoryBytes = config.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const pidsLimit = config.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  const environmentArguments = childEnvironmentArguments(config.safePath, config.childEnvironment);

  const coordinates = (sessionId: string) => {
    const encoded = encodeSessionId(sessionId);
    return {
      container: `scotty-runner-v1-${encoded}`,
      resourceId: `runner-v1:${encoded}`,
      workspace: path.join(root, "sessions", `session-${encoded}`),
    };
  };

  const runRequired = Effect.fnUntraced(function* (argv: ReadonlyArray<string>) {
    const output = yield* process.run(argv);
    if (output.exitCode !== 0) {
      return yield* new RunnerComputeFailure({ code: "process_failed" });
    }
    return output;
  });

  const exists = Effect.fnUntraced(function* (container: string) {
    const output = yield* runRequired([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${container}$`,
    ]);
    return output.stdout.trim().length > 0;
  });

  const phase = Effect.fnUntraced(function* (container: string) {
    if (!(yield* exists(container))) return "absent";
    const output = yield* runRequired([
      "container",
      "inspect",
      "--format={{.State.Running}}",
      container,
    ]);
    const running = output.stdout.trim();
    if (running === "true") return "running";
    if (running === "false") return "stopped";
    return yield* new RunnerComputeFailure({ code: "process_failed" });
  });

  const state = (sessionId: string, runtimePhase: IsolatedRuntimePhase): IsolatedRuntimeState => {
    const { resourceId, workspace } = coordinates(sessionId);
    return { phase: runtimePhase, resourceId, workspace };
  };

  const inspect = Effect.fnUntraced(function* (sessionId: string) {
    const { container } = coordinates(sessionId);
    return state(sessionId, yield* phase(container));
  });

  const ensure = Effect.fnUntraced(function* (sessionId: string) {
    const { container, workspace } = coordinates(sessionId);
    const home = path.join(workspace, ".home");
    yield* fs
      .makeDirectory(workspace, { recursive: true, mode: 0o700 })
      .pipe(fixedFailure("filesystem_failed"));
    yield* fs.chmod(workspace, 0o700).pipe(fixedFailure("filesystem_failed"));
    yield* fs
      .makeDirectory(home, { recursive: true, mode: 0o700 })
      .pipe(fixedFailure("filesystem_failed"));
    yield* fs.chmod(home, 0o700).pipe(fixedFailure("filesystem_failed"));
    const observed = yield* phase(container);
    if (observed === "absent") {
      yield* runRequired([
        "container",
        "create",
        "--name",
        container,
        "--user",
        `${config.uid}:${config.gid}`,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m",
        "--tmpfs",
        "/var/tmp:rw,nosuid,nodev,size=64m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--memory",
        `${memoryBytes}b`,
        "--memory-swap",
        `${memoryBytes}b`,
        "--pids-limit",
        String(pidsLimit),
        "--network",
        "bridge",
        "--mount",
        `type=bind,source=${workspace},target=/workspace`,
        "--workdir",
        "/workspace",
        ...environmentArguments,
        config.image,
        "tail",
        "-f",
        "/dev/null",
      ]);
      yield* runRequired(["container", "start", container]);
    } else if (observed === "stopped") {
      yield* runRequired(["container", "start", container]);
    }
    return state(sessionId, "running");
  });

  const exec = Effect.fnUntraced(function* (sessionId: string, input: IsolatedRuntimeExecInput) {
    const { container } = coordinates(sessionId);
    if ((yield* phase(container)) !== "running") {
      return yield* new RunnerComputeFailure({ code: "runtime_not_running" });
    }
    const cwd = yield* containerWorkingDirectory(input.relativeCwd);
    return yield* process.run(["container", "exec", "--workdir", cwd, container, ...input.argv]);
  });

  const stop = Effect.fnUntraced(function* (sessionId: string) {
    const { container } = coordinates(sessionId);
    const observed = yield* phase(container);
    if (observed === "running") {
      yield* runRequired(["container", "stop", "--time", "10", container]);
      return state(sessionId, "stopped");
    }
    return state(sessionId, observed);
  });

  const remove = Effect.fnUntraced(function* (sessionId: string) {
    const { container, workspace } = coordinates(sessionId);
    if ((yield* phase(container)) !== "absent") {
      yield* runRequired(["container", "rm", "--force", container]);
    }
    yield* fs
      .remove(workspace, { recursive: true, force: true })
      .pipe(fixedFailure("filesystem_failed"));
    return state(sessionId, "absent");
  });

  return {
    ensure,
    inspect,
    exec,
    stop,
    remove,
  } satisfies IsolatedRuntimeCompute;
});
