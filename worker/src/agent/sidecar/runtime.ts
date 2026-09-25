import type { PiConsoleImage } from "../../../../protocol/agents/pi/pi-console";
import { Cause, Deferred, Effect, Option, Predicate, Result, Schema, Scope } from "effect";
import type {
  CanonicalConversationTool,
  CanonicalConversationTurn,
} from "../../../../protocol/session/conversation";
import { sha256Hex } from "../../shared/digest";
import {
  SidecarAdmission,
  SidecarBridgeError,
  SidecarGeneration,
  SidecarInterrupt,
  SidecarPrompt,
  SidecarSavedHistory,
  SidecarSnapshot,
  SidecarSteer,
  type SidecarAgent,
  type SidecarCleanup,
  type SidecarPersistenceIdentity,
  type SidecarPromptState,
  type SidecarSettings,
  type SidecarTurnOutcome,
} from "./protocol";

/** Typed native host failure. `code` becomes the sidecar's public failure identifier. */
export interface SidecarHostFailure {
  readonly code: string;
}
export interface SidecarHostView {
  readonly ready: boolean;
  readonly failure: string | null;
  readonly failureDiagnostic: string | null;
  readonly turnFailureDiagnostic: string | null;
  readonly tools?: ReadonlyArray<CanonicalConversationTool>;
  readonly toolsTruncated?: boolean;
  readonly sequence?: number;
}
export interface SidecarTurnTerminal {
  readonly id: string;
  readonly status: SidecarTurnOutcome;
  readonly text: string;
}

/**
 * One native agent process owned by a sidecar generation. Implementations adapt a native
 * protocol (Codex app-server, Claude Agent SDK) to turn-level operations; the runtime below
 * owns admission, idempotency, history and save ordering for every agent.
 */
export interface SidecarHost<E extends SidecarHostFailure> {
  readonly agent: SidecarAgent;
  readonly version: string;
  readonly threadId: string;
  readonly settings: SidecarSettings;
  readonly inspect: () => SidecarHostView;
  readonly prompt: (
    text: string,
    clientUserMessageId?: string,
    images?: ReadonlyArray<PiConsoleImage>,
  ) => Effect.Effect<
    { readonly turnId: string; readonly completed: Effect.Effect<SidecarTurnTerminal, E> },
    E
  >;
  readonly steer: (
    text: string,
    expectedTurnId: string,
    clientUserMessageId?: string,
    images?: ReadonlyArray<PiConsoleImage>,
  ) => Effect.Effect<{ readonly turnId: string }, E>;
  readonly interrupt: Effect.Effect<
    { readonly id: string; readonly status: SidecarTurnOutcome },
    E
  >;
  readonly stop: Effect.Effect<SidecarCleanup>;
  readonly closed: Effect.Effect<SidecarCleanup>;
  /** Folds native events that completed after their turn became terminal into history. */
  readonly settleHistory: (
    history: ReadonlyArray<CanonicalConversationTurn>,
  ) => ReadonlyArray<CanonicalConversationTurn>;
  /** Releases retained native events once a terminal turn has been projected. */
  readonly releaseEvents: () => void;
  /** Persists the native transcript and agent-neutral history after the host has exited. */
  readonly persist: (history: SidecarSavedHistory) => Effect.Effect<SidecarPersistenceIdentity, E>;
}

const decodeGeneration = Schema.decodeUnknownEffect(SidecarGeneration);
const decodePrompt = Schema.decodeUnknownEffect(SidecarPrompt, { onExcessProperty: "error" });
const decodeSteer = Schema.decodeUnknownEffect(SidecarSteer, { onExcessProperty: "error" });
const decodeInterrupt = Schema.decodeUnknownEffect(SidecarInterrupt, { onExcessProperty: "error" });
const decodeSavedHistory = Schema.decodeUnknownEffect(SidecarSavedHistory);
const decodeSnapshot = Schema.decodeUnknownEffect(SidecarSnapshot, { onExcessProperty: "error" });
const decodeSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SidecarSnapshot), {
  onExcessProperty: "error",
});

const rejected = (code: SidecarBridgeError["code"]) =>
  new SidecarBridgeError({ code, outcome: "rejected" });
const ambiguous = (code: SidecarBridgeError["code"]) =>
  new SidecarBridgeError({ code, outcome: "ambiguous" });

