import { Clock, Deferred, Effect, Predicate, Result, Schema, Scope, Stream } from "effect";
import {
  CODEX_VERSION,
  CODEX_MAX_TEXT_BYTES,
  decodeCodexClientMessage,
  decodeCodexInitializeResponse,
  decodeCodexThreadStartResponse,
  decodeCodexTurnStartResponse,
  decodeCodexSteerResponse,
  decodeCodexInterruptResponse,
  decodeCodexNotification,
  rejectCodexServerRequest,
  type CodexClientMessage,
  type CodexNotification,
  type CodexUnsupportedResponse,
} from "../../../../protocol/codex-app-server";
import { CodexHostError, type Cleanup } from "./errors";
import { makeCodexTools } from "./tools";
import { limits, makeFramer } from "./framing";
import { launchProcess, type CodexProcess } from "./process";

type Terminal = Extract<CodexNotification, { method: "turn/completed" }>["params"]["turn"];
type Request = Exclude<CodexClientMessage, { method: "initialized" }>;
type Pending = {
  readonly fatal: boolean;
  readonly receive: (line: string) => Effect.Effect<void, CodexHostError>;
  readonly fail: (error: CodexHostError) => Effect.Effect<unknown>;
};
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
// Native 0.153.4 can label HTTP 401 as "other"; never classify auth from remote prose.
const decodeUpstreamFailure = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.Literal("error"),
      params: Schema.Struct({
        threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        turnId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        willRetry: Schema.Literal(false),
        error: Schema.Struct({ message: Schema.String.check(Schema.isMaxLength(4096)) }),
      }),
    }),
  ),
);
const Advisory = Schema.Struct({
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
  emittedAtMs: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
});
const decodeAdvisory = Schema.decodeUnknownEffect(Schema.fromJsonString(Advisory), {
  onExcessProperty: "error",
});
const decoded = <A>(result: Result.Result<A, "invalid_message" | "message_too_large">) =>
  Result.match(result, {
    onSuccess: Effect.succeed,
    onFailure: (code) => Effect.fail(new CodexHostError({ code })),
  });

// Each factory invocation is one process generation. No durable Session state is owned here.
export const makeSession = Effect.fnUntraced(function* (
  transport: CodexProcess,
  publish: (event: CodexNotification) => Effect.Effect<void, CodexHostError> = () => Effect.void,
) {
  const scope = yield* Scope.Scope;
  const failed = yield* Deferred.make<never, CodexHostError>();
  const closed = yield* Deferred.make<Cleanup>();
  const pending = new Map<number, Pending>();
  const usedTurns = new Set<string>();
  const events: Array<CodexNotification> = [];
  const tools = makeCodexTools();
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
      const stopped = failure ?? new CodexHostError({ code: "stopped" });
      for (const entry of pending.values()) yield* entry.fail(stopped);
      pending.clear();
      if (active) yield* Deferred.fail(active.terminal, stopped);
      active = undefined;
      const receipt = { ...(yield* transport.stop), failure: failure?.code ?? null };
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
    message: CodexClientMessage | CodexUnsupportedResponse,
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
  const notification = Effect.fnUntraced(function* (message: CodexNotification) {
    const id = Predicate.hasProperty(message.params, "turnId")
      ? message.params.turnId
      : message.params.turn.id;
    if (!active || message.params.threadId !== threadId || id !== active.id)
      return yield* new CodexHostError({ code: "stale_notification" });
    const turn = active;
    if (message.method === "turn/started") {
      if (turn.started) return yield* new CodexHostError({ code: "duplicate_turn_started" });
      turn.started = true;
    } else if (!turn.started) return yield* new CodexHostError({ code: "turn_not_started" });
    tools.accept(message);
    events.push(message);
    yield* publish(message);
    if (closing || failure || active !== turn) return;
    if (message.method === "turn/completed") {
      yield* Deferred.succeed(turn.terminal, message.params.turn);
      if (active === turn) active = undefined;
    }
  });
  const receive = Effect.fnUntraced(function* (line: string) {
    if (closing) return;
    if (++eventCount > limits.events) return yield* new CodexHostError({ code: "event_budget" });
    const route = yield* decodeRoute(line).pipe(
      Effect.mapError(() => new CodexHostError({ code: "invalid_message" })),
    );
    if (route.id !== undefined) {
      if (route.method !== undefined) {
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
    if (
      route.method === "turn/started" ||
      route.method === "turn/completed" ||
      route.method === "item/agentMessage/delta" ||
      route.method === "item/started" ||
      route.method === "item/completed" ||
      route.method === "item/commandExecution/outputDelta"
    )
      return yield* notification(yield* decoded(decodeCodexNotification(line)));
    if (route.method === "error") {
      const rejection = yield* decodeUpstreamFailure(line).pipe(
        Effect.mapError(() => new CodexHostError({ code: "unsupported_notification" })),
      );
      if (
        !active ||
        rejection.params.threadId !== threadId ||
        rejection.params.turnId !== active.id
      )
        return yield* new CodexHostError({ code: "stale_notification" });
      return yield* new CodexHostError({ code: "upstream_failed" });
    }
    yield* decodeAdvisory(line).pipe(
      Effect.mapError(() => new CodexHostError({ code: "unsupported_notification" })),
    );
    discarded++;
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
    yield* supervise(
      Deferred.await(turn.terminal).pipe(
        Effect.timeoutOrElse({
          duration: transport.options.turnTimeoutMs,
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
            Effect.andThen(Deferred.await(turn.terminal)),
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
          capabilities: { experimentalApi: false },
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
    const settings = yield* rpc(
      {
        method: "thread/start",
        params: {
          model: transport.options.model,
          modelProvider: "scotty-managed",
          cwd: transport.homes.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
        },
      },
      decodeCodexThreadStartResponse,
      undefined,
      startupDeadline,
    );
    if (
      settings.model !== transport.options.model ||
      settings.modelProvider !== "scotty-managed" ||
      settings.cwd !== transport.homes.cwd ||
      settings.reasoningEffort !== transport.options.effort
    )
      return yield* new CodexHostError({ code: "settings_mismatch" });
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
) {
  const transport = yield* launchProcess(input).pipe(
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
  return yield* makeSession(transport, publish);
});
