import type { ExecOptions, ExecResult } from "@cloudflare/sandbox";
import { Context, Data, Effect, Layer, Predicate } from "effect";

export type SandboxExecOptions = Pick<ExecOptions, "cwd" | "env" | "timeout">;

type SandboxRuntimeFailureReason = "nonzero_exit" | "transport";

export class SandboxRuntimeFailure extends Data.TaggedError("SandboxRuntimeFailure")<{
  readonly reason: SandboxRuntimeFailureReason;
  readonly message: string;
}> {}

export interface SandboxRuntimeCapabilities {
  readonly exec: (command: string, options?: SandboxExecOptions) => Promise<ExecResult>;
}

interface SandboxRuntimeShape {
  readonly execChecked: (
    command: string,
    options?: SandboxExecOptions,
  ) => Effect.Effect<ExecResult, SandboxRuntimeFailure>;
}

export class SandboxRuntime extends Context.Service<SandboxRuntime, SandboxRuntimeShape>()(
  "scotty/SandboxRuntime",
) {}

export const sandboxRuntimeLayer = (
  capabilities: SandboxRuntimeCapabilities,
): Layer.Layer<SandboxRuntime> => Layer.succeed(SandboxRuntime)(makeSandboxRuntime(capabilities));

const makeSandboxRuntime = (capabilities: SandboxRuntimeCapabilities): SandboxRuntimeShape =>
  SandboxRuntime.of({
    execChecked: Effect.fnUntraced(function* (command, options) {
      // The SDK's non-streaming exec RPC does not propagate AbortSignal cancellation to the
      // remote process. Interruption may stop waiting locally, but must not claim cancellation.
      const result = yield* Effect.tryPromise({
        try: () => capabilities.exec(command, options),
        catch: () =>
          new SandboxRuntimeFailure({
            reason: "transport",
            message: "Sandbox command transport failed",
          }),
      });
      if (!result.success) {
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: redactCommandFailure(result.stderr || result.stdout),
        });
      }
      return result;
    }),
  });

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
