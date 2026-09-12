import {
  CodexPersistenceIdentity,
  CodexSavedHistory,
  type CodexSavedState,
} from "./persistence-format";
import { readCodexSavedState, writeCodexSavedState } from "./persistence";
import { Cause, Data, Deferred, Effect, Option, Predicate, Result, Schema, Scope } from "effect";
import { CODEX_MAX_TEXT_BYTES, CODEX_VERSION } from "../../../../protocol/codex-app-server";
import {
  CanonicalConversationTurnSchema,
  CanonicalConversationToolSchema,
  CONVERSATION_MAX_TEXT_BYTES,
  CONVERSATION_MAX_TURNS,
  CONVERSATION_MAX_TOOLS_PER_TURN,
} from "../../../../protocol/conversation";
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
  restore: Schema.optionalKey(CodexPersistenceIdentity),
});
export const CodexPrompt = Schema.Struct({
  reconcileOnly: Schema.optionalKey(Schema.Boolean),
  threadId: Identifier,
  text: bytes(CODEX_MAX_TEXT_BYTES).check(Schema.isMinLength(1)),
  clientUserMessageId: Schema.optionalKey(Identifier),
});
export const CodexSteer = Schema.Struct({
  threadId: Identifier,
  text: bytes(CODEX_MAX_TEXT_BYTES).check(Schema.isMinLength(1)),
  expectedTurnId: Identifier,
  clientUserMessageId: Schema.optionalKey(Identifier),
});
export const CodexInterrupt = Schema.Struct({
  threadId: Identifier,
  turnId: Identifier,
});
export const CodexAdmission = Schema.Struct({
  generation: CodexGeneration,
  threadId: Identifier,
  turnId: Identifier,
});
export const CodexInterruptResult = Schema.Struct({
  generation: CodexGeneration,
  threadId: Identifier,
  turnId: Identifier,
  status: Schema.Literals(["completed", "interrupted", "failed"]),
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
  failureDiagnostic: Schema.optionalKey(bytes(256)),
  prompt: PromptState,
  tools: Schema.optionalKey(
    Schema.Array(CanonicalConversationToolSchema).check(
      Schema.isMaxLength(CONVERSATION_MAX_TOOLS_PER_TURN),
    ),
  ),
  toolsTruncated: Schema.optionalKey(Schema.Boolean),
  sequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  turns: Schema.optionalKey(
    Schema.Array(CanonicalConversationTurnSchema).check(Schema.isMaxLength(CONVERSATION_MAX_TURNS)),
  ),
  turnsTruncated: Schema.optionalKey(Schema.Boolean),
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
    | "not_admitted"
    | "idempotency_conflict"
    | "idempotency_unknown"
    | "host_failed"
    | "invalid_snapshot"
    | "request_timeout"
    | "token_file";
  readonly outcome: "rejected" | "ambiguous";
}> {}
const decodeStart = Schema.decodeUnknownEffect(CodexRuntimeStart, { onExcessProperty: "error" });
const decodeGeneration = Schema.decodeUnknownEffect(CodexGeneration);
const decodePrompt = Schema.decodeUnknownEffect(CodexPrompt, { onExcessProperty: "error" });
const decodeSteer = Schema.decodeUnknownEffect(CodexSteer, { onExcessProperty: "error" });
const decodeInterrupt = Schema.decodeUnknownEffect(CodexInterrupt, { onExcessProperty: "error" });
const decodeSavedHistory = Schema.decodeUnknownEffect(CodexSavedHistory);
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
type ConversationTurn = typeof CanonicalConversationTurnSchema.Type;
type OperationMode = "message" | "steer";
type OperationRecord = {
  readonly mode: OperationMode;
  readonly text: string;
  readonly expectedTurnId?: string;
  status: "pending" | "accepted" | "unknown";
  admission?: typeof CodexAdmission.Type;
};

const boundedConversationText = (
  text: string,
): { readonly text: string; readonly truncated: boolean } => {
  let bytes = 0;
  let value = "";
  for (const character of text) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > CONVERSATION_MAX_TEXT_BYTES) return { text: value, truncated: true };
    value += character;
    bytes += size;
  }
  return { text: value, truncated: false };
};
const MAX_HISTORY_BYTES = 256 * 1024;

