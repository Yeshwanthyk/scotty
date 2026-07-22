import type { ExecOptions, ExecResult, SessionOptions } from "@cloudflare/sandbox";
import { Context, Data, Effect, Layer, Predicate } from "effect";

export type SandboxExecOptions = Pick<ExecOptions, "cwd" | "env" | "timeout">;
export type SandboxSessionOptions = Pick<SessionOptions, "id" | "cwd" | "env">;

type SandboxRuntimeFailureReason = "nonzero_exit" | "transport";

export class SandboxRuntimeFailure extends Data.TaggedError("SandboxRuntimeFailure")<{
  readonly reason: SandboxRuntimeFailureReason;
  readonly message: string;
}> {}

export interface SandboxRuntimeCapabilities {
  readonly exec: (command: string, options?: SandboxExecOptions) => Promise<ExecResult>;
  readonly createSession: (options: SandboxSessionOptions) => Promise<unknown>;
  readonly deleteSession: (sessionId: string) => Promise<unknown>;
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<unknown>;
  readonly writeFile: (path: string, content: string) => Promise<unknown>;
  readonly setEnvVars: (envVars: Record<string, string | undefined>) => Promise<void>;
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
  readonly createSession: (
    options: SandboxSessionOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly deleteSession: (sessionId: string) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly mkdir: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly setEnvVars: (
    envVars: Record<string, string | undefined>,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
}

export class SandboxRuntime extends Context.Service<SandboxRuntime, SandboxRuntimeShape>()(
  "scotty/SandboxRuntime",
) {}

export const sandboxRuntimeLayer = (
  capabilities: SandboxRuntimeCapabilities,
): Layer.Layer<SandboxRuntime> => Layer.succeed(SandboxRuntime)(makeSandboxRuntime(capabilities));

const makeSandboxRuntime = (capabilities: SandboxRuntimeCapabilities): SandboxRuntimeShape =>
  SandboxRuntime.of({
    exec: (command, options) => exec(capabilities, command, options),
    execChecked: Effect.fnUntraced(function* (command, options) {
      // The SDK's non-streaming exec RPC does not propagate AbortSignal cancellation to the
      // remote process. Interruption may stop waiting locally, but must not claim cancellation.
      const result = yield* exec(capabilities, command, options);
      if (!result.success) {
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: redactCommandFailure(result.stderr || result.stdout),
        });
      }
      return result;
    }),
    createSession: (options) =>
      transportVoid("Sandbox session creation transport failed", () =>
        capabilities.createSession(options),
      ),
    deleteSession: (sessionId) =>
      transportVoid("Sandbox session deletion transport failed", () =>
        capabilities.deleteSession(sessionId),
      ),
    mkdir: (path, options) =>
      transportVoid("Sandbox directory transport failed", () => capabilities.mkdir(path, options)),
    writeFile: (path, content) =>
      transportVoid("Sandbox file transport failed", () => capabilities.writeFile(path, content)),
    setEnvVars: (envVars) =>
      transportVoid("Sandbox environment transport failed", () => capabilities.setEnvVars(envVars)),
  });

const exec = (
  capabilities: SandboxRuntimeCapabilities,
  command: string,
  options?: SandboxExecOptions,
): Effect.Effect<ExecResult, SandboxRuntimeFailure> =>
  Effect.tryPromise({
    try: () => capabilities.exec(command, options),
    catch: () =>
      new SandboxRuntimeFailure({
        reason: "transport",
        message: "Sandbox command transport failed",
      }),
  });

const transportVoid = (
  message: string,
  operation: () => Promise<unknown>,
): Effect.Effect<void, SandboxRuntimeFailure> =>
  Effect.tryPromise({
    try: operation,
    catch: () => new SandboxRuntimeFailure({ reason: "transport", message }),
  }).pipe(Effect.asVoid);

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
