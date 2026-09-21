import type { PiConsoleImage } from "../../../../protocol/agents/pi/pi-console";
import { HatchFailure, renderHatchFailure } from "./first-party-tools";
import type { CodexSavedState } from "./persistence-format";
import { createHash } from "node:crypto";
import { Clock, Deferred, Effect, Fiber, Predicate, Result, Schema, Scope, Stream } from "effect";
import {
  CODEX_VERSION,
  CODEX_NOTIFICATION_POLICY,
  decodeCodexClientMessage,
  decodeCodexInitializeResponse,
  decodeCodexThreadReadResponse,
  decodeCodexThreadResumeResponse,
  decodeCodexThreadStartResponse,
  decodeCodexTurnStartResponse,
  decodeCodexSteerResponse,
  decodeCodexInterruptResponse,
  decodeCodexNotification,
  decodeCodexNotificationEnvelope,
  decodeCodexStateNotification,
  decodeCodexDynamicToolCall,
  rejectCodexServerRequest,
  type CodexClientMessage,
  type CodexDynamicToolResponse,
  type CodexDynamicToolCall,
  type CodexNotification,
  type CodexThreadReadResult,
  type CodexThreadSettings,
  type CodexUnsupportedResponse,
} from "../../../../protocol/agents/codex/codex-app-server";
import { CodexHostError, type Cleanup } from "./errors";
import { makeCodexTools } from "./tools";
import {
  codexFirstPartyToolSpecs,
  makeCodexFirstPartyTools,
  type CodexFirstPartyToolName,
  type CodexFirstPartyTools,
} from "./first-party-tools";
import { makeFramer } from "./framing";
import { launchProcess, type CodexProcess } from "./process";

type Terminal = Extract<CodexNotification, { method: "turn/completed" }>["params"]["turn"];
type Request = Exclude<CodexClientMessage, { method: "initialized" }>;
type Pending = {
  readonly fatal: boolean;
  readonly receive: (line: string) => Effect.Effect<void, CodexHostError>;
  readonly fail: (error: CodexHostError) => Effect.Effect<unknown>;
};
const activityChildThreadId = (message: CodexNotification) =>
  (message.method === "item/started" || message.method === "item/completed") &&
  message.params.item.type === "subAgentActivity" &&
  Predicate.hasProperty(message.params.item, "agentThreadId")
    ? message.params.item.agentThreadId
    : undefined;
type Turn = {
  id: string | undefined;
  started: boolean;
  readonly beforeAdmissionReply: Array<BeforeAdmissionReply>;
  readonly terminal: Deferred.Deferred<Terminal, CodexHostError>;
  interruption?: Effect.Effect<Terminal, CodexHostError>;
};
const decodePrompt = Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)));
const Route = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
});
const decodeRoute = Schema.decodeUnknownEffect(Schema.fromJsonString(Route));
const decodeNotificationThread = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      params: Schema.Struct({
        threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }).annotate({ parseOptions: { onExcessProperty: "ignore" } }),
    }).annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  ),
);
// Native 0.153.4 can label HTTP 401 as "other"; never classify auth from remote prose.
const decodeUpstreamFailure = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.Literal("error"),
      params: Schema.Struct({
        threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        turnId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        willRetry: Schema.Boolean,
        error: Schema.Struct({
          message: Schema.String,
          codexErrorInfo: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
        }),
      }),
    }),
  ),
);
// Pinned CodexErrorInfo variants; do not inspect or publish error.message.
const UpstreamErrorCategory = Schema.Literals([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);
const HttpStatusCode = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }));
const decodeUpstreamErrorCategory = Schema.decodeUnknownResult(UpstreamErrorCategory);
const UpstreamHttpStatus = Schema.Struct({
  httpStatusCode: Schema.optionalKey(Schema.NullOr(HttpStatusCode)),
});
const strict = { onExcessProperty: "error" } as const;
const decodeUpstreamHttpInfo = Schema.decodeUnknownResult(
  Schema.Union([
    Schema.Struct({ httpConnectionFailed: UpstreamHttpStatus }),
    Schema.Struct({ responseStreamConnectionFailed: UpstreamHttpStatus }),
    Schema.Struct({ responseStreamDisconnected: UpstreamHttpStatus }),
    Schema.Struct({ responseTooManyFailedAttempts: UpstreamHttpStatus }),
  ]),
  strict,
);
const decodeActiveTurnNotSteerable = Schema.decodeUnknownResult(
  Schema.Struct({
    activeTurnNotSteerable: Schema.Struct({ turnKind: Schema.Literals(["review", "compact"]) }),
  }),
  strict,
);
const upstreamDiagnostic = (info: unknown): string => {
  const category = decodeUpstreamErrorCategory(info);
  if (Result.isSuccess(category)) return category.success;
  const activeTurn = decodeActiveTurnNotSteerable(info);
  if (Result.isSuccess(activeTurn))
    return `activeTurnNotSteerable:${activeTurn.success.activeTurnNotSteerable.turnKind}`;
  const decoded = decodeUpstreamHttpInfo(info);
  if (Result.isSuccess(decoded)) {
    const entry = Object.entries(decoded.success)[0];
    if (entry === undefined) return "unclassified";
    const [name, value] = entry;
    const status = value.httpStatusCode;
    return status === undefined || status === null ? name : `${name}:${status}`;
  }
  return "unclassified";
};
type UpstreamFailure =
  ReturnType<typeof decodeUpstreamFailure> extends Effect.Effect<infer A, infer _E, infer _R>
    ? A
    : never;