export const makeCodexRuntime = Effect.fnUntraced(function* (
  host: Host,
  generationInput: unknown,
  restored?: (typeof CodexSavedState.Type)["history"],
) {
  const generation = yield* decodeGeneration(generationInput).pipe(
    Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
  );
  const scope = yield* Scope.Scope;
  const initial = host.inspect();
  let prompt: typeof PromptState.Type = restored?.prompt ?? { status: "idle" };
  let saving = false;
  let activeTurn: ConversationTurn | undefined;
  let steering = false;
  const history: Array<ConversationTurn> = [...(restored?.turns ?? [])];
  let turnsTruncated = restored?.turnsTruncated ?? false;
  const operations = new Map<string, OperationRecord>();
  for (const operation of restored?.operations ?? [])
    operations.set(operation.id, {
      mode: operation.mode,
      text: operation.text,
      expectedTurnId: operation.expectedTurnId,
      status: operation.status,
      ...(operation.turnId === undefined
        ? {}
        : {
            admission: {
              generation,
              threadId: initial.settings.thread.id,
              turnId: operation.turnId,
            },
          }),
    });
  let operationAdmissionCount = operations.size;
  let cleanup: typeof Cleanup.Type | null = null;
  let bridgeFailure: CodexBridgeError["code"] | CodexHostError["code"] | null = null;
  const recordOperation = (id: string | undefined, record: OperationRecord): boolean => {
    if (id === undefined) return true;
    if (operations.has(id)) return true;
    if (operationAdmissionCount >= CONVERSATION_MAX_TURNS) return false;
    operationAdmissionCount += 1;
    operations.set(id, record);
    return true;
  };
  const existingOperation = (
    id: string | undefined,
    mode: OperationMode,
    text: string,
    expectedTurnId?: string,
  ): OperationRecord | CodexBridgeError | undefined => {
    if (id === undefined) return undefined;
    const existing = operations.get(id);
    if (existing === undefined) return undefined;
    if (
      existing.mode !== mode ||
      existing.text !== text ||
      existing.expectedTurnId !== expectedTurnId
    )
      return new CodexBridgeError({ code: "idempotency_conflict", outcome: "rejected" });
    return existing;
  };
  const dropOldestHistory = (): boolean => {
    if (history.length <= 1) return false;
    history.splice(1, 1);
    turnsTruncated = true;
    return true;
  };
  const reserveActiveTurn = (): void => {
    while (history.length > CONVERSATION_MAX_TURNS - 1) {
      if (!dropOldestHistory()) return;
    }
  };
  const appendHistory = (turn: ConversationTurn): void => {
    history.push(turn);
    while (
      history.length > CONVERSATION_MAX_TURNS - (activeTurn === undefined ? 0 : 1) ||
      new TextEncoder().encode(JSON.stringify(history)).byteLength > MAX_HISTORY_BYTES
    ) {
      if (!dropOldestHistory()) break;
    }
  };
  const appendSteeringText = (turnId: string, text: string): void => {
    const current =
      activeTurn?.id === turnId ? activeTurn : history.find((turn) => turn.id === turnId);
    if (current === undefined) return;
    const updatedUser = boundedConversationText(`${current.user}\n${text}`);
    if (activeTurn?.id === turnId) activeTurn = { ...current, user: updatedUser.text };
    else {
      const index = history.findIndex((turn) => turn.id === turnId);
      if (index >= 0) history[index] = { ...current, user: updatedUser.text };
    }
    if (updatedUser.truncated) turnsTruncated = true;
  };
  const snapshot = Effect.suspend(() => {
    const current = host.inspect();
    const active =
      activeTurn === undefined ? [] : [{ ...activeTurn, tools: current.tools ?? activeTurn.tools }];
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
      ready: current.ready && bridgeFailure === null && !saving,
      failure: current.failure ?? bridgeFailure,
      ...(current.failureDiagnostic === null
        ? {}
        : { failureDiagnostic: current.failureDiagnostic }),
      prompt,
      tools: current.tools,
      toolsTruncated: current.toolsTruncated,
      sequence: current.sequence,
      ...(history.length === 0 && active.length === 0 ? {} : { turns: [...history, ...active] }),
      ...(turnsTruncated ? { turnsTruncated: true } : {}),
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
  const startTurn = Effect.fnUntraced(function* (input: unknown, initialOnly: boolean) {
    if (saving) return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
    const command = yield* decodePrompt(input).pipe(
      Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
    );
    if (command.threadId !== initial.threadId)
      return yield* new CodexBridgeError({ code: "wrong_thread", outcome: "rejected" });
    const boundedUser = boundedConversationText(command.text);
    const existing = existingOperation(command.clientUserMessageId, "message", command.text);
    if (Predicate.isTagged(existing, "CodexBridgeError")) return yield* existing;
    if (existing !== undefined) {
      if (existing.status === "accepted" && existing.admission !== undefined)
        return existing.admission;
      if (existing.status === "pending")
        return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
      return yield* new CodexBridgeError({ code: "idempotency_unknown", outcome: "ambiguous" });
    }
    if (command.reconcileOnly === true)
      return yield* new CodexBridgeError({ code: "idempotency_unknown", outcome: "ambiguous" });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (saving) return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
        if (prompt.status === "admitting" || prompt.status === "running")
          return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
        if (initialOnly && prompt.status !== "idle")
          return yield* new CodexBridgeError({ code: "already_admitted", outcome: "rejected" });
        if (!initialOnly && prompt.status === "idle")
          return yield* new CodexBridgeError({ code: "not_admitted", outcome: "rejected" });
        if (!initialOnly && prompt.status === "failed" && restored === undefined)
          return yield* new CodexBridgeError({ code: "host_failed", outcome: "ambiguous" });
        if (!host.inspect().ready || bridgeFailure !== null)
          return yield* new CodexBridgeError({ code: "host_failed", outcome: "rejected" });
        const operation: OperationRecord = {
          mode: "message",
          text: command.text,
          status: "pending",
        };
        if (!recordOperation(command.clientUserMessageId, operation))
          return yield* new CodexBridgeError({ code: "idempotency_unknown", outcome: "ambiguous" });
        prompt = { status: "admitting" };
        const admitted = yield* Deferred.make<typeof CodexAdmission.Type, CodexBridgeError>();
        let turnId: string | null = null;
        // Admission and terminal observation belong to the generation, not a disconnected HTTP caller.
        yield* Effect.gen(function* () {
          const turn = yield* host.prompt(command.text, command.clientUserMessageId);
          turnId = turn.turnId;
          prompt = { status: "running", turnId };
          reserveActiveTurn();
          activeTurn = {
            id: turnId,
            state: "streaming",
            user: boundedUser.text,
            assistant: "",
            tools: [],
          };
          if (boundedUser.truncated) turnsTruncated = true;
          const admission = { generation, threadId: command.threadId, turnId };
          operation.status = "accepted";
          operation.admission = admission;
          yield* Deferred.succeed(admitted, admission);
          const terminal = yield* turn.completed;
          if (terminal.id !== turnId)
            return yield* new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" });
          const current = host.inspect();
          const assistant = boundedConversationText(
            terminal.items.map((item) => item.text).join(""),
          );
          const toolValues = current.tools ?? [];
          const terminalTurn: ConversationTurn = {
            id: turnId,
            state:
              terminal.status === "completed"
                ? "completed"
                : terminal.status === "interrupted"
                  ? "aborted"
                  : "failed",
            user: activeTurn?.user ?? boundedUser.text,
            assistant: assistant.text,
            tools: toolValues,
          };
          if (assistant.truncated || current.toolsTruncated === true) turnsTruncated = true;
          appendHistory(terminalTurn);
          activeTurn = undefined;
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
              if (turnId !== null && !history.some((entry) => entry.id === turnId)) {
                const current = host.inspect();
                appendHistory({
                  id: turnId,
                  state: "failed",
                  user: activeTurn?.user ?? boundedUser.text,
                  assistant: "",
                  tools: current.tools ?? [],
                });
              }
              activeTurn = undefined;
              if (operation.status === "pending") operation.status = "unknown";
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
  const admit = (input: unknown) => startTurn(input, true);
  const message = (input: unknown) => startTurn(input, false);
  const steer = Effect.fnUntraced(function* (input: unknown) {
    if (saving) return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
    const command = yield* decodeSteer(input).pipe(
      Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
    );
    if (command.threadId !== initial.threadId)
      return yield* new CodexBridgeError({ code: "wrong_thread", outcome: "rejected" });
    const existing = existingOperation(
      command.clientUserMessageId,
      "steer",
      command.text,
      command.expectedTurnId,
    );
    if (Predicate.isTagged(existing, "CodexBridgeError")) return yield* existing;
    if (existing !== undefined) {
      if (existing.status === "accepted" && existing.admission !== undefined)
        return existing.admission;
      if (existing.status === "pending")
        return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
      return yield* new CodexBridgeError({ code: "idempotency_unknown", outcome: "ambiguous" });
    }
    if (saving) return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
    if (prompt.status !== "running" || activeTurn === undefined)
      return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
    if (steering) return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
    if (prompt.turnId !== command.expectedTurnId || activeTurn.id !== command.expectedTurnId)
      return yield* new CodexBridgeError({ code: "wrong_turn", outcome: "rejected" });
    if (!host.inspect().ready || bridgeFailure !== null)
      return yield* new CodexBridgeError({ code: "host_failed", outcome: "rejected" });
    const operation: OperationRecord = {
      mode: "steer",
      text: command.text,
      expectedTurnId: command.expectedTurnId,
      status: "pending",
    };
    if (!recordOperation(command.clientUserMessageId, operation))
      return yield* new CodexBridgeError({ code: "idempotency_unknown", outcome: "ambiguous" });
    steering = true;
    const admitted = yield* Effect.result(
      host.steer(command.text, command.expectedTurnId, command.clientUserMessageId).pipe(
        Effect.mapError(() => new CodexBridgeError({ code: "host_failed", outcome: "ambiguous" })),
        Effect.ensuring(
          Effect.sync(() => {
            steering = false;
          }),
        ),
      ),
    );
    if (Result.isFailure(admitted)) {
      operation.status = "unknown";
      return yield* admitted.failure;
    }
    const admission = admitted.success;
    if (admission.turnId !== command.expectedTurnId) {
      operation.status = "unknown";
      return yield* new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" });
    }
    appendSteeringText(command.expectedTurnId, command.text);
    const result = { generation, threadId: command.threadId, turnId: admission.turnId };
    operation.status = "accepted";
    operation.admission = result;
    return result;
  });
  const projectedTerminal = (state: typeof PromptState.Type, turnId: string, threadId: string) =>
    state.status === "terminal" && state.turnId === turnId
      ? { generation, threadId, turnId, status: state.outcome }
      : undefined;
  const interrupt = Effect.fnUntraced(function* (input: unknown) {
    const command = yield* decodeInterrupt(input).pipe(
      Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
    );
    if (command.threadId !== initial.threadId)
      return yield* new CodexBridgeError({ code: "wrong_thread", outcome: "rejected" });
    if (prompt.status === "terminal" && prompt.turnId === command.turnId)
      return {
        generation,
        threadId: command.threadId,
        turnId: command.turnId,
        status: prompt.outcome,
      };
    if (
      prompt.status !== "running" ||
      prompt.turnId !== command.turnId ||
      activeTurn?.id !== command.turnId
    )
      return yield* new CodexBridgeError({ code: "busy", outcome: "rejected" });
    if (!host.inspect().ready || bridgeFailure !== null)
      return yield* new CodexBridgeError({ code: "host_failed", outcome: "rejected" });

    const result = yield* Effect.result(host.interrupt);
    if (Result.isFailure(result)) {
      // A terminal notification may win between the prompt snapshot and the native interrupt
      // request. Reconcile from the generation-owned projection before classifying the outcome.
      const terminal = projectedTerminal(prompt, command.turnId, command.threadId);
      if (terminal !== undefined) return terminal;
      return yield* new CodexBridgeError({ code: "host_failed", outcome: "ambiguous" });
    }
    if (result.success.id !== command.turnId)
      return yield* new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" });
    return {
      generation,
      threadId: command.threadId,
      turnId: command.turnId,
      status: result.success.status,
    };
  });
  const save = yield* Effect.cached(
    Effect.gen(function* () {
      saving = true;
      while (prompt.status === "admitting" || steering) yield* Effect.sleep("10 millis");
      if (prompt.status === "running")
        yield* host.interrupt.pipe(
          Effect.mapError(
            () => new CodexBridgeError({ code: "host_failed", outcome: "ambiguous" }),
          ),
        );
      while (prompt.status === "running" || activeTurn !== undefined)
        yield* Effect.sleep("10 millis");
      const first = history[0];
      if (
        (prompt.status !== "terminal" && (prompt.status !== "failed" || prompt.turnId === null)) ||
        first === undefined ||
        initial.threadId === undefined
      )
        return yield* new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" });
      const receipt = yield* stop;
      if (receipt.parent !== "exited")
        return yield* new CodexBridgeError({ code: "host_failed", outcome: "ambiguous" });
      const saved = yield* decodeSavedHistory({
        threadId: initial.threadId,
        initialTurnId: first.id,
        prompt,
        turns: history,
        turnsTruncated,
        operations: [...operations].map(([id, operation]) => ({
          id,
          mode: operation.mode,
          text: operation.text,
          ...(operation.expectedTurnId === undefined
            ? {}
            : { expectedTurnId: operation.expectedTurnId }),
          status: operation.status === "pending" ? "unknown" : operation.status,
          ...(operation.admission === undefined ? {} : { turnId: operation.admission.turnId }),
        })),
      }).pipe(
        Effect.mapError(
          () => new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" }),
        ),
      );
      return yield* writeCodexSavedState(initial.homes.cwd, initial.homes.codexHome, saved).pipe(
        Effect.mapError(
          () => new CodexBridgeError({ code: "invalid_snapshot", outcome: "ambiguous" }),
        ),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(new CodexBridgeError({ code: "request_timeout", outcome: "ambiguous" })),
      }),
    ),
  );
  return { generation, snapshot, admit, message, steer, interrupt, stop, save };
});
export type CodexRuntime = Effect.Success<ReturnType<typeof makeCodexRuntime>>;
export const startCodexRuntime = Effect.fnUntraced(function* (input: unknown) {
  const selection = yield* decodeStart(input).pipe(
    Effect.mapError(() => new CodexBridgeError({ code: "invalid_request", outcome: "rejected" })),
  );
  if (
    (selection.restore === undefined) !== (selection.launch.resumeThreadId === undefined) ||
    (selection.restore !== undefined &&
      selection.restore.threadId !== selection.launch.resumeThreadId)
  )
    return yield* new CodexBridgeError({ code: "invalid_request", outcome: "rejected" });
  const restored =
    selection.restore === undefined
      ? undefined
      : yield* readCodexSavedState(selection.launch.workspace, selection.restore);
  const host = yield* startCodexSession(selection.launch, undefined, restored);
  return yield* makeCodexRuntime(host, selection.generation, restored?.history);
});
