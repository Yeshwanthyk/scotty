import type {
  ExecOptions,
  ExecResult,
  Process,
  ProcessOptions,
  ProcessStatus,
  WaitForPortOptions,
} from "@cloudflare/sandbox";
import { Context, Data, Effect, Layer, Predicate } from "effect";

export type SandboxExecOptions = Pick<ExecOptions, "cwd" | "env" | "timeout">;
export type SandboxProcessOptions = Pick<
  ProcessOptions,
  "autoCleanup" | "cwd" | "env" | "processId"
>;
export type SandboxWaitForPortOptions = Pick<
  WaitForPortOptions,
  "mode" | "path" | "status" | "timeout"
>;
export type SandboxProcessCapabilities = Pick<
  Process,
  "id" | "kill" | "status" | "waitForExit" | "waitForPort"
>;

type SandboxRuntimeFailureReason = "nonzero_exit" | "transport";

export class SandboxRuntimeFailure extends Data.TaggedError("SandboxRuntimeFailure")<{
  readonly reason: SandboxRuntimeFailureReason;
  readonly message: string;
}> {}

export interface SandboxRuntimeCapabilities {
  readonly exec: (command: string, options?: SandboxExecOptions) => Promise<ExecResult>;
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<unknown>;
  readonly writeFile: (path: string, content: string) => Promise<unknown>;
  readonly setEnvVars: (envVars: Record<string, string | undefined>) => Promise<void>;
  readonly startProcess?: (
    command: string,
    options?: SandboxProcessOptions,
  ) => Promise<SandboxProcessCapabilities>;
  readonly getProcess?: (processId: string) => Promise<SandboxProcessCapabilities | null>;
}

export interface SandboxProcess {
  readonly id: string;
  readonly status: ProcessStatus;
  readonly kill: (signal?: string) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly waitForExit: (timeout?: number) => Effect.Effect<number, SandboxRuntimeFailure>;
  readonly waitForPort: (
    port: number,
    options?: SandboxWaitForPortOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
}

interface SandboxRuntimeShape {
  readonly exec: (
    command: string,
    options?: SandboxExecOptions,
  ) => Effect.Effect<ExecResult, SandboxRuntimeFailure>;
  readonly execChecked: (
    command: string,
    options?: SandboxExecOptions,
  ) => Effect.Effect<ExecResult, SandboxRuntimeFailure>;
  readonly mkdir: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly setEnvVars: (
    envVars: Record<string, string | undefined>,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly startProcess: (
    command: string,
    options?: SandboxProcessOptions,
  ) => Effect.Effect<SandboxProcess, SandboxRuntimeFailure>;
  readonly getProcess: (
    processId: string,
  ) => Effect.Effect<SandboxProcess | null, SandboxRuntimeFailure>;
}

export class SandboxRuntime extends Context.Service<SandboxRuntime, SandboxRuntimeShape>()(
  "scotty/SandboxRuntime",
) {}

export const sandboxRuntimeLayer = <E = never>(
  capabilities: SandboxRuntimeCapabilities,
  beforeOperation?: Effect.Effect<void, E>,
): Layer.Layer<SandboxRuntime> =>
  Layer.succeed(SandboxRuntime)(makeSandboxRuntime(capabilities, beforeOperation ?? Effect.void));

const makeSandboxRuntime = <E>(
  capabilities: SandboxRuntimeCapabilities,
  beforeOperation: Effect.Effect<void, E>,
): SandboxRuntimeShape =>
  SandboxRuntime.of({
    exec: (command, options) => exec(capabilities, beforeOperation, command, options),
    execChecked: Effect.fnUntraced(function* (command, options) {
      // The SDK's non-streaming exec RPC does not propagate AbortSignal cancellation to the
      // remote process. Interruption may stop waiting locally, but must not claim cancellation.
      const result = yield* exec(capabilities, beforeOperation, command, options);
      if (!result.success) {
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: redactCommandFailure(result.stderr || result.stdout),
        });
      }
      return result;
    }),
    mkdir: (path, options) =>
      transportVoid(beforeOperation, "Sandbox directory transport failed", () =>
        capabilities.mkdir(path, options),
      ),
    writeFile: (path, content) =>
      transportVoid(beforeOperation, "Sandbox file transport failed", () =>
        capabilities.writeFile(path, content),
      ),
    setEnvVars: (envVars) =>
      transportVoid(beforeOperation, "Sandbox environment transport failed", () =>
        capabilities.setEnvVars(envVars),
      ),
    startProcess: (command, options) => {
      const startProcess = capabilities.startProcess;
      if (startProcess === undefined)
        return Effect.fail(transportFailure("Sandbox process start transport is unavailable"));
      return guardOperation(beforeOperation, "Sandbox process start transport failed").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => startProcess(command, options),
            catch: () => transportFailure("Sandbox process start transport failed"),
          }),
        ),
        Effect.map((process) => makeSandboxProcess(process, beforeOperation)),
      );
    },
    getProcess: (processId) => {
      const getProcess = capabilities.getProcess;
      if (getProcess === undefined)
        return Effect.fail(transportFailure("Sandbox process lookup transport is unavailable"));
      return guardOperation(beforeOperation, "Sandbox process lookup transport failed").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => getProcess(processId),
            catch: () => transportFailure("Sandbox process lookup transport failed"),
          }),
        ),
        Effect.map((process) =>
          process === null ? null : makeSandboxProcess(process, beforeOperation),
        ),
      );
    },
  });

