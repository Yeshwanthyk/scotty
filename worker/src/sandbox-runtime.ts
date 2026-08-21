import type {
  ExecOptions,
  ExecResult,
  Process,
  ProcessOptions,
  ProcessStatus,
  WaitForPortOptions,
} from "@cloudflare/sandbox";
import { redactCredentialSentinels } from "../../protocol/pi-console-shared.mjs";
import { Context, Data, Effect, Layer, Predicate, Schedule } from "effect";

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

export type SandboxWriteContent = string | Uint8Array | ReadableStream<Uint8Array>;

export interface SandboxRuntimeCapabilities {
  readonly exec: (command: string, options?: SandboxExecOptions) => Promise<ExecResult>;
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<unknown>;
  readonly readFileStream?: (path: string) => Promise<ReadableStream<Uint8Array>>;
  readonly writeFile: (path: string, content: SandboxWriteContent) => Promise<unknown>;
  readonly setEnvVars: (envVars: Record<string, string | undefined>) => Promise<void>;
  readonly startProcess?: (
    command: string,
    options?: SandboxProcessOptions,
  ) => Promise<SandboxProcessCapabilities>;
  readonly getProcess?: (processId: string) => Promise<SandboxProcessCapabilities | null>;
  readonly fetchPort?: (
    path: string,
    port: number,
    method: "GET" | "POST",
    headers?: Readonly<Record<string, string>>,
  ) => Promise<Response>;
}

export interface SandboxRuntimeLayerOptions {
  readonly fetchPortReadiness?: boolean;
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
  readonly readFile: (
    path: string,
    maxBytes: number,
  ) => Effect.Effect<Uint8Array, SandboxRuntimeFailure>;
  readonly writeFile: (
    path: string,
    content: SandboxWriteContent,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
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
  readonly fetchPortStatus: (
    path: string,
    port: number,
    method: "GET" | "POST",
    headers?: Readonly<Record<string, string>>,
  ) => Effect.Effect<number, SandboxRuntimeFailure>;
}

export class SandboxRuntime extends Context.Service<SandboxRuntime, SandboxRuntimeShape>()(
  "scotty/SandboxRuntime",
) {}

export const sandboxRuntimeLayer = <E = never>(
  capabilities: SandboxRuntimeCapabilities,
  beforeOperation?: Effect.Effect<void, E>,
  options: SandboxRuntimeLayerOptions = {},
): Layer.Layer<SandboxRuntime> =>
  Layer.succeed(SandboxRuntime)(
    makeSandboxRuntime(capabilities, beforeOperation ?? Effect.void, options),
  );

const makeSandboxRuntime = <E>(
  capabilities: SandboxRuntimeCapabilities,
  beforeOperation: Effect.Effect<void, E>,
  layerOptions: SandboxRuntimeLayerOptions,
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
    readFile: Effect.fnUntraced(function* (path, maxBytes) {
      const readFileStream = capabilities.readFileStream;
      if (readFileStream === undefined)
        return yield* transportFailure("Sandbox file stream transport is unavailable");
      yield* guardOperation(beforeOperation, "Sandbox file stream transport failed");
      const stream = yield* Effect.tryPromise({
        try: () => readFileStream(path),
        catch: () => transportFailure("Sandbox file stream transport failed"),
      });
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const next = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => transportFailure("Sandbox file stream transport failed"),
        });
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          yield* Effect.promise(() => reader.cancel()).pipe(Effect.ignore);
          return yield* transportFailure("Sandbox file exceeds its byte limit");
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
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
        Effect.map((process) =>
          makeSandboxProcess(
            process,
            beforeOperation,
            capabilities.fetchPort,
            layerOptions.fetchPortReadiness === true,
          ),
        ),
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
          process === null
            ? null
            : makeSandboxProcess(
                process,
                beforeOperation,
                capabilities.fetchPort,
                layerOptions.fetchPortReadiness === true,
              ),
        ),
      );
    },
    fetchPortStatus: (path, port, method, headers) => {
      const fetchPort = capabilities.fetchPort;
      if (fetchPort === undefined)
        return Effect.fail(transportFailure("Sandbox port transport is unavailable"));
      return guardOperation(beforeOperation, "Sandbox port transport failed").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => fetchPort(path, port, method, headers),
            catch: () => transportFailure("Sandbox port transport failed"),
          }),
        ),
        Effect.map((response) => response.status),
      );
    },
  });

const makeSandboxProcess = <E>(
  process: SandboxProcessCapabilities,
  beforeOperation: Effect.Effect<void, E>,
  fetchPort: SandboxRuntimeCapabilities["fetchPort"],
  fetchPortReadiness: boolean,
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
    fetchPortReadiness && fetchPort !== undefined && options?.mode !== "tcp"
      ? waitForPortViaFetch(beforeOperation, fetchPort, port, options)
      : transportVoid(beforeOperation, "Sandbox process readiness transport failed", () =>
          process.waitForPort(port, options),
        ),
});

const waitForPortViaFetch = <E>(
  beforeOperation: Effect.Effect<void, E>,
  fetchPort: NonNullable<SandboxRuntimeCapabilities["fetchPort"]>,
  port: number,
  options?: SandboxWaitForPortOptions,
): Effect.Effect<void, SandboxRuntimeFailure> => {
  const timeout = options?.timeout ?? 30_000;
  const attempts = Math.max(1, Math.ceil(timeout / 250));
  const expected = options?.status ?? { min: 200, max: 399 };
  return guardOperation(beforeOperation, "Sandbox process readiness transport failed").pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => fetchPort(options?.path ?? "/", port, "GET"),
        catch: () => transportFailure("Sandbox process readiness transport failed"),
      }),
    ),
    Effect.filterOrFail(
      (response) =>
        typeof expected === "number"
          ? response.status === expected
          : response.status >= expected.min && response.status <= expected.max,
      () => transportFailure("Sandbox process readiness transport failed"),
    ),
    Effect.asVoid,
    Effect.retry({ times: attempts - 1, schedule: Schedule.spaced("250 millis") }),
    Effect.mapError(() => transportFailure("Sandbox process readiness transport failed")),
  );
};

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
  return redactCredentialSentinels(
    value.replaceAll(/scotty-(?:codex|github|env)-[A-Za-z0-9-]+/gu, "[sentinel]"),
  )
    .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
    .slice(0, 1_000);
}