type BeforeAdmissionReply =
  | { readonly kind: "notification"; readonly message: CodexNotification }
  | { readonly kind: "dynamic"; readonly request: CodexDynamicToolCall }
  | { readonly kind: "upstream"; readonly rejection: UpstreamFailure };
const decoded = <A>(result: Result.Result<A, "invalid_message">) =>
  Result.match(result, {
    onSuccess: Effect.succeed,
    onFailure: (code) => Effect.fail(new CodexHostError({ code })),
  });
const decodedNotification = <A>(result: Result.Result<A, "invalid_message">, method: string) =>
  Result.match(result, {
    onSuccess: Effect.succeed,
    onFailure: () =>
      Effect.fail(
        new CodexHostError({ code: "invalid_message", staleDiagnostic: `decode:${method}` }),
      ),
  });

const matchesThreadSettings = (
  settings: CodexThreadSettings,
  transport: CodexProcess,
  ephemeral: boolean,
  resumeThreadId: string | undefined,
) =>
  settings.model === transport.options.model &&
  settings.modelProvider === "scotty-managed" &&
  settings.cwd === transport.homes.cwd &&
  settings.reasoningEffort === transport.options.effort &&
  (settings.thread.ephemeral === undefined || settings.thread.ephemeral === ephemeral) &&
  (settings.thread.historyMode === undefined ||
    settings.thread.historyMode === (ephemeral ? "legacy" : "paginated")) &&
  (ephemeral ||
    (settings.thread.ephemeral === false && settings.thread.historyMode === "paginated")) &&
  (resumeThreadId === undefined || settings.thread.id === resumeThreadId);

const matchesDurableReadback = (readback: CodexThreadReadResult, threadId: string) =>
  readback.thread.id === threadId &&
  readback.thread.ephemeral === false &&
  readback.thread.historyMode === "paginated";