// The caller must compare this proof with its authoritative Session generation and thread.
export const readSidecarSnapshot = Effect.fnUntraced(function* (
  body: string,
  expected: { readonly generation: string; readonly threadId?: string; readonly turnId?: string },
) {
  const snapshot = yield* decodeSnapshotJson(body).pipe(
    Effect.mapError(() => ambiguous("invalid_snapshot")),
  );
  if (snapshot.generation !== expected.generation) return yield* ambiguous("stale_generation");
  if (expected.threadId !== undefined && snapshot.threadId !== expected.threadId)
    return yield* ambiguous("wrong_thread");
  if (
    expected.turnId !== undefined &&
    (snapshot.prompt.status === "idle" ||
      snapshot.prompt.status === "admitting" ||
      snapshot.prompt.turnId !== expected.turnId)
  )
    return yield* ambiguous("wrong_turn");
  return snapshot;
});

type OperationMode = "message" | "steer";
type OperationRecord = {
  readonly mode: OperationMode;
  readonly fingerprint: string;
  status: "pending" | "accepted" | "unknown";
  admission?: typeof SidecarAdmission.Type;
};
const fingerprintOperation = (
  threadId: string,
  mode: OperationMode,
  text: string,
  turnId?: string,
  images?: ReadonlyArray<PiConsoleImage>,
) =>
  Effect.tryPromise({
    try: () =>
      sha256Hex(
        JSON.stringify([
          threadId,
          mode,
          text,
          turnId ?? null,
          ...(images === undefined || images.length === 0 ? [] : [images]),
        ]),
      ),
    catch: () => rejected("host_failed"),
  });

const terminalState = (status: SidecarTurnOutcome): CanonicalConversationTurn["state"] =>
  status === "interrupted" ? "aborted" : status;

