import type { CodexSavedState } from "./persistence-format";
import { createHash } from "node:crypto";
import { Clock, Deferred, Effect, Fiber, Predicate, Result, Schema, Scope, Stream } from "effect";
import {
  CODEX_VERSION,
  CODEX_MAX_TEXT_BYTES,
  decodeCodexClientMessage,
  decodeCodexInitializeResponse,
  decodeCodexThreadReadResponse,
  decodeCodexThreadResumeResponse,
  decodeCodexThreadStartResponse,
  decodeCodexTurnStartResponse,
  decodeCodexSteerResponse,
  decodeCodexInterruptResponse,
  decodeCodexNotification,
  decodeCodexDynamicToolCall,
  rejectCodexServerRequest,
  type CodexClientMessage,
  type CodexDynamicToolResponse,
  type CodexNotification,
  type CodexThreadReadResult,
  type CodexThreadSettings,
  type CodexUnsupportedResponse,
} from "../../../../protocol/codex-app-server";
import { CodexHostError, type Cleanup } from "./errors";
import { makeCodexTools } from "./tools";
import {
  codexFirstPartyToolSpecs,
  makeCodexFirstPartyTools,
  type CodexFirstPartyToolName,
  type CodexFirstPartyTools,
} from "./first-party-tools";
import { limits, makeFramer } from "./framing";
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
  readonly terminal: Deferred.Deferred<Terminal, CodexHostError>;
  interruption?: Effect.Effect<Terminal, CodexHostError>;
};
const decodePrompt = Schema.decodeUnknownEffect(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CODEX_MAX_TEXT_BYTES)),
);
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
          message: Schema.String.check(Schema.isMaxLength(4096)),
          codexErrorInfo: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
        }),
      }),
    }),
  ),
);
// Pinned v0.153.4 CodexErrorInfo variants; do not inspect or publish error.message.
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
const upstreamDiagnostic = (info: unknown): string => {
  const category = decodeUpstreamErrorCategory(info);
  if (Result.isSuccess(category)) return category.success;
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
const AdvisoryIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const AdvisoryThread = Schema.Struct({
  threadId: AdvisoryIdentifier,
  turnId: AdvisoryIdentifier,
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
const AdvisoryTimestamp = Schema.optionalKey(
  Schema.Int.check(
    Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ),
);
const ScopedAdvisoryMethod = Schema.Literals([
  "turn/diff/updated",
  "turn/plan/updated",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/terminalInteraction",
]);
const Advisory = Schema.Union([
  Schema.Struct({
    method: Schema.Literals([
      "remoteControl/status/changed",
      "configWarning",
      "thread/started",
      "thread/status/changed",
      "item/started",
      "item/completed",
      "thread/tokenUsage/updated",
      "account/rateLimits/updated",
      "item/commandExecution/outputDelta",
    ]),
    params: Schema.JsonObject,
    emittedAtMs: AdvisoryTimestamp,
  }),
  Schema.Struct({
    method: ScopedAdvisoryMethod,
    params: AdvisoryThread,
    emittedAtMs: AdvisoryTimestamp,
  }),
]);
type AdvisoryMessage = typeof Advisory.Type;
type ScopedAdvisory = Extract<AdvisoryMessage, { method: typeof ScopedAdvisoryMethod.Type }>;
const isScopedAdvisoryMethod = Schema.is(ScopedAdvisoryMethod);
const isScopedAdvisory = (advisory: AdvisoryMessage): advisory is ScopedAdvisory =>
  isScopedAdvisoryMethod(advisory.method);
const decodeGoalCleared = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.Literal("thread/goal/cleared"),
      params: Schema.Struct({ threadId: AdvisoryIdentifier }),
      emittedAtMs: AdvisoryTimestamp,
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeAdvisory = Schema.decodeUnknownEffect(Schema.fromJsonString(Advisory), {
  onExcessProperty: "error",
});
const decoded = <A>(result: Result.Result<A, "invalid_message" | "message_too_large">) =>
  Result.match(result, {
    onSuccess: Effect.succeed,
    onFailure: (code) => Effect.fail(new CodexHostError({ code })),
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
  publish: (event: CodexNotification) => Effect.Effect<void, CodexHostError> = () => Effect.void,
  firstPartyTools?: CodexFirstPartyTools,
) {
  const scope = yield* Scope.Scope;
  const failed = yield* Deferred.make<never, CodexHostError>();
  const closed = yield* Deferred.make<Cleanup>();
  const pending = new Map<number, Pending>();
  const usedTurns = new Set<string>();
  const events: Array<CodexNotification> = [];
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
    source:
      | CodexNotification["method"]
      | typeof ScopedAdvisoryMethod.Type
      | "error"
      | "thread/goal/cleared",
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
    inputBytes = 0,
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
    inputBytes += bytes.length;
    if (inputBytes > limits.input) return yield* new CodexHostError({ code: "input_budget" });
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
      "invalid_message" | "message_too_large"
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
  const notification = Effect.fnUntraced(function* (message: CodexNotification) {
    const id = Predicate.hasProperty(message.params, "turnId")
      ? message.params.turnId
      : message.params.turn.id;
    if (isTrailingChildActivity(message)) {
      discarded++;
      return;
    }
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
      startedDynamicTools.clear();
      toolReceipts.clear();
    } else if (!turn.started) return yield* new CodexHostError({ code: "turn_not_started" });
    recordDynamicItem(message);
    const childThreadId = activityChildThreadId(message);
    if (childThreadId !== undefined && childThreadId !== threadId) {
      const owners = childTurnOwners.get(childThreadId) ?? new Set<string>();
      owners.add(id);
      childTurnOwners.set(childThreadId, owners);
    }
    tools.accept(message);
    events.push(message);
    yield* publish(message);
    if (closing || failure || active !== turn) return;
    if (message.method === "turn/completed") {
      completedTurns.add(id);
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
    }
  });
  const toolResult = (text: string, success: boolean): CodexDynamicToolResponse["result"] => ({
    contentItems: [
      {
        type: "inputText",
        text:
          new TextEncoder().encode(text).byteLength <= 1200
            ? text
            : "Tool result exceeded the safe output limit.",
      },
    ],
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
  const handleDynamicToolCall = Effect.fnUntraced(function* (line: string) {
    const decodedCall = decodeCodexDynamicToolCall(line);
    if (Result.isFailure(decodedCall)) {
      yield* write(yield* decoded(rejectCodexServerRequest(line)));
      rejected++;
      return;
    }
    const request = decodedCall.success;
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
    if (previous === undefined && toolReceipts.size >= 64) {
      yield* write({ id: request.id, result: toolResult("Tool call budget reached.", false) });
      rejected++;
      return;
    }
    const result = previous?.result ?? (yield* Deferred.make<CodexDynamicToolResponse["result"]>());
    if (previous === undefined) {
      toolReceipts.set(params.callId, { turnId: params.turnId, tool, argumentsHash, result });
      const execution = Effect.tryPromise({
        try: (signal) => firstPartyTools.execute(tool, params.arguments, signal),
        catch: () => new CodexHostError({ code: "tool_execution_failed" }),
      }).pipe(
        Effect.map((value) => toolResult(value.text, value.success)),
        Effect.catch(() =>
          Effect.succeed(toolResult("Tool outcome unknown; do not repeat this call.", false)),
        ),
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
  const handleUpstreamFailure = Effect.fnUntraced(function* (line: string) {
    const rejection = yield* decodeUpstreamFailure(line).pipe(
      Effect.mapError(() => new CodexHostError({ code: "unsupported_notification" })),
    );
    if (!active || rejection.params.threadId !== threadId || rejection.params.turnId !== active.id)
      return yield* stale("error", rejection.params.threadId, rejection.params.turnId);
    if (rejection.params.willRetry) {
      discarded++;
      return;
    }
    return yield* new CodexHostError({
      code: "upstream_failed",
      upstreamDiagnostic: upstreamDiagnostic(rejection.params.error.codexErrorInfo),
    });
  });
  const handleAdvisory = Effect.fnUntraced(function* (line: string) {
    const advisory = yield* decodeAdvisory(line).pipe(
      Effect.mapError(() => new CodexHostError({ code: "unsupported_notification" })),
    );
    if (
      isScopedAdvisory(advisory) &&
      (!active || advisory.params.threadId !== threadId || advisory.params.turnId !== active.id)
    )
      return yield* stale(advisory.method, advisory.params.threadId, advisory.params.turnId);
    discarded++;
  });
  const receive = Effect.fnUntraced(function* (line: string) {
    if (closing) return;
    if (++eventCount > limits.events) return yield* new CodexHostError({ code: "event_budget" });
    const route = yield* decodeRoute(line).pipe(
      Effect.mapError(() => new CodexHostError({ code: "invalid_message" })),
    );
    if (route.id !== undefined) {
      if (route.method !== undefined) {
        if (route.method === "item/tool/call" && firstPartyTools !== undefined)
          return yield* handleDynamicToolCall(line);
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
      route.method === "turn/started" ||
      route.method === "turn/completed" ||
      route.method === "item/agentMessage/delta" ||
      route.method === "item/started" ||
      route.method === "item/completed" ||
      route.method === "item/commandExecution/outputDelta"
    )
      return yield* notification(yield* decoded(decodeCodexNotification(line)));
    if (route.method === "thread/goal/cleared") {
      const event = yield* decodeGoalCleared(line).pipe(
        Effect.mapError(() => new CodexHostError({ code: "invalid_message" })),
      );
      if (event.params.threadId !== (threadId ?? transport.options.resumeThreadId))
        return yield* stale("thread/goal/cleared", event.params.threadId);
      discarded++;
      return;
    }
    if (route.method === "error") return yield* handleUpstreamFailure(line);
    return yield* handleAdvisory(line);
  });
  const framer = makeFramer(limits.output);
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
        Effect.suspend(() => {
          stderrBytes += chunk.length;
          return stderrBytes > limits.stderr
            ? Effect.fail(new CodexHostError({ code: "stderr_budget" }))
            : Effect.void;
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

  const prompt = Effect.fnUntraced(function* (text: string, clientUserMessageId?: string) {
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
      input: [{ type: "text", text }],
      effort: transport.options.effort,
    } as const;
    yield* decoded(
      decodeCodexClientMessage(JSON.stringify({ id: 0, method: "turn/start", params })),
    );
    const turn: Turn = {
      id: undefined,
      started: false,
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
        usedTurns.add(result.turn.id);
        turn.id = result.turn.id;
      }),
    );
    return { turnId: result.turn.id, completed: Deferred.await(turn.terminal) };
  });
  const steer = Effect.fnUntraced(function* (
    text: string,
    expectedTurnId: string,
    clientUserMessageId?: string,
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
      input: [{ type: "text", text }],
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
    if (firstPartyTools !== undefined)
      yield* timed(
        Effect.tryPromise({
          try: (signal) => firstPartyTools.restore(signal),
          catch: () => new CodexHostError({ code: "hatch_restore_failed" }),
        }),
        startupDeadline,
      );
    if (closing || failure) return yield* failure ?? new CodexHostError({ code: "stopped" });
    if (Number(yield* Clock.monotonicTimeNanos) / 1_000_000 >= startupDeadline)
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
  };
});

export const startCodexSession = Effect.fnUntraced(function* (
  input: unknown,
  publish?: (event: CodexNotification) => Effect.Effect<void, CodexHostError>,
  restored?: typeof CodexSavedState.Type,
  firstPartyTools?: CodexFirstPartyTools,
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
  );
});