const makeSandboxProcess = <E>(
  process: SandboxProcessCapabilities,
  beforeOperation: Effect.Effect<void, E>,
): SandboxProcess => ({
  id: process.id,
  status: process.status,
  kill: (signal) =>
    transportVoid(beforeOperation, "Sandbox process termination transport failed", () =>
      process.kill(signal),
    ),
  waitForExit: (timeout) =>
    guardOperation(beforeOperation, "Sandbox process exit wait transport failed").pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => process.waitForExit(timeout),
          catch: () => transportFailure("Sandbox process exit wait transport failed"),
        }),
      ),
      Effect.map((result) => result.exitCode),
    ),
  waitForPort: (port, options) =>
    transportVoid(beforeOperation, "Sandbox process readiness transport failed", () =>
      process.waitForPort(port, options),
    ),
});

const exec = <E>(
  capabilities: SandboxRuntimeCapabilities,
  beforeOperation: Effect.Effect<void, E>,
  command: string,
  options?: SandboxExecOptions,
): Effect.Effect<ExecResult, SandboxRuntimeFailure> =>
  guardOperation(beforeOperation, "Sandbox command transport failed").pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => capabilities.exec(command, options),
        catch: () =>
          new SandboxRuntimeFailure({
            reason: "transport",
            message: "Sandbox command transport failed",
          }),
      }),
    ),
  );

const transportVoid = <E>(
  beforeOperation: Effect.Effect<void, E>,
  message: string,
  operation: () => Promise<unknown>,
): Effect.Effect<void, SandboxRuntimeFailure> =>
  guardOperation(beforeOperation, message).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: operation,
        catch: () => transportFailure(message),
      }),
    ),
    Effect.asVoid,
  );

const guardOperation = <E>(
  beforeOperation: Effect.Effect<void, E>,
  message: string,
): Effect.Effect<void, SandboxRuntimeFailure> =>
  beforeOperation.pipe(Effect.mapError(() => transportFailure(message)));

const transportFailure = (message: string): SandboxRuntimeFailure =>
  new SandboxRuntimeFailure({ reason: "transport", message });

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function errorName(error: unknown): string {
  return Predicate.isError(error) ? error.name : "UnknownError";
}

function redactCommandFailure(value: string): string {
  return value
    .replaceAll(/scotty-(?:codex|github)-[A-Za-z0-9-]+/gu, "[sentinel]")
    .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
    .slice(0, 1_000);
}