export const makeSidecarRuntime = Effect.fnUntraced(function* <E extends SidecarHostFailure>(
  host: SidecarHost<E>,
  generationInput: unknown,
  restored?: SidecarSavedHistory,
) {
  const generation = yield* decodeGeneration(generationInput).pipe(
    Effect.mapError(() => rejected("invalid_request")),
  );
  const scope = yield* Scope.Scope;
  const threadId = host.threadId;
  let prompt: SidecarPromptState = restored?.prompt ?? { status: "idle" };
  let saving = false;
  let activeTurn: CanonicalConversationTurn | undefined;
  let steering = false;
  let history: Array<CanonicalConversationTurn> = [...(restored?.turns ?? [])];
  const turnsTruncated = restored?.turnsTruncated ?? false;
  const operations = new Map<string, OperationRecord>();
  for (const operation of restored?.operations ?? [])
    operations.set(operation.id, {
      mode: operation.mode,
      fingerprint: operation.fingerprint,
      status: operation.status,
      ...(operation.turnId === undefined
        ? {}
        : { admission: { generation, threadId, turnId: operation.turnId } }),
    });
  let cleanup: SidecarCleanup | null = null;
  let bridgeFailure: string | null = null;
  const settle = (): void => {
    history = [...host.settleHistory(history)];
  };
  const existingOperation = (
    id: string | undefined,
    mode: OperationMode,
    fingerprint: string,
  ): OperationRecord | SidecarBridgeError | undefined => {
    if (id === undefined) return undefined;
    const existing = operations.get(id);
    if (existing === undefined) return undefined;
    if (existing.mode !== mode || existing.fingerprint !== fingerprint)
      return rejected("idempotency_conflict");
    return existing;
  };
  const replayOperation = (existing: OperationRecord) =>
    existing.status === "accepted" && existing.admission !== undefined
      ? Effect.succeed(existing.admission)
      : Effect.fail(
          existing.status === "pending" ? rejected("busy") : ambiguous("idempotency_unknown"),
        );
  const appendSteeringText = (turnId: string, text: string): void => {
    if (activeTurn?.id === turnId) {
      activeTurn = { ...activeTurn, user: `${activeTurn.user}\n${text}` };
      return;
    }
    history = history.map((turn) =>
      turn.id === turnId ? { ...turn, user: `${turn.user}\n${text}` } : turn,
    );
  };
  const available = () => host.inspect().ready && bridgeFailure === null;

  const snapshot = Effect.suspend(() => {
    settle();
    const current = host.inspect();
    const active =
      activeTurn === undefined ? [] : [{ ...activeTurn, tools: current.tools ?? activeTurn.tools }];
    return decodeSnapshot({
      agent: host.agent,
      version: host.version,
      generation,
      threadId,
      settings: host.settings,
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
    }).pipe(Effect.mapError(() => ambiguous("invalid_snapshot")));
  });
  yield* snapshot;
  const recordCleanup = (receipt: SidecarCleanup) =>
    Effect.sync(() => {
      cleanup = receipt;
    });
  const stop = yield* Effect.cached(host.stop.pipe(Effect.tap(recordCleanup)));
  yield* Effect.addFinalizer(() => stop);
  yield* host.closed.pipe(Effect.tap(recordCleanup), Effect.forkIn(scope));

  // Admission and terminal observation belong to the generation, not a disconnected HTTP caller.
  const observeTurn = (
    command: typeof SidecarPrompt.Type,
    operation: OperationRecord,
    admitted: Deferred.Deferred<typeof SidecarAdmission.Type, SidecarBridgeError>,
  ) => {
    let turnId: string | null = null;
    return Effect.gen(function* () {
      const turn = yield* host.prompt(command.text, command.clientUserMessageId, command.images);
      const admittedTurnId = turn.turnId;
      turnId = admittedTurnId;
      prompt = { status: "running", turnId: admittedTurnId };
      activeTurn = {
        id: admittedTurnId,
        state: "streaming",
        user: command.text,
        assistant: "",
        tools: [],
      };
      const admission = { generation, threadId: command.threadId, turnId: admittedTurnId };
      operation.status = "accepted";
      operation.admission = admission;
      yield* Deferred.succeed(admitted, admission);
      const terminal = yield* turn.completed;
      if (terminal.id !== admittedTurnId) return yield* ambiguous("invalid_snapshot");
      const current = host.inspect();
      history.push({
        id: admittedTurnId,
        state: terminalState(terminal.status),
        user: activeTurn?.user ?? command.text,
        assistant: terminal.text,
        ...(terminal.status !== "failed"
          ? {}
          : {
              activitySummary:
                current.turnFailureDiagnostic === null
                  ? "Turn failed."
                  : `Turn failed: ${current.turnFailureDiagnostic}`,
            }),
        tools: current.tools ?? [],
      });
      activeTurn = undefined;
      prompt = {
        status: "terminal",
        turnId: admittedTurnId,
        outcome: terminal.status,
        text: terminal.text,
      };
      yield* snapshot;
      host.releaseEvents();
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          prompt = { status: "failed", turnId };
          const failedTurnId = turnId;
          if (failedTurnId !== null && !history.some((entry) => entry.id === failedTurnId))
            history.push({
              id: failedTurnId,
              state: "failed",
              user: activeTurn?.user ?? command.text,
              assistant: "",
              tools: host.inspect().tools ?? [],
            });
          activeTurn = undefined;
          if (operation.status === "pending") operation.status = "unknown";
          const error = Cause.findErrorOption(cause);
          bridgeFailure = Option.isSome(error)
            ? error.value.code
            : Cause.hasInterruptsOnly(cause)
              ? "interrupted"
              : "host_failed";
          yield* Deferred.fail(admitted, ambiguous("host_failed"));
          yield* stop;
        }),
      ),
    );
  };

  const startTurn = Effect.fnUntraced(function* (input: unknown, initialOnly: boolean) {
    if (saving) return yield* rejected("busy");
    const command = yield* decodePrompt(input).pipe(
      Effect.mapError(() => rejected("invalid_request")),
    );
    if (command.threadId !== threadId) return yield* rejected("wrong_thread");
    const fingerprint = yield* fingerprintOperation(
      command.threadId,
      "message",
      command.text,
      undefined,
      command.images,
    );
    const existing = existingOperation(command.clientUserMessageId, "message", fingerprint);
    if (Predicate.isTagged(existing, "SidecarBridgeError")) return yield* existing;
    if (existing !== undefined) return yield* replayOperation(existing);
    if (command.reconcileOnly === true) return yield* ambiguous("idempotency_unknown");
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (saving || prompt.status === "admitting" || prompt.status === "running")
          return yield* rejected("busy");
        if (initialOnly && prompt.status !== "idle") return yield* rejected("already_admitted");
        if (!initialOnly && prompt.status === "idle") return yield* rejected("not_admitted");
        if (!available()) return yield* rejected("host_failed");
        const operation: OperationRecord = { mode: "message", fingerprint, status: "pending" };
        if (command.clientUserMessageId !== undefined)
          operations.set(command.clientUserMessageId, operation);
        prompt = { status: "admitting" };
        const admitted = yield* Deferred.make<typeof SidecarAdmission.Type, SidecarBridgeError>();
        yield* observeTurn(command, operation, admitted).pipe(
          Effect.interruptible,
          Effect.forkIn(scope),
        );
        return yield* restore(Deferred.await(admitted));
      }),
    );
  });

  const steer = Effect.fnUntraced(function* (input: unknown) {
    if (saving) return yield* rejected("busy");
    const command = yield* decodeSteer(input).pipe(
      Effect.mapError(() => rejected("invalid_request")),
    );
    if (command.threadId !== threadId) return yield* rejected("wrong_thread");
    const fingerprint = yield* fingerprintOperation(
      command.threadId,
      "steer",
      command.text,
      command.expectedTurnId,
      command.images,
    );
    const existing = existingOperation(command.clientUserMessageId, "steer", fingerprint);
    if (Predicate.isTagged(existing, "SidecarBridgeError")) return yield* existing;
    if (existing !== undefined) return yield* replayOperation(existing);
    if (saving || steering || prompt.status !== "running" || activeTurn === undefined)
      return yield* rejected("busy");
    if (prompt.turnId !== command.expectedTurnId || activeTurn.id !== command.expectedTurnId)
      return yield* rejected("wrong_turn");
    if (!available()) return yield* rejected("host_failed");
    const operation: OperationRecord = { mode: "steer", fingerprint, status: "pending" };
    if (command.clientUserMessageId !== undefined)
      operations.set(command.clientUserMessageId, operation);
    steering = true;
    const admitted = yield* Effect.result(
      host
        .steer(command.text, command.expectedTurnId, command.clientUserMessageId, command.images)
        .pipe(
          Effect.mapError(() => ambiguous("host_failed")),
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
    if (admitted.success.turnId !== command.expectedTurnId) {
      operation.status = "unknown";
      return yield* ambiguous("invalid_snapshot");
    }
    appendSteeringText(command.expectedTurnId, command.text);
    const result = { generation, threadId: command.threadId, turnId: admitted.success.turnId };
    operation.status = "accepted";
    operation.admission = result;
    return result;
  });

  const interrupt = Effect.fnUntraced(function* (input: unknown) {
    const command = yield* decodeInterrupt(input).pipe(
      Effect.mapError(() => rejected("invalid_request")),
    );
    if (command.threadId !== threadId) return yield* rejected("wrong_thread");
    const terminal = () =>
      prompt.status === "terminal" && prompt.turnId === command.turnId
        ? { generation, ...command, status: prompt.outcome }
        : undefined;
    const settled = terminal();
    if (settled !== undefined) return settled;
    if (
      prompt.status !== "running" ||
      prompt.turnId !== command.turnId ||
      activeTurn?.id !== command.turnId
    )
      return yield* rejected("busy");
    if (!available()) return yield* rejected("host_failed");
    const result = yield* Effect.result(host.interrupt);
    if (Result.isFailure(result))
      // A terminal notification may win between the prompt snapshot and the native interrupt
      // request. Reconcile from the generation-owned projection before classifying the outcome.
      return terminal() ?? (yield* ambiguous("host_failed"));
    if (result.success.id !== command.turnId) return yield* ambiguous("invalid_snapshot");
    return { generation, ...command, status: result.success.status };
  });

  const save = yield* Effect.cached(
    Effect.gen(function* () {
      saving = true;
      while (prompt.status === "admitting" || steering) yield* Effect.sleep("10 millis");
      if (prompt.status === "running")
        yield* host.interrupt.pipe(Effect.mapError(() => ambiguous("host_failed")));
      while (prompt.status === "running" || activeTurn !== undefined)
        yield* Effect.sleep("10 millis");
      const first = history[0];
      if (
        (prompt.status !== "terminal" && prompt.status !== "failed") ||
        prompt.turnId === null ||
        first === undefined
      )
        return yield* ambiguous("invalid_snapshot");
      const receipt = yield* stop;
      if (receipt.parent !== "exited") return yield* ambiguous("host_failed");
      settle();
      // No more terminal events can arrive through this generation. A tool still
      // running here has no confirmed result and must not be restored as live.
      history = history.map((turn) => ({
        ...turn,
        tools: turn.tools.map((tool) =>
          tool.state === "running" ? { ...tool, state: "failed" as const } : tool,
        ),
      }));
      const saved = yield* decodeSavedHistory({
        threadId,
        initialTurnId: first.id,
        prompt,
        turns: history,
        turnsTruncated,
        operations: [...operations].map(([id, operation]) => ({
          id,
          mode: operation.mode,
          fingerprint: operation.fingerprint,
          status: operation.status === "pending" ? "unknown" : operation.status,
          ...(operation.admission === undefined ? {} : { turnId: operation.admission.turnId }),
        })),
      }).pipe(Effect.mapError(() => ambiguous("invalid_snapshot")));
      return yield* host.persist(saved).pipe(Effect.mapError(() => ambiguous("invalid_snapshot")));
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(ambiguous("request_timeout")),
      }),
    ),
  );
  return {
    generation,
    snapshot,
    admit: (input: unknown) => startTurn(input, true),
    message: (input: unknown) => startTurn(input, false),
    steer,
    interrupt,
    stop,
    save,
  };
});
export type SidecarRuntime = Effect.Success<ReturnType<typeof makeSidecarRuntime>>;
