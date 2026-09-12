import { importCodexSavedState } from "./persistence";
import { CloudSettingsEnvironmentSchema } from "../../../../protocol/cloud-settings";
import { SandboxDigestSchema } from "../../sandbox/config-contracts";
import type { CodexSavedState } from "./persistence-format";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Option,
  Queue,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { CodexHostError, type Cleanup } from "./errors";
import { managedPiAccessToken, parseManagedPiAccessToken } from "../../credentials/managed";
import { formatManagedHandle } from "../../../../protocol/credentials";
import {
  CodexModelIdentifier,
  CodexReasoningEffort,
  codexModelCapability,
  supportsCodexModelSelection,
} from "../../../../protocol/codex-model-capabilities";

const AbsolutePath = Schema.String.check(
  Schema.isPattern(/^\//u),
  Schema.makeFilter(
    (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
  ),
  Schema.isMaxLength(4096),
);
const ThreadId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
  ),
);
const Deadline = Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 120000 }));
export const CodexLaunch = Schema.Struct({
  environment: Schema.optionalKey(CloudSettingsEnvironmentSchema),
  sandboxBundleDigest: Schema.optionalKey(SandboxDigestSchema),
  binary: AbsolutePath,
  runtimeDir: AbsolutePath,
  workspace: AbsolutePath,
  sessionId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u))),
  model: CodexModelIdentifier,
  effort: CodexReasoningEffort,
  // Direct host callers remain ephemeral by default. The Session adapter selects
  // durable history and supplies the DO-owned identity when restoring a backup.
  ephemeral: Schema.optionalKey(Schema.Boolean),
  resumeThreadId: Schema.optionalKey(ThreadId),
  credential: Schema.Struct({
    sentinel: Schema.String.check(
      Schema.isMaxLength(4096),
      Schema.makeFilter((value) => {
        const handle = parseManagedPiAccessToken(value);
        return (
          Option.isSome(handle) && managedPiAccessToken(formatManagedHandle(handle.value)) === value
        );
      }),
    ),
    expiresAt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  }),
  // Handshake only, after process creation/helper preflight. The 15s default/cap
  // retains the existing default RPC allowance with headroom under Session's 30s readiness.
  startupTimeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 15000 })),
  ),
  requestTimeoutMs: Schema.optionalKey(Deadline),
  turnTimeoutMs: Schema.optionalKey(Deadline),
  stopTimeoutMs: Schema.optionalKey(Deadline),
})
  .check(Schema.makeFilter(supportsCodexModelSelection))
  .check(
    Schema.makeFilter(
      (selection) => selection.resumeThreadId === undefined || selection.ephemeral === false,
    ),
  );
const decodeLaunch = Schema.decodeUnknownEffect(CodexLaunch, { onExcessProperty: "error" });
const decodePort = Schema.decodeUnknownEffect(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
);

// Only in-process test composition can replace the fixed endpoint; launch input cannot.
export class CodexSyntheticUpstream extends Context.Service<
  CodexSyntheticUpstream,
  { readonly port: number }
>()("scotty/CodexSyntheticUpstream") {}

const decodeHelperHello = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("connection/ready"),
      selectedVersion: Schema.Literal(1),
      capabilities: Schema.Array(Schema.Literal("session-cell-execution-resource-limits")).check(
        Schema.isMaxLength(1),
      ),
    }),
  ),
  { onExcessProperty: "error" },
);

