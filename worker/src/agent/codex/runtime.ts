import { Cause, Data, Deferred, Effect, Option, Schema, Scope } from "effect";
import { CODEX_MAX_TEXT_BYTES, CODEX_VERSION } from "../../../../protocol/codex-app-server";
import { Cleanup, type CodexHostError } from "./errors";
import { CodexLaunch } from "./process";
import { startCodexSession } from "./session";

const bytes = (maximum: number) =>
  Schema.String.check(
    Schema.makeFilter((text) => new TextEncoder().encode(text).length <= maximum),
  );
export const CodexGeneration = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u));
const Identifier = bytes(256).check(Schema.isMinLength(1));
export const CODEX_CONTROL_MAX_BODY = 256 * 1024;
export const CODEX_CONTROL_MAX_RESPONSE = 512 * 1024;
export const CODEX_CONTROL_TOKEN_HEADER = "x-scotty-codex-token";
export const CODEX_CONTROL_GENERATION_HEADER = "x-scotty-codex-generation";
export const CodexControlToken = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const CodexRuntimeStart = Schema.Struct({
  generation: CodexGeneration,
  launch: CodexLaunch,
});
export const CodexPrompt = Schema.Struct({
  threadId: Identifier,
  text: bytes(CODEX_MAX_TEXT_BYTES).check(Schema.isMinLength(1)),
});
export const CodexAdmission = Schema.Struct({
  generation: CodexGeneration,
  threadId: Identifier,
  turnId: Identifier,
});
const PromptState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({ status: Schema.Literal("admitting") }),
  Schema.Struct({ status: Schema.Literal("running"), turnId: Identifier }),
  Schema.Struct({
    status: Schema.Literal("terminal"),
    turnId: Identifier,
    outcome: Schema.Literals(["completed", "interrupted", "failed"]),
    text: bytes(CODEX_MAX_TEXT_BYTES),
  }),
  Schema.Struct({ status: Schema.Literal("failed"), turnId: Schema.NullOr(Identifier) }),
]);
export const CodexSnapshot = Schema.Struct({
  generation: CodexGeneration,
  threadId: Identifier,
  version: Schema.Literal(CODEX_VERSION),
  settings: Schema.Struct({
    model: Identifier,
    effort: Identifier,
    workspace: bytes(4096),
    modelProvider: Schema.Literal("scotty-managed"),
    approvalPolicy: Schema.Literal("never"),
    sandbox: Schema.Literal("dangerFullAccess"),
  }),
  ready: Schema.Boolean,
  failure: Schema.NullOr(Identifier),
  prompt: PromptState,
  cleanup: Schema.NullOr(Cleanup),
});
export class CodexBridgeError extends Data.TaggedError("CodexBridgeError")<{
  readonly code:
    | "invalid_request"
    | "unauthorized"
    | "stale_generation"
    | "wrong_thread"
    | "wrong_turn"
    | "busy"
    | "already_admitted"
    | "host_failed"
    | "invalid_snapshot"
    | "request_timeout"
    | "token_file";
  readonly outcome: "rejected" | "ambiguous";
}> {}
const decodeStart = Schema.decodeUnknownEffect(CodexRuntimeStart, { onExcessProperty: "error" });
const decodeGeneration = Schema.decodeUnknownEffect(CodexGeneration);
const decodePrompt = Schema.decodeUnknownEffect(CodexPrompt, { onExcessProperty: "error" });
const decodeSnapshot = Schema.decodeUnknownEffect(CodexSnapshot, { onExcessProperty: "error" });
const decodeSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexSnapshot), {
  onExcessProperty: "error",
});