// Each factory invocation is one process generation. No durable Session state is owned here.
export const makeSession = Effect.fnUntraced(function* (
  transport: CodexProcess,
  publish?: (event: CodexNotification) => Effect.Effect<void, CodexHostError>,
  firstPartyTools?: CodexFirstPartyTools,
  retainEvents = publish === undefined,
) {
  const emit = publish ?? (() => Effect.void);
  const scope = yield* Scope.Scope;
  const failed = yield* Deferred.make<never, CodexHostError>();
  const closed = yield* Deferred.make<Cleanup>();
  const pending = new Map<number, Pending>();
  const usedTurns = new Set<string>();
  const events: Array<CodexNotification> = [];
  const lateCommandEvents: Array<CodexNotification> = [];
  const tools = makeCodexTools();
  const startedDynamicTools = new Map<string, string>();
  const toolReceipts = new Map<
    string,
    {
      readonly turnId: string;
      readonly tool: CodexFirstPartyToolName;
      readonly argumentsHash: string;
      readonly result: Deferred.Deferred<CodexDynamicToolResponse["result"]>;
    }
  >();
  const toolFibers = new Map<string, Fiber.Fiber<void, CodexHostError>>();
  // Native child-turn traffic shares the app-server stdout with its parent.
  // Only parent-fenced subAgentActivity can authorize a child thread here.
  const childTurnOwners = new Map<string, Set<string>>();
  const completedTurns = new Set<string>();
  let turnFailureDiagnostic: string | null = null;
  let awaitingFailureTerminal: string | undefined;
  // Native command watchers can outlive their turn. Retain only bounded, exact
  // command ownership so their late output cannot be mistaken for a new turn.
  const commandOwners = new Map<string, Map<string, "running" | "completed">>();
  const isKnownChildNotification = (line: string) => {
    const routed = decodeNotificationThread(line);
    return Result.isSuccess(routed) && childTurnOwners.has(routed.success.params.threadId);
  };
  // A child's final activity can arrive on the parent thread after that turn completes.
  const isTrailingChildActivity = (message: CodexNotification) => {
    const childThreadId = activityChildThreadId(message);
    return (
      childThreadId !== undefined &&
      Predicate.hasProperty(message.params, "turnId") &&
      message.params.threadId === threadId &&
      completedTurns.has(message.params.turnId) &&
      childTurnOwners.get(childThreadId)?.has(message.params.turnId) === true
    );
  };
  const stale = (
    source: CodexNotification["method"] | "error" | "item/tool/call",
    eventThreadId: string,
    eventTurnId?: string,
    itemType?: string,
  ) => {
    const threadRelation =
      eventThreadId === threadId
        ? "parent"
        : childTurnOwners.has(eventThreadId)
          ? "known_child"
          : "foreign";
    const turnRelation =
      eventTurnId === undefined
        ? "none"
        : eventTurnId === active?.id
          ? "active"
          : completedTurns.has(eventTurnId)
            ? "completed"
            : "other";
    const itemKind =
      itemType === undefined
        ? "none"
        : itemType === "subAgentActivity" ||
            itemType === "commandExecution" ||
            itemType === "agentMessage"
          ? itemType
          : "other";
    return new CodexHostError({
      code: "stale_notification",
      staleDiagnostic: `${source} ${threadRelation} ${turnRelation} ${itemKind}`,
    });
  };
  let ready = false,
    closing = false,
    threadId: string | undefined,
    active: Turn | undefined;
  let failure: CodexHostError | undefined;
  let sequence = 0,
    eventCount = 0,
    stderrBytes = 0,
    discarded = 0,
    rejected = 0;
  const fail = Effect.fnUntraced(function* (error: CodexHostError) {
    failure ??= error;
    ready = false;
    yield* Deferred.fail(failed, failure);
    for (const entry of pending.values()) yield* entry.fail(failure);
    pending.clear();
    if (active) yield* Deferred.fail(active.terminal, failure);
    active = undefined;
  });
  const stop = yield* Effect.cached(
    Effect.gen(function* () {
      closing = true;
      ready = false;
      yield* Fiber.interruptAll(toolFibers.values());
      toolFibers.clear();
      const stopped = failure ?? new CodexHostError({ code: "stopped" });
      for (const entry of pending.values()) yield* entry.fail(stopped);
      pending.clear();
      if (active) yield* Deferred.fail(active.terminal, stopped);
      active = undefined;
      const toolCleanup = firstPartyTools
        ? yield* Effect.result(
            Effect.tryPromise({
              try: () => firstPartyTools.shutdown(),
              catch: () => new CodexHostError({ code: "hatch_cleanup_failed" }),
            }),
          )
        : undefined;
      const receipt = {
        ...(yield* transport.stop),
        failure:
          toolCleanup !== undefined && Result.isFailure(toolCleanup)
            ? "hatch_cleanup_failed"
            : (failure?.code ?? null),
      };
      yield* Deferred.succeed(closed, receipt);
      return receipt;
    }).pipe(Effect.uninterruptible),
  );
  const supervise = <A>(effect: Effect.Effect<A, CodexHostError>) =>
    effect.pipe(
      Effect.catch((error) => (closing ? Effect.void : fail(error))),
      Effect.forkIn(scope),
    );
  yield* Deferred.await(failed).pipe(
    Effect.catch(() => stop),
    Effect.forkIn(scope),
  );
  const timed = Effect.fnUntraced(function* <A>(
    effect: Effect.Effect<A, CodexHostError>,
    startupDeadline?: number,
  ) {
    const duration =
      startupDeadline === undefined
        ? transport.options.requestTimeoutMs
        : startupDeadline - Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
    const timeout = () =>
      Effect.fail(
        new CodexHostError({
          code: startupDeadline === undefined ? "request_timeout" : "startup_timeout",
        }),
      );
    if (duration <= 0) return yield* timeout();
    return yield* effect.pipe(Effect.timeoutOrElse({ duration, orElse: timeout }));
  });
  const write = Effect.fnUntraced(function* (
    message: CodexClientMessage | CodexUnsupportedResponse | CodexDynamicToolResponse,
    startupDeadline?: number,
  ) {
    if (closing || failure) return yield* new CodexHostError({ code: "stopped" });
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    yield* timed(transport.write(bytes), startupDeadline);
  });
  const rpc = Effect.fnUntraced(function* <A>(
    request: Omit<Request, "id">,
    decoder: (line: string) => Result.Result<
      | { readonly id: string | number; readonly result: A }
      | {
          readonly id: string | number;
          readonly error: { readonly code: number; readonly message: string };
        },
      "invalid_message"
    >,
    accept: (value: A) => Effect.Effect<void, CodexHostError> = () => Effect.void,
    startupDeadline?: number,
    fatal = true,
  ) {
    const id = ++sequence;
    const message = yield* decoded(decodeCodexClientMessage(JSON.stringify({ ...request, id })));
    const response = yield* Deferred.make<A, CodexHostError>();
    pending.set(id, {
      fatal,
      fail: (error) => {
        pending.delete(id);
        return Deferred.fail(response, error);
      },
      receive: Effect.fnUntraced(function* (line) {
        const value = yield* decoded(decoder(line));
        if (value.id !== id) return yield* new CodexHostError({ code: "unexpected_response_id" });
        if (Predicate.hasProperty(value, "error"))
          return yield* new CodexHostError({ code: "rpc_rejected" });
        yield* accept(value.result);
        pending.delete(id);
        yield* Deferred.succeed(response, value.result);
      }),
    });
    return yield* timed(
      write(message, startupDeadline).pipe(Effect.andThen(Deferred.await(response))),
      startupDeadline,
    ).pipe(
      Effect.tapError((error) =>
        fatal
          ? fail(error)
          : Effect.sync(() => {
              pending.delete(id);
            }),
      ),
      Effect.onInterrupt(() =>
        fatal
          ? fail(new CodexHostError({ code: "interrupted" }))
          : Effect.sync(() => {
              pending.delete(id);
            }),
      ),
    );
  });
  const recordDynamicItem = (message: CodexNotification) => {
    if (message.method === "item/started") {
      const item = message.params.item;
      if (
        item.type === "dynamicToolCall" &&
        Predicate.hasProperty(item, "id") &&
        Predicate.hasProperty(item, "tool")
      )
        startedDynamicTools.set(item.id, item.tool);
    } else if (message.method === "item/completed") {
      const item = message.params.item;
      if (item.type === "dynamicToolCall" && Predicate.hasProperty(item, "id"))
        startedDynamicTools.delete(item.id);
    }
  };
  const admissionIdentity = (
    entry: BeforeAdmissionReply,
  ): {
    readonly method: CodexNotification["method"] | "item/tool/call" | "error";
    readonly threadId: string;
    readonly turnId: string;
  } => {
    if (entry.kind === "notification")
      return {
        method: entry.message.method,
        threadId: entry.message.params.threadId,
        turnId: Predicate.hasProperty(entry.message.params, "turnId")
          ? entry.message.params.turnId
          : entry.message.params.turn.id,
      };
    if (entry.kind === "dynamic") return { method: "item/tool/call", ...entry.request.params };
    return { method: "error", ...entry.rejection.params };
  };
  const bufferBeforeAdmissionReply = (entry: BeforeAdmissionReply) =>
    Effect.sync(() => {
      if (
        active === undefined ||
        active.id !== undefined ||
        admissionIdentity(entry).threadId !== threadId
      )
        return false;
      active.beforeAdmissionReply.push(entry);
      return true;
    });
  const consumeBeforeActive = Effect.fnUntraced(function* (message: CodexNotification) {
    if (yield* acceptLateCommand(message)) return true;
    if (isTrailingChildActivity(message)) {
      discarded++;
      return true;
    }
    return yield* bufferBeforeAdmissionReply({ kind: "notification", message });
  });
  const acceptLateCommand = Effect.fnUntraced(function* (message: CodexNotification) {
    if (
      message.params.threadId !== threadId ||
      !Predicate.hasProperty(message.params, "turnId") ||
      !completedTurns.has(message.params.turnId) ||
      (message.method !== "item/completed" &&
        message.method !== "item/commandExecution/outputDelta")
    )
      return false;
    if (message.method === "item/completed" && message.params.item.type !== "commandExecution")
      return false;
    const itemId =
      message.method === "item/completed"
        ? Predicate.hasProperty(message.params.item, "id")
          ? message.params.item.id
          : undefined
        : Predicate.hasProperty(message.params, "itemId")
          ? message.params.itemId
          : undefined;
    if (itemId === undefined) return false;
    const owned = commandOwners.get(message.params.turnId);
    if (owned?.get(itemId) !== "running") return false;
    if (message.method === "item/completed") owned.set(itemId, "completed");
    if (retainEvents) events.push(message);
    if (publish === undefined) lateCommandEvents.push(message);
    yield* emit(message);
    return true;
  });
  const recordCommandOwnership = Effect.fnUntraced(function* (
    message: CodexNotification,
    id: string,
  ) {
    if (message.method !== "item/started" && message.method !== "item/completed") return;
    if (!Predicate.hasProperty(message.params.item, "command")) return;
    const itemId = message.params.item.id;
    const owned = commandOwners.get(id) ?? new Map<string, "running" | "completed">();
    if (message.method === "item/started") {
      if (owned.has(itemId))
        return yield* stale(message.method, message.params.threadId, id, message.params.item.type);
      owned.set(itemId, "running");
      commandOwners.set(id, owned);
    } else {
      if (owned.get(itemId) === "completed")
        return yield* stale(message.method, message.params.threadId, id, message.params.item.type);
      commandOwners.get(id)?.set(itemId, "completed");
    }
  });
  const completeTurn = Effect.fnUntraced(function* (
    turn: Turn,
    message: Extract<CodexNotification, { method: "turn/completed" }>,
  ) {
    completedTurns.add(message.params.turn.id);
    awaitingFailureTerminal = undefined;
    while (commandOwners.size > 64) {
      const oldest = commandOwners.keys().next().value;
      if (oldest === undefined) break;
      commandOwners.delete(oldest);
    }
    startedDynamicTools.clear();
    for (const [callId, fiber] of toolFibers) {
      const receipt = toolReceipts.get(callId);
      if (receipt !== undefined)
        yield* Deferred.succeed(receipt.result, toolResult("Tool call interrupted.", false));
      yield* Fiber.interrupt(fiber).pipe(Effect.forkIn(scope));
    }
    toolFibers.clear();
    if (active === turn) active = undefined;
    yield* Deferred.succeed(turn.terminal, message.params.turn);
  });
  const notification = Effect.fnUntraced(function* (message: CodexNotification) {
    const id = Predicate.hasProperty(message.params, "turnId")
      ? message.params.turnId
      : message.params.turn.id;
    // Native starts the turn before enqueuing the turn/start RPC response. Hold
    // only this parent's events until that response supplies the exact turn ID.
    if (yield* consumeBeforeActive(message)) return;
    if (!active || message.params.threadId !== threadId || id !== active.id)
      return yield* stale(
        message.method,
        message.params.threadId,
        id,
        Predicate.hasProperty(message.params, "item") ? message.params.item.type : undefined,
      );
    const turn = active;
    if (message.method === "turn/started") {
      if (turn.started) return yield* new CodexHostError({ code: "duplicate_turn_started" });
      turn.started = true;
      turnFailureDiagnostic = null;
      awaitingFailureTerminal = undefined;
      startedDynamicTools.clear();
      toolReceipts.clear();
    } else if (!turn.started) return yield* new CodexHostError({ code: "turn_not_started" });
    recordDynamicItem(message);
    yield* recordCommandOwnership(message, id);
    const childThreadId = activityChildThreadId(message);
    if (childThreadId !== undefined && childThreadId !== threadId) {
      const owners = childTurnOwners.get(childThreadId) ?? new Set<string>();
      owners.add(id);
      childTurnOwners.set(childThreadId, owners);
    }
    tools.accept(message);
    if (retainEvents) events.push(message);
    yield* emit(message);
    if (closing || failure || active !== turn) return;
    if (message.method === "turn/completed") yield* completeTurn(turn, message);
  });
  const toolResult = (text: string, success: boolean): CodexDynamicToolResponse["result"] => ({
    contentItems: [{ type: "inputText", text }],
    success,
  });
  const canAdmitDynamicCall = (
    params: {
      readonly threadId: string;
      readonly turnId: string;
      readonly callId: string;
      readonly namespace?: string | null;
    },
    tool: CodexFirstPartyToolName | undefined,
  ) =>
    firstPartyTools !== undefined &&
    ready &&
    !closing &&
    !failure &&
    active?.started === true &&
    active.id === params.turnId &&
    threadId === params.threadId &&
    (params.namespace === undefined || params.namespace === null) &&
    tool !== undefined &&
    (startedDynamicTools.get(params.callId) === tool || toolReceipts.has(params.callId));
  const handleDynamicToolCall = Effect.fnUntraced(function* (request: CodexDynamicToolCall) {
    const params = request.params;
    const tool =
      params.tool === "scotty_hatch" || params.tool === "scotty_browser_test"
        ? params.tool
        : undefined;
    const admitted = canAdmitDynamicCall(params, tool);
    if (!admitted || tool === undefined || firstPartyTools === undefined) {
      yield* write({ id: request.id, result: toolResult("Tool call unavailable.", false) });
      rejected++;
      return;
    }
    const argumentsHash = createHash("sha256")
      .update(JSON.stringify(params.arguments))
      .digest("hex");
    const previous = toolReceipts.get(params.callId);
    if (
      previous !== undefined &&
      (previous.turnId !== params.turnId ||
        previous.tool !== tool ||
        previous.argumentsHash !== argumentsHash)
    ) {
      yield* write({ id: request.id, result: toolResult("Tool call identity conflict.", false) });
      rejected++;
      return;
    }
    const result = previous?.result ?? (yield* Deferred.make<CodexDynamicToolResponse["result"]>());
    if (previous === undefined) {
      toolReceipts.set(params.callId, { turnId: params.turnId, tool, argumentsHash, result });
      tools.acceptDynamicCall(params.callId, params.arguments);
      const execution = Effect.tryPromise({
        try: (signal) => firstPartyTools.execute(tool, params.arguments, signal),
        catch: (cause) =>
          cause instanceof HatchFailure
            ? cause
            : new CodexHostError({ code: "tool_execution_failed" }),
      }).pipe(
        Effect.map((value) => toolResult(value.text, value.success)),
        Effect.catchTags({
          HatchFailure: (error) => Effect.succeed(toolResult(renderHatchFailure(error), false)),
          CodexHostError: () =>
            Effect.succeed(
              toolResult(
                "Tool execution failed without a classified result. Inspect tool status and diagnostics before retrying.",
                false,
              ),
            ),
        }),
        Effect.tap((value) =>
          Effect.sync(() => {
            tools.acceptDynamicResult(params.callId, value.contentItems[0].text);
          }),
        ),
        Effect.andThen((value) => Deferred.succeed(result, value)),
        Effect.onInterrupt(() =>
          Deferred.succeed(result, toolResult("Tool call interrupted.", false)),
        ),
        Effect.asVoid,
      );
      const fiber = yield* execution.pipe(Effect.forkIn(scope));
      toolFibers.set(params.callId, fiber);
      yield* Fiber.await(fiber).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (toolFibers.get(params.callId) === fiber) toolFibers.delete(params.callId);
          }),
        ),
        Effect.forkIn(scope),
      );
    }
    yield* supervise(
      Deferred.await(result).pipe(
        Effect.flatMap((value) => write({ id: request.id, result: value })),
      ),
    );
  });
  const handleUpstreamFailure = Effect.fnUntraced(function* (rejection: UpstreamFailure) {
    if (!active || rejection.params.threadId !== threadId || rejection.params.turnId !== active.id)
      return yield* stale("error", rejection.params.threadId, rejection.params.turnId);
    if (rejection.params.willRetry) {
      discarded++;
      return;
    }
    // Native reports a non-retryable model error before turn/completed(status=failed).
    // Keep the process available for its terminal, but bound missing settlement.
    turnFailureDiagnostic = upstreamDiagnostic(rejection.params.error.codexErrorInfo);
    discarded++;
    if (awaitingFailureTerminal === rejection.params.turnId) return;
    awaitingFailureTerminal = rejection.params.turnId;
    const pendingTurnId = rejection.params.turnId;
    const diagnostic = turnFailureDiagnostic;
    yield* supervise(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(
          Effect.suspend(() =>
            active?.id === pendingTurnId && awaitingFailureTerminal === pendingTurnId
              ? Effect.fail(
                  new CodexHostError({ code: "upstream_failed", upstreamDiagnostic: diagnostic }),
                )
              : Effect.void,
          ),
        ),
      ),
    );
  });
  const handleState = Effect.fnUntraced(function* (line: string, method: string) {
    const event = yield* decodedNotification(decodeCodexStateNotification(line), method);
    if (event.params.threadId !== (threadId ?? transport.options.resumeThreadId)) {
      discarded++;
      return;
    }
    if (event.method === "thread/closed" || event.method === "thread/deleted")
      return yield* new CodexHostError({ code: "not_ready", staleDiagnostic: event.method });
    if (event.method === "model/rerouted") {
      if (event.params.toModel !== transport.options.model)
        return yield* new CodexHostError({
          code: "settings_mismatch",
          staleDiagnostic: event.method,
        });
    } else if (event.method === "thread/settings/updated") {
      const settings = event.params.threadSettings;
      if (
        settings.model !== transport.options.model ||
        settings.modelProvider !== "scotty-managed" ||
        settings.cwd !== transport.homes.cwd ||
        settings.approvalPolicy !== "never" ||
        settings.approvalsReviewer !== "user" ||
        settings.sandboxPolicy.type !== "dangerFullAccess" ||
        settings.effort !== transport.options.effort
      )
        return yield* new CodexHostError({
          code: "settings_mismatch",
          staleDiagnostic: event.method,
        });
    }
    discarded++;
  });
  const receiveDynamicToolCall = Effect.fnUntraced(function* (line: string) {
    const decodedCall = decodeCodexDynamicToolCall(line);
    if (Result.isFailure(decodedCall)) {
      yield* write(yield* decoded(rejectCodexServerRequest(line)));
      rejected++;
      return;
    }
    const request = decodedCall.success;
    if (yield* bufferBeforeAdmissionReply({ kind: "dynamic", request })) return;
    return yield* handleDynamicToolCall(request);
  });
  const receiveUpstreamFailure = Effect.fnUntraced(function* (line: string) {
    const rejection = yield* decodeUpstreamFailure(line).pipe(
      Effect.mapError(
        () => new CodexHostError({ code: "invalid_message", staleDiagnostic: "decode:error" }),
      ),
    );
    if (yield* bufferBeforeAdmissionReply({ kind: "upstream", rejection })) return;
    return yield* handleUpstreamFailure(rejection);
  });
  const receive = Effect.fnUntraced(function* (line: string) {
    if (closing) return;
    eventCount++;
    const route = yield* decodeRoute(line).pipe(
      Effect.mapError(
        () => new CodexHostError({ code: "invalid_message", staleDiagnostic: "decode:route" }),
      ),
    );
    if (route.id !== undefined) {
      if (route.method !== undefined) {
        if (route.method === "item/tool/call" && firstPartyTools !== undefined)
          return yield* receiveDynamicToolCall(line);
        yield* write(yield* decoded(rejectCodexServerRequest(line)));
        rejected++;
        return;
      }
      const entry = typeof route.id === "number" ? pending.get(route.id) : undefined;
      if (!entry) return yield* new CodexHostError({ code: "unexpected_response_id" });
      return yield* entry
        .receive(line)
        .pipe(
          Effect.catchTag("CodexHostError", (error) =>
            !entry.fatal && error.code === "rpc_rejected"
              ? entry.fail(error).pipe(Effect.asVoid)
              : Effect.fail(error),
          ),
        );
    }
    if (isKnownChildNotification(line)) {
      discarded++;
      return;
    }
    if (
      CODEX_NOTIFICATION_POLICY.execution.some((method) => method === route.method) &&
      route.method !== "error"
    )
      return yield* notification(
        yield* decodedNotification(
          decodeCodexNotification(line),
          route.method ?? "unknown_notification",
        ),
      );
    if (route.method === "error") return yield* receiveUpstreamFailure(line);
    if (CODEX_NOTIFICATION_POLICY.state.some((method) => method === route.method))
      return yield* handleState(line, route.method ?? "state_notification");
    // Project only the envelope of unused notifications. Their content and
    // emission timing have no authority over Scotty's turns or credentials.
    yield* decodedNotification(
      decodeCodexNotificationEnvelope(line),
      CODEX_NOTIFICATION_POLICY.discard.some((method) => method === route.method)
        ? (route.method ?? "unknown_notification")
        : "unknown_notification",
    );
    discarded++;
  });
  const framer = makeFramer();
  yield* supervise(transport.writer);
  yield* supervise(
    transport.stdout.pipe(
      Stream.runForEach((chunk) => framer.push(chunk, receive)),
      Effect.andThen(framer.end),
      Effect.andThen(
        Effect.suspend(() =>
          closing ? Effect.void : Effect.fail(new CodexHostError({ code: "transport_failed" })),
        ),
      ),
    ),
  );
  yield* supervise(
    transport.stderr.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderrBytes += chunk.length;
        }),
      ),
    ),
  );
  yield* supervise(
    transport.exit.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          closing ? Effect.void : Effect.fail(new CodexHostError({ code: "unexpected_exit" })),
        ),
      ),
    ),
  );

  yield* Effect.addFinalizer(() => stop);

  const replayBeforeAdmissionReply = Effect.fnUntraced(function* (entry: BeforeAdmissionReply) {
    if (entry.kind === "notification") return yield* notification(entry.message);
    if (entry.kind === "dynamic") return yield* handleDynamicToolCall(entry.request);
    return yield* handleUpstreamFailure(entry.rejection);
  });

  const prompt = Effect.fnUntraced(function* (
    text: string,
    clientUserMessageId?: string,
    images: ReadonlyArray<PiConsoleImage> = [],
  ) {
    if (!ready || closing || !threadId) return yield* new CodexHostError({ code: "not_ready" });
    if (active) return yield* new CodexHostError({ code: "turn_busy" });
    if (transport.options.credential.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* new CodexHostError({ code: "credential_expired" });
    yield* decodePrompt(text).pipe(
      Effect.mapError(() => new CodexHostError({ code: "invalid_message" })),
    );
    const params = {
      threadId,
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
      input: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image" as const,
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
      effort: transport.options.effort,
    } as const;
    yield* decoded(
      decodeCodexClientMessage(JSON.stringify({ id: 0, method: "turn/start", params })),
    );
    const turn: Turn = {
      id: undefined,
      started: false,
      beforeAdmissionReply: [],
      terminal: yield* Deferred.make<Terminal, CodexHostError>(),
    };
    active = turn;
    const turnTimeoutMs = transport.options.turnTimeoutMs;
    const terminal = Deferred.await(turn.terminal);
    yield* supervise(
      turnTimeoutMs === undefined
        ? terminal
        : terminal.pipe(
            Effect.timeoutOrElse({
              duration: turnTimeoutMs,
              orElse: () => Effect.fail(new CodexHostError({ code: "turn_timeout" })),
            }),
          ),
    );
    const result = yield* rpc(
      { method: "turn/start", params },
      decodeCodexTurnStartResponse,
      Effect.fnUntraced(function* (result) {
        if (usedTurns.has(result.turn.id))
          return yield* new CodexHostError({ code: "reused_turn_id" });
        for (const entry of turn.beforeAdmissionReply) {
          const identity = admissionIdentity(entry);
          if (identity.threadId !== threadId || identity.turnId !== result.turn.id)
            return yield* stale(identity.method, identity.threadId, identity.turnId);
        }
        usedTurns.add(result.turn.id);
        turn.id = result.turn.id;
        for (const entry of turn.beforeAdmissionReply) yield* replayBeforeAdmissionReply(entry);
        turn.beforeAdmissionReply.length = 0;
      }),
    );
    return { turnId: result.turn.id, completed: Deferred.await(turn.terminal) };
  });
  const steer = Effect.fnUntraced(function* (
    text: string,
    expectedTurnId: string,
    clientUserMessageId?: string,
    images: ReadonlyArray<PiConsoleImage> = [],
  ) {
    if (!ready || closing || !threadId) return yield* new CodexHostError({ code: "not_ready" });
    const turn = active;
    if (!turn?.id) return yield* new CodexHostError({ code: "no_active_turn" });
    if (turn.id !== expectedTurnId) return yield* new CodexHostError({ code: "turn_mismatch" });
    if (transport.options.credential.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* new CodexHostError({ code: "credential_expired" });
    yield* decodePrompt(text).pipe(
      Effect.mapError(() => new CodexHostError({ code: "invalid_message" })),
    );
    const params = {
      threadId,
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
      input: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image" as const,
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
      expectedTurnId,
    } as const;
    yield* decoded(
      decodeCodexClientMessage(JSON.stringify({ id: 0, method: "turn/steer", params })),
    );
    const result = yield* rpc(
      { method: "turn/steer", params },
      decodeCodexSteerResponse,
      undefined,
      undefined,
      false,
    );
    if (result.turnId !== expectedTurnId)
      return yield* new CodexHostError({ code: "turn_mismatch" });
    return { turnId: result.turnId };
  });
  const interrupt = Effect.suspend(() => {
    const turn = active;
    if (!ready || !turn?.id || !threadId || closing)
      return Effect.fail(new CodexHostError({ code: "no_active_turn" }));
    const params = { threadId, turnId: turn.id };
    return Effect.gen(function* () {
      if (!turn.interruption)
        turn.interruption = yield* Effect.cached(
          rpc({ method: "turn/interrupt", params }, decodeCodexInterruptResponse).pipe(
            Effect.andThen(timed(Deferred.await(turn.terminal))),
            Effect.tapError(fail),
          ),
        );
      return yield* turn.interruption;
    });
  });
  const settings = yield* Effect.gen(function* () {
    // Share one monotonic deadline; neither a new handshake step nor a write resets it.
    // Callback replies still use write's request budget, even before readiness.
    const startupDeadline =
      Number(yield* Clock.monotonicTimeNanos) / 1_000_000 +
      (transport.options.startupTimeoutMs ?? 15000);
    let readinessDeadline = startupDeadline;
    const init = yield* rpc(
      {
        method: "initialize",
        params: {
          clientInfo: { name: "scotty-component", version: "slice-1" },
          capabilities: { experimentalApi: firstPartyTools !== undefined },
        },
      },
      decodeCodexInitializeResponse,
      undefined,
      startupDeadline,
    );
    if (
      init.codexHome !== transport.homes.codexHome ||
      !init.userAgent.startsWith(`scotty-component/${CODEX_VERSION} `) ||
      init.platformFamily !== "unix" ||
      init.platformOs !== transport.platformOs
    )
      return yield* new CodexHostError({ code: "runtime_mismatch" });
    yield* write(
      yield* decoded(decodeCodexClientMessage('{"method":"initialized"}')),
      startupDeadline,
    );
    const ephemeral = transport.options.ephemeral ?? true;
    const resumeThreadId = transport.options.resumeThreadId;
    const settings =
      resumeThreadId === undefined
        ? yield* rpc(
            {
              method: "thread/start",
              params: {
                model: transport.options.model,
                modelProvider: "scotty-managed",
                cwd: transport.homes.cwd,
                approvalPolicy: "never",
                sandbox: "danger-full-access",
                ephemeral,
                ...(firstPartyTools === undefined
                  ? {}
                  : { dynamicTools: codexFirstPartyToolSpecs }),
              },
            },
            decodeCodexThreadStartResponse,
            undefined,
            startupDeadline,
          )
        : yield* rpc(
            {
              method: "thread/resume",
              params: {
                threadId: resumeThreadId,
                excludeTurns: true,
                approvalPolicy: "never",
                sandbox: "danger-full-access",
              },
            },
            decodeCodexThreadResumeResponse,
            undefined,
            startupDeadline,
          );
    if (!matchesThreadSettings(settings, transport, ephemeral, resumeThreadId))
      return yield* new CodexHostError({ code: "settings_mismatch" });
    if (resumeThreadId !== undefined) {
      const readback = yield* rpc(
        {
          method: "thread/read",
          params: { threadId: settings.thread.id, includeTurns: false },
        },
        decodeCodexThreadReadResponse,
        undefined,
        startupDeadline,
      );
      if (!matchesDurableReadback(readback, settings.thread.id))
        return yield* new CodexHostError({ code: "settings_mismatch" });
    }
    // A fresh native thread has no retained Hatch authority to restore.
    if (firstPartyTools !== undefined && resumeThreadId !== undefined) {
      // Hatch restore includes a 30s authority request, up to 300s of configured
      // service readiness, and bounded cleanup. Keep the native RPC handshake at 15s.
      readinessDeadline = Number(yield* Clock.monotonicTimeNanos) / 1_000_000 + 340_000;
      yield* timed(
        Effect.tryPromise({
          try: (signal) => firstPartyTools.restore(signal),
          catch: () => new CodexHostError({ code: "hatch_restore_failed" }),
        }),
        readinessDeadline,
      );
    }
    if (closing || failure) return yield* failure ?? new CodexHostError({ code: "stopped" });
    if (Number(yield* Clock.monotonicTimeNanos) / 1_000_000 >= readinessDeadline)
      return yield* new CodexHostError({ code: "startup_timeout" });
    threadId = settings.thread.id;
    ready = true;
    return settings;
  }).pipe(
    Effect.tapError(fail),
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        const cleanup = yield* stop;
        return yield* new CodexHostError({ code: error.code, cleanup });
      }),
    ),
  );
  return {
    prompt,
    steer,
    interrupt,
    stop,
    closed: Deferred.await(closed),
    inspect: () => ({
      ready,
      threadId,
      activeTurnId: active?.id ?? null,
      failure: failure?.code ?? null,
      failureDiagnostic: failure?.staleDiagnostic ?? failure?.upstreamDiagnostic ?? null,
      turnFailureDiagnostic,
      pid: transport.pid,
      homes: transport.homes,
      settings,
      discarded,
      rejected,
      stderrBytes,
      eventCount,
      ...tools.snapshot(),
    }),
    drainEvents: () => events.splice(0),
    drainLateCommands: () => lateCommandEvents.splice(0),
  };
});

export const startCodexSession = Effect.fnUntraced(function* (
  input: unknown,
  publish?: (event: CodexNotification) => Effect.Effect<void, CodexHostError>,
  restored?: typeof CodexSavedState.Type,
  firstPartyTools?: CodexFirstPartyTools,
  retainEvents = publish === undefined,
) {
  const transport = yield* launchProcess(input, restored).pipe(
    Effect.mapError(
      (error) =>
        new CodexHostError({
          code: error.code,
          cleanup: {
            cleanup: "ambiguous",
            descendants: "unverified",
            parent: "unverified",
            shutdown: "unexpected",
            exit: null,
            failure: error.code,
          },
        }),
    ),
  );
  return yield* makeSession(
    transport,
    publish,
    firstPartyTools ?? makeCodexFirstPartyTools(transport.homes.cwd),
    retainEvents,
  );
});