// Upstream availability() only checks is_file(). Negotiate its existing framed
// v1 protocol before app-server can accept work; native Codex owns the working host.
const verifyCodeModeHost = Effect.fnUntraced(function* (
  binary: string,
  home: string,
  timeoutMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const executable = yield* fs.realPath(binary);
  const bin = executable.slice(0, executable.lastIndexOf("/"));
  const resource = `${bin}/../codex-resources/codex-code-mode-host`;
  const helper = (yield* fs.exists(resource)) ? resource : `${bin}/codex-code-mode-host`;
  const hello = new TextEncoder().encode(
    JSON.stringify({
      type: "connection/hello",
      supportedVersions: [1],
      requiredCapabilities: [],
      optionalCapabilities: ["session-cell-execution-resource-limits"],
    }),
  );
  const frame = new Uint8Array(4 + hello.length);
  new DataView(frame.buffer).setUint32(0, hello.length, true);
  frame.set(hello, 4);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(helper, ["--listen", "stdio"], {
        cwd: home,
        extendEnv: false,
        env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin" },
        stdin: { stream: Stream.make(frame), endOnDone: true },
        stderr: "ignore",
        forceKillAfter: 100,
      });
      const bytes = yield* Stream.runFoldEffect(
        child.stdout,
        () => new Uint8Array(0),
        (bytes, chunk) => {
          if (bytes.length + chunk.length > 4096)
            return Effect.fail(new CodexHostError({ code: "spawn_failed" }));
          const next = new Uint8Array(bytes.length + chunk.length);
          next.set(bytes);
          next.set(chunk, bytes.length);
          return Effect.succeed(next);
        },
      );
      if (bytes.length < 4 || new DataView(bytes.buffer).getUint32(0, true) !== bytes.length - 4)
        return yield* new CodexHostError({ code: "spawn_failed" });
      yield* decodeHelperHello(new TextDecoder().decode(bytes.subarray(4)));
      if ((yield* child.exitCode) !== 0) return yield* new CodexHostError({ code: "spawn_failed" });
    }).pipe(Effect.timeout(timeoutMs)),
  ).pipe(Effect.mapError(() => new CodexHostError({ code: "spawn_failed" })));
});