// The caller must compare this proof with its authoritative Session generation and thread.
export const readCodexSnapshot = Effect.fnUntraced(function* (
  body: string,
  expected: { readonly generation: string; readonly threadId?: string; readonly turnId?: string },
) {
  if (new TextEncoder().encode(body).length > CODEX_CONTROL_MAX_RESPONSE)
    return yield* new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" });
  const snapshot = yield* decodeSnapshotJson(body).pipe(
    Effect.mapError(() => new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" })),
  );
  if (snapshot.generation !== expected.generation)
    return yield* new CodexBridgeError({ code: "stale_generation", outcome: "ambiguous" });
  if (expected.threadId !== undefined && snapshot.threadId !== expected.threadId)
    return yield* new CodexBridgeError({ code: "wrong_thread", outcome: "ambiguous" });
  if (
    expected.turnId !== undefined &&
    (snapshot.prompt.status === "idle" ||
      snapshot.prompt.status === "admitting" ||
      snapshot.prompt.turnId !== expected.turnId)
  )
    return yield* new CodexBridgeError({ code: "wrong_turn", outcome: "ambiguous" });
  return snapshot;
});

type Host = Effect.Success<ReturnType<typeof startCodexSession>>;
export const makeCodexRuntime = Effect.fnUntraced(function* (host: Host, generationInput: unknown) {
  const generation = yield* decodeGeneration(generationInput).pipe(
    Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
  );
  const scope = yield* Scope.Scope;
  const initial = host.inspect();
  let prompt: typeof PromptState.Type = { status: "idle" };
  let cleanup: typeof Cleanup.Type | null = null;
  let bridgeFailure: CodexBridgeError["code"] | CodexHostError["code"] | null = null;
  const snapshot = Effect.suspend(() => {
    const current = host.inspect();
    return decodeSnapshot({
      generation,
      threadId: initial.threadId,
      version: CODEX_VERSION,
      settings: {
        model: initial.settings.model,
        effort: initial.settings.reasoningEffort,
        workspace: initial.settings.cwd,
        modelProvider: initial.settings.modelProvider,
        approvalPolicy: initial.settings.approvalPolicy,
        sandbox: initial.settings.sandbox.type,
      },
      ready: current.ready && bridgeFailure === null,
      failure: current.failure ?? bridgeFailure,
      prompt,
      cleanup,
    }).pipe(
      Effect.mapError(
        () => new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" }),
      ),
    );
  });
  yield* snapshot;
  const stop = yield* Effect.cached(
    host.stop.pipe(
      Effect.tap((receipt) =>
        Effect.sync(() => {
          cleanup = receipt;
        }),
      ),
    ),
  );
  yield* Effect.addFinalizer(() => stop);
  yield* host.closed.pipe(
    Effect.tap((receipt) =>
      Effect.sync(() => {
        cleanup = receipt;
      }),
    ),
    Effect.forkIn(scope),
  );
  const admit = Effect.fnUntraced(function* (input: unknown) {
    const command = yield* decodePrompt(input).pipe(
      Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
    );
    if (command.threadId !== initial.threadId)
      return yield* new CodexBridgeError({ code: "wrong_thread", outcome: "rejected" });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (prompt.status === "admitting" || prompt.status === "running")
          return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
        if (prompt.status !== "idle")
          return yield* new CodexBridgeError({ code: "already_admitted", outcome: "rejected" });
        if (!host.inspect().ready || bridgeFailure !== null)
          return yield* new CodexBridgeError({ code: "host_failed", outcome: "rejected" });
        prompt = { status: "admitting" };
        const admitted = yield* Deferred.make<typeof CodexAdmission.Type, CodexBridgeError>();
        let turnId: string | null = null;
        // Admission and terminal observation belong to the generation, not a disconnected HTTP caller.
        yield* Effect.gen(function* () {
          const turn = yield* host.prompt(command.text);
          turnId = turn.turnId;
          prompt = { status: "running", turnId };
          yield* Deferred.succeed(admitted, { generation, threadId: command.threadId, turnId });
          const terminal = yield* turn.completed;
          if (terminal.id !== turnId)
            return yield* new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" });
          prompt = {
            status: "terminal",
            turnId,
            outcome: terminal.status,
            text: terminal.items.map((item) => item.text).join(""),
          };
          yield* snapshot;
          host.drainEvents();
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              prompt = { status: "failed", turnId };
              const error = Cause.findErrorOption(cause);
              bridgeFailure = Option.isSome(error)
                ? error.value.code
                : Cause.hasInterruptsOnly(cause)
                  ? "interrupted"
                  : "host_failed";
              yield* Deferred.fail(
                admitted,
                new CodexBridgeError({ code: "host_failed", outcome: "ambiguous" }),
              );
              yield* stop;
            }),
          ),
          Effect.interruptible,
          Effect.forkIn(scope),
        );
        return yield* restore(Deferred.await(admitted));
      }),
    );
  });
  return { generation, snapshot, admit, stop };
});
export type CodexRuntime = Effect.Success<ReturnType<typeof makeCodexRuntime>>;
export const startCodexRuntime = Effect.fnUntraced(function* (input: unknown) {
  const selection = yield* decodeStart(input).pipe(
    Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
  );
  const host = yield* startCodexSession(selection.launch);
  return yield* makeCodexRuntime(host, selection.generation);
});
