import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PIDS_LIMIT = 512;
const PICAN_PROXY_HEADER = "x-pican-proxy-token";
const PICAN_PORT = 31_415;
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
  readonly detach?: boolean;
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
  readonly mountedHttp: (
    identity: { readonly runtimeId: string; readonly sessionId: string },
    request: Request,
    hostFetch: (request: Request) => Promise<Response>,
  ) => Effect.Effect<Response, RunnerComputeFailure>;
}

export interface DockerRunnerComputeConfig {
  readonly root: string;
  readonly image: string;
  readonly uid: number;
  readonly gid: number;
  readonly safePath: string;
  readonly childEnvironment: Readonly<Record<string, string>>;
  readonly codexAuthSource: string;
  readonly githubConfigSource: string;
  readonly runnerIdentity?: string;
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
  sessionId: string,
): ReadonlyArray<string> => {
  const argv: Array<string> = [
    "--env",
    `HOME=/workspace/${sessionId}/.home`,
    "--env",
    "CODEX_HOME=/run/scotty/credentials/codex",
    "--env",
    "GH_CONFIG_DIR=/run/scotty/credentials/github",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    `PATH=${safePath}`,
    "--env",
    "PICAN_MODE=hosted",
    "--env",
    `PICAN_BASE_PATH=/s/${sessionId}`,
    "--env",
    `PICAN_WORKSPACE_ROOT=/workspace/${sessionId}`,
    "--env",
    `PICAN_STATE_ROOT=/workspace/${sessionId}/.pican`,
    "--env",
    "PICAN_AUTH_MODE=proxy",
    "--env",
    "PICAN_PROXY_HEADER=X-Pican-Proxy-Token",
  ];
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) argv.push("--env", `${key}=${value}`);
  }
  return argv;
};