export const launchProcess = Effect.fnUntraced(function* (
  input: unknown,
  restored?: typeof CodexSavedState.Type,
) {
  const selection = yield* decodeLaunch(input).pipe(
    Effect.mapError(() => new CodexHostError({ code: "invalid_launch_selection" })),
  );
  if (process.platform !== "darwin" && process.platform !== "linux")
    return yield* new CodexHostError({ code: "unsupported_platform" });
  if (selection.credential.expiresAt <= (yield* Clock.currentTimeMillis))
    return yield* new CodexHostError({ code: "credential_expired" });
  const synthetic = yield* Effect.serviceOption(CodexSyntheticUpstream);
  const port = Option.isSome(synthetic)
    ? yield* decodePort(synthetic.value.port).pipe(
        Effect.mapError(() => new CodexHostError({ code: "invalid_launch_selection" })),
      )
    : undefined;
  const baseUrl =
    port === undefined
      ? "https://chatgpt.com/backend-api/codex"
      : `http://127.0.0.1:${port}/backend-api/codex`;
  const options = {
    requestTimeoutMs: 15000,
    stopTimeoutMs: 2000,
    ...selection,
  };
  const fs = yield* FileSystem.FileSystem;
  const homes = yield* Effect.gen(function* () {
    yield* fs.makeDirectory(options.runtimeDir, { mode: 0o700 });
    const canonical = yield* fs.realPath(options.runtimeDir);
    const home = `${canonical}/home`,
      codexHome = `${canonical}/codex-home`,
      cwd = yield* fs.realPath(options.workspace);
    if ((yield* fs.stat(cwd)).type !== "Directory")
      return yield* new CodexHostError({ code: "isolation_setup_failed" });
    if (
      cwd === canonical ||
      cwd.startsWith(`${canonical}/`) ||
      canonical.startsWith(`${cwd === "/" ? "" : cwd}/`)
    )
      return yield* new CodexHostError({ code: "isolation_setup_failed" });
    for (const dir of [home, codexHome]) yield* fs.makeDirectory(dir, { mode: 0o700 });
    if (options.sandboxBundleDigest !== undefined) {
      const skills = `${cwd}/.scotty/sandbox/${options.sandboxBundleDigest}/skills`;
      if (yield* fs.exists(skills)) yield* fs.symlink(skills, `${codexHome}/skills`);
    }
    yield* fs.writeFileString(
      `${codexHome}/config.toml`,
      `model = "${options.model}"\nmodel_provider = "scotty-managed"\nmodel_reasoning_effort = "${options.effort}"\n[analytics]\nenabled = false\n[model_providers.scotty-managed]\nname = "Scotty managed Codex"\nbase_url = "${baseUrl}"\nwire_api = "responses"\nenv_key = "SCOTTY_CODEX_SENTINEL"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
      { mode: 0o600, flag: "wx" },
    );
    if (restored !== undefined) yield* importCodexSavedState(codexHome, restored);
    return { home, codexHome, cwd };
  }).pipe(Effect.mapError(() => new CodexHostError({ code: "isolation_setup_failed" })));
  if (codexModelCapability(options.model)?.toolMode === "code_mode_only")
    yield* verifyCodeModeHost(options.binary, homes.home, options.requestTimeoutMs).pipe(
      Effect.mapError(() => new CodexHostError({ code: "spawn_failed" })),
    );
  const resourceScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(resourceScope, Exit.void));
  const child = yield* ChildProcess.make(options.binary, ["app-server", "--listen", "stdio://"], {
    cwd: homes.cwd,
    detached: true,
    extendEnv: false,
    forceKillAfter: options.stopTimeoutMs,
    stdin: { stream: "pipe", endOnDone: true },
    env: {
      ...options.environment,
      HOME: homes.home,
      CODEX_HOME: homes.codexHome,
      TMPDIR: homes.home,
      // Match the image tool directories without inheriting ambient credentials.
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ...(options.sessionId === undefined ? {} : { SCOTTY_SESSION_ID: options.sessionId }),
      SCOTTY_CODEX_SENTINEL: options.credential.sentinel,
      ...(port === undefined
        ? {}
        : {
            HTTP_PROXY: `http://127.0.0.1:${port}`,
            HTTPS_PROXY: `http://127.0.0.1:${port}`,
            ALL_PROXY: `http://127.0.0.1:${port}`,
            NO_PROXY: "127.0.0.1,localhost",
          }),
    },
  }).pipe(
    Scope.provide(resourceScope),
    Effect.mapError(() => new CodexHostError({ code: "spawn_failed" })),
  );
  const inputQueue = yield* Queue.bounded<Uint8Array, Cause.Done>(2);
  const write = (bytes: Uint8Array) => Queue.offer(inputQueue, bytes).pipe(Effect.asVoid);
  const writer = Stream.run(Stream.fromQueue(inputQueue), child.stdin).pipe(
    Effect.mapError(() => new CodexHostError({ code: "transport_failed" })),
  );
  let observedExit: Cleanup["exit"] = null;
  const exit = Effect.result(child.exitCode).pipe(
    Effect.map((result) => {
      observedExit = { code: Result.isSuccess(result) ? result.success : null, signal: null };
    }),
  );
  const stop = yield* Effect.cached(
    Effect.gen(function* () {
      const running = yield* child.isRunning.pipe(Effect.catch(() => Effect.succeed(true)));
      let shutdown: Cleanup["shutdown"] = running ? "eof" : "unexpected";
      yield* Queue.end(inputQueue);
      const graceful = yield* exit.pipe(Effect.timeoutOption(options.stopTimeoutMs));
      if (Option.isNone(graceful)) {
        shutdown = "forced";
        yield* child
          .kill({ forceKillAfter: options.stopTimeoutMs })
          .pipe(Effect.timeoutOption(options.stopTimeoutMs * 2), Effect.result);
      }
      const parentRunning = yield* child.isRunning.pipe(Effect.catch(() => Effect.succeed(true)));
      // The public handle does not expose the terminating signal; never invent it.
      if (!parentRunning && observedExit === null) yield* exit;
      yield* Scope.close(resourceScope, Exit.void);
      yield* Queue.shutdown(inputQueue);
      return {
        cleanup: "ambiguous",
        descendants: "unverified",
        parent: parentRunning ? "unverified" : "exited",
        shutdown,
        exit: observedExit,
        failure: null,
      } satisfies Cleanup;
    }),
  );
  return {
    options,
    homes,
    pid: child.pid,
    platformOs: process.platform === "darwin" ? "macos" : "linux",
    write,
    writer,
    stdout: child.stdout.pipe(
      Stream.mapError(() => new CodexHostError({ code: "transport_failed" })),
    ),
    stderr: child.stderr.pipe(
      Stream.mapError(() => new CodexHostError({ code: "transport_failed" })),
    ),
    exit,
    stop,
  };
});
export type CodexProcess = Effect.Success<ReturnType<typeof launchProcess>>;