const containerWorkingDirectory = (
  sessionId: string,
  relativeCwd: string | undefined,
): Effect.Effect<string, RunnerComputeFailure> => {
  const root = `/workspace/${sessionId}`;
  if (relativeCwd === undefined || relativeCwd === "" || relativeCwd === ".") {
    return Effect.succeed(root);
  }
  if (posix.isAbsolute(relativeCwd)) {
    return Effect.fail(new RunnerComputeFailure({ code: "invalid_cwd" }));
  }
  const normalized = posix.normalize(relativeCwd);
  if (normalized === ".." || normalized.startsWith("../")) {
    return Effect.fail(new RunnerComputeFailure({ code: "invalid_cwd" }));
  }
  return Effect.succeed(posix.join(root, normalized));
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

  const coordinates = (sessionId: string) => {
    const encoded = encodeSessionId(sessionId);
    const sessionRoot = path.join(root, "sessions", `session-${encoded}`);
    const credentials = path.join(sessionRoot, "credentials");
    const codexHome = path.join(credentials, "codex");
    return {
      container: `scotty-runner-v1-${encoded}`,
      resourceId: `runner-v1:${sessionId}`,
      sessionRoot,
      workspace: path.join(sessionRoot, "workspace"),
      credentials,
      codexHome,
      codexAuth: path.join(codexHome, "auth.json"),
      githubConfig: path.join(credentials, "github"),
      picanProxyToken: path.join(credentials, "pican-proxy-token"),
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
    const {
      codexAuth,
      codexHome,
      container,
      credentials,
      githubConfig,
      picanProxyToken,
      sessionRoot,
      workspace,
    } = coordinates(sessionId);
    const [codexSourceInfo, githubSourceInfo] = yield* Effect.all([
      fs.stat(config.codexAuthSource),
      fs.stat(config.githubConfigSource),
    ]).pipe(fixedFailure("filesystem_failed"));
    if (
      codexSourceInfo.type !== "File" ||
      githubSourceInfo.type !== "File" ||
      (codexSourceInfo.mode & 0o077) !== 0 ||
      (githubSourceInfo.mode & 0o077) !== 0
    ) {
      return yield* new RunnerComputeFailure({ code: "filesystem_failed" });
    }
    yield* fs
      .makeDirectory(sessionRoot, { recursive: true, mode: 0o700 })
      .pipe(fixedFailure("filesystem_failed"));
    yield* Effect.forEach(
      [sessionRoot, workspace, credentials, codexHome],
      (directory) =>
        fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.andThen(fs.chmod(directory, 0o700)), fixedFailure("filesystem_failed")),
      { discard: true },
    );
    if (!(yield* fs.exists(codexAuth).pipe(fixedFailure("filesystem_failed")))) {
      yield* fs.copyFile(config.codexAuthSource, codexAuth).pipe(fixedFailure("filesystem_failed"));
      yield* fs.chmod(codexAuth, 0o600).pipe(fixedFailure("filesystem_failed"));
    }
    yield* fs
      .makeDirectory(githubConfig, { recursive: true, mode: 0o700 })
      .pipe(fixedFailure("filesystem_failed"));
    yield* fs.chmod(githubConfig, 0o700).pipe(fixedFailure("filesystem_failed"));
    const githubHosts = path.join(githubConfig, "hosts.yml");
    if (!(yield* fs.exists(githubHosts).pipe(fixedFailure("filesystem_failed")))) {
      yield* fs
        .copyFile(config.githubConfigSource, githubHosts)
        .pipe(fixedFailure("filesystem_failed"));
      yield* fs.chmod(githubHosts, 0o600).pipe(fixedFailure("filesystem_failed"));
    }
    if (!(yield* fs.exists(picanProxyToken).pipe(fixedFailure("filesystem_failed")))) {
      const proxyToken = randomBytes(32).toString("base64url");
      yield* fs
        .writeFileString(picanProxyToken, proxyToken, { mode: 0o600 })
        .pipe(fixedFailure("filesystem_failed"));
    }
    yield* fs.chmod(picanProxyToken, 0o600).pipe(fixedFailure("filesystem_failed"));
    const observed = yield* phase(container);
    if (observed === "absent") {
      const environmentArguments = childEnvironmentArguments(
        config.safePath,
        config.childEnvironment,
        sessionId,
      );
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
        `type=bind,source=${workspace},target=/workspace/${sessionId}`,
        "--mount",
        `type=bind,source=${credentials},target=/run/scotty/credentials`,
        "--workdir",
        `/workspace/${sessionId}`,
        ...environmentArguments,
        "--entrypoint",
        "/bin/sleep",
        config.image,
        "infinity",
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
    const cwd = yield* containerWorkingDirectory(sessionId, input.relativeCwd);
    return yield* process.run([
      "container",
      "exec",
      ...(input.detach === true ? ["--detach"] : []),
      "--workdir",
      cwd,
      container,
      ...input.argv,
    ]);
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
    const { container, sessionRoot } = coordinates(sessionId);
    if ((yield* phase(container)) !== "absent") {
      yield* runRequired(["container", "rm", "--force", container]);
    }
    yield* fs
      .remove(sessionRoot, { recursive: true, force: true })
      .pipe(fixedFailure("filesystem_failed"));
    return state(sessionId, "absent");
  });

  const mountedHttp = Effect.fnUntraced(function* (
    identity: { readonly runtimeId: string; readonly sessionId: string },
    request: Request,
    hostFetch: (request: Request) => Promise<Response>,
  ) {
    const { container, picanProxyToken, resourceId } = coordinates(identity.sessionId);
    if (identity.runtimeId !== resourceId) {
      return yield* new RunnerComputeFailure({ code: "runtime_not_running" });
    }
    if ((yield* phase(container)) !== "running") {
      return yield* new RunnerComputeFailure({ code: "runtime_not_running" });
    }
    const inspected = yield* runRequired([
      "container",
      "inspect",
      "--format={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      container,
    ]);
    const address = inspected.stdout.trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
      return yield* new RunnerComputeFailure({ code: "process_failed" });
    }
    const source = new URL(request.url);
    const target = `http://${address}:${PICAN_PORT}${source.pathname}${source.search}`;
    const proxyTokenEntry = yield* fs
      .readFileString(picanProxyToken)
      .pipe(fixedFailure("filesystem_failed"));
    if (!/^[A-Za-z0-9_-]{43}$/u.test(proxyTokenEntry)) {
      return yield* new RunnerComputeFailure({ code: "filesystem_failed" });
    }
    const proxyToken = proxyTokenEntry;
    const forwarded = new Request(target, request);
    forwarded.headers.delete(PICAN_PROXY_HEADER);
    forwarded.headers.set(PICAN_PROXY_HEADER, proxyToken);
    return yield* Effect.tryPromise({
      try: () => hostFetch(forwarded),
      catch: () => new RunnerComputeFailure({ code: "process_failed" }),
    });
  });

  return {
    ensure,
    inspect,
    exec,
    stop,
    remove,
    mountedHttp,
  } satisfies IsolatedRuntimeCompute;
});
