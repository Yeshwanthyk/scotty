import { Deferred, Effect, Option, Predicate, Result, Schema } from "effect";
import {
  RunnerHelloSchema,
  RunnerOperationSchema,
  RunnerReplySchema,
  encodeRunnerOperation,
  encodeRunnerRequest,
  type RunnerOperation,
  type RunnerProbeAck,
  type RunnerResponse,
} from "../../protocol/runner.ts";

const MAX_RUNNER_MESSAGE_CHARACTERS = 256 * 1024;
const DEFAULT_DISPATCH_TIMEOUT_MILLIS = 30_000;
const MAX_DISPATCH_TIMEOUT_MILLIS = 5 * 60_000;
const DEFAULT_STATUS_TIMEOUT_MILLIS = 1_000;
const MAX_STATUS_TIMEOUT_MILLIS = 5_000;

const RunnerAttachmentSchema = Schema.Struct({
  version: Schema.Literal(1),
  runner: Schema.NonEmptyString,
  connectionId: Schema.NonEmptyString,
  ready: Schema.Boolean,
});
type RunnerAttachment = typeof RunnerAttachmentSchema.Type;

const decodeAttachment = Schema.decodeUnknownOption(RunnerAttachmentSchema, {
  onExcessProperty: "error",
});
const decodeOperation = Schema.decodeUnknownEffect(RunnerOperationSchema, {
  onExcessProperty: "error",
});
const decodeHelloText = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerHelloSchema), {
  onExcessProperty: "error",
});
const decodeReplyText = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerReplySchema), {
  onExcessProperty: "error",
});

export interface RunnerSocket {
  readonly send: (data: string | Uint8Array) => Effect.Effect<void, unknown>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
  readonly serializeAttachment: <T>(value: T) => void;
  readonly deserializeAttachment: <T>() => T | null;
}

export type RunnerDispatchFailureCode =
  | "invalid_operation"
  | "runner_disconnected"
  | "runner_timeout"
  | "runner_unavailable";

export type RunnerDispatchResult =
  | { readonly ok: true; readonly response: RunnerResponse }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: RunnerDispatchFailureCode;
        readonly message: string;
      };
    };

interface PendingDispatch {
  readonly connectionId: string;
  readonly encodedOperation: string;
  readonly sessionId: string;
  readonly deferred: Deferred.Deferred<RunnerDispatchResult>;
  waiters: number;
}

interface PendingProbe {
  readonly connectionId: string;
  readonly deferred: Deferred.Deferred<boolean>;
}

const failure = (code: RunnerDispatchFailureCode, message: string): RunnerDispatchResult => ({
  ok: false,
  error: { code, message },
});

const attachmentOf = (socket: RunnerSocket): Option.Option<RunnerAttachment> =>
  decodeAttachment(socket.deserializeAttachment<unknown>());

export class RunnerTransport {
  readonly #pending = new Map<string, PendingDispatch>();
  readonly #probes = new Map<string, PendingProbe>();
  readonly #sockets = new Set<RunnerSocket>();
  readonly runnerName: string;

  constructor(runnerName: string, sockets: ReadonlyArray<RunnerSocket> = []) {
    this.runnerName = runnerName;
    for (const socket of sockets) {
      const attachment = attachmentOf(socket);
      if (Option.isSome(attachment) && attachment.value.runner === runnerName)
        this.#sockets.add(socket);
    }
  }

  accept(socket: RunnerSocket): void {
    socket.serializeAttachment<RunnerAttachment>({
      version: 1,
      runner: this.runnerName,
      connectionId: crypto.randomUUID(),
      ready: false,
    });
    this.#sockets.add(socket);
  }

  status(
    timeoutMillis = DEFAULT_STATUS_TIMEOUT_MILLIS,
  ): Effect.Effect<"connected" | "disconnected"> {
    return Effect.gen({ self: this }, function* () {
      const active = this.#activeSocket();
      if (Option.isNone(active)) return "disconnected";

      const probeId = crypto.randomUUID();
      const deferred = yield* Deferred.make<boolean>();
      const pending: PendingProbe = {
        connectionId: active.value.attachment.connectionId,
        deferred,
      };
      this.#probes.set(probeId, pending);

      return yield* Effect.gen({ self: this }, function* () {
        const sent = yield* Effect.result(
          active.value.socket
            .send(
              encodeRunnerRequest({
                _tag: "RunnerProbe",
                version: 1,
                probeId,
              }),
            )
            .pipe(Effect.sandbox),
        );
        if (Result.isFailure(sent)) {
          yield* this.#disconnectSocket(
            active.value.socket,
            active.value.attachment,
            1011,
            "Runner probe failed",
          );
          return "disconnected";
        }

        const acknowledged = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(normalizedStatusTimeout(timeoutMillis)),
        );
        if (Option.isSome(acknowledged)) return acknowledged.value ? "connected" : "disconnected";

        yield* this.#disconnectSocket(
          active.value.socket,
          active.value.attachment,
          1011,
          "Runner probe timed out",
        );
        return "disconnected";
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#probes.get(probeId) === pending) this.#probes.delete(probeId);
          }),
        ),
      );
    });
  }

  dispatch(
    input: unknown,
    timeoutMillis = DEFAULT_DISPATCH_TIMEOUT_MILLIS,
  ): Effect.Effect<RunnerDispatchResult> {
    return Effect.gen({ self: this }, function* () {
      const decoded = yield* Effect.result(decodeOperation(input));
      if (Result.isFailure(decoded))
        return failure("invalid_operation", "Runner operation is invalid");
      const operation = decoded.success;
      const encodedOperation = encodeRunnerOperation(operation);
      if (encodedOperation.length > MAX_RUNNER_MESSAGE_CHARACTERS)
        return failure("invalid_operation", "Runner operation is too large");

      const pendingKey = operationKey(operation.sessionId, operation.operationId);
      const existing = this.#pending.get(pendingKey);
      if (existing !== undefined) {
        if (
          existing.encodedOperation !== encodedOperation ||
          existing.sessionId !== operation.sessionId
        )
          return failure("invalid_operation", "Runner operation ID is already in use");
        return yield* this.#awaitPending(pendingKey, existing, normalizedTimeout(timeoutMillis));
      }

      const active = this.#activeSocket();
      if (Option.isNone(active)) return failure("runner_unavailable", "Runner is not connected");
      const deferred = yield* Deferred.make<RunnerDispatchResult>();
      const pending: PendingDispatch = {
        connectionId: active.value.attachment.connectionId,
        encodedOperation,
        sessionId: operation.sessionId,
        deferred,
        waiters: 0,
      };
      this.#pending.set(pendingKey, pending);
      const sent = yield* Effect.result(
        active.value.socket.send(encodedOperation).pipe(Effect.sandbox),
      );
      if (Result.isFailure(sent)) {
        yield* this.#disconnectSocket(
          active.value.socket,
          active.value.attachment,
          1011,
          "Runner send failed",
        );
      }
      return yield* this.#awaitPending(pendingKey, pending, normalizedTimeout(timeoutMillis));
    });
  }

  message(socket: RunnerSocket, message: string | ArrayBuffer): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const attachment = attachmentOf(socket);
      if (Option.isNone(attachment) || attachment.value.runner !== this.runnerName) {
        yield* this.#reject(socket, "Invalid runner connection");
        return;
      }
      if (typeof message !== "string" || message.length > MAX_RUNNER_MESSAGE_CHARACTERS) {
        yield* this.#reject(socket, "Invalid runner message");
        return;
      }

      if (!attachment.value.ready) {
        const decoded = yield* Effect.result(decodeHelloText(message));
        if (Result.isFailure(decoded) || decoded.success.runner !== this.runnerName) {
          yield* this.#reject(socket, "Runner identity mismatch");
          return;
        }
        yield* this.#activate(socket, attachment.value);
        return;
      }

      const decoded = yield* Effect.result(decodeReplyText(message));
      if (Result.isFailure(decoded)) {
        yield* this.#reject(socket, "Invalid runner response");
        return;
      }
      if (Predicate.isTagged("RunnerProbeAck")(decoded.success)) {
        yield* this.#completeProbe(socket, attachment.value, decoded.success);
        return;
      }
      yield* this.#complete(socket, attachment.value, decoded.success);
    });
  }

  close(socket: RunnerSocket): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const attachment = attachmentOf(socket);
      this.#sockets.delete(socket);
      if (Option.isSome(attachment)) yield* this.#failConnection(attachment.value.connectionId);
    });
  }

  #activeSocket(): Option.Option<{
    readonly socket: RunnerSocket;
    readonly attachment: RunnerAttachment;
  }> {
    for (const socket of this.#sockets) {
      const attachment = attachmentOf(socket);
      if (
        Option.isSome(attachment) &&
        attachment.value.runner === this.runnerName &&
        attachment.value.ready
      )
        return Option.some({ socket, attachment: attachment.value });
    }
    return Option.none();
  }

  #activate(socket: RunnerSocket, attachment: RunnerAttachment): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const peer of this.#sockets) {
        if (peer === socket) continue;
        const peerAttachment = attachmentOf(peer);
        if (Option.isSome(peerAttachment) && peerAttachment.value.ready) {
          this.#sockets.delete(peer);
          yield* this.#failConnection(peerAttachment.value.connectionId);
          yield* peer.close(1012, "Runner connection replaced").pipe(Effect.sandbox, Effect.ignore);
        }
      }
      socket.serializeAttachment<RunnerAttachment>({
        ...attachment,
        ready: true,
      });
    });
  }

  #complete(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    response: RunnerResponse,
  ): Effect.Effect<void> {
    const pendingKey = operationKey(response.sessionId, response.operationId);
    const pending = this.#pending.get(pendingKey);
    if (pending === undefined) return Effect.void;
    if (
      pending.connectionId !== attachment.connectionId ||
      pending.sessionId !== response.sessionId
    )
      return this.#reject(socket, "Runner response identity mismatch");
    this.#pending.delete(pendingKey);
    return Deferred.succeed(pending.deferred, { ok: true, response }).pipe(Effect.asVoid);
  }

  #completeProbe(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    response: RunnerProbeAck,
  ): Effect.Effect<void> {
    const pending = this.#probes.get(response.probeId);
    if (pending === undefined) return Effect.void;
    if (pending.connectionId !== attachment.connectionId)
      return this.#reject(socket, "Runner probe identity mismatch");
    this.#probes.delete(response.probeId);
    return Deferred.succeed(pending.deferred, true).pipe(Effect.asVoid);
  }

  #reject(socket: RunnerSocket, reason: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const attachment = attachmentOf(socket);
      if (Option.isSome(attachment))
        yield* this.#disconnectSocket(socket, attachment.value, 1008, reason);
      else {
        this.#sockets.delete(socket);
        yield* socket.close(1008, reason).pipe(Effect.sandbox, Effect.ignore);
      }
    });
  }

  #disconnectSocket(
    socket: RunnerSocket,
    attachment: RunnerAttachment,
    code: number,
    reason: string,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.#sockets.delete(socket);
      yield* this.#failConnection(attachment.connectionId);
      yield* socket.close(code, reason).pipe(Effect.sandbox, Effect.ignore);
    });
  }

  #failConnection(connectionId: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const [operationId, pending] of this.#pending) {
        if (pending.connectionId !== connectionId) continue;
        this.#pending.delete(operationId);
        yield* Deferred.succeed(
          pending.deferred,
          failure("runner_disconnected", "Runner disconnected before replying"),
        );
      }
      for (const [probeId, pending] of this.#probes) {
        if (pending.connectionId !== connectionId) continue;
        this.#probes.delete(probeId);
        yield* Deferred.succeed(pending.deferred, false);
      }
    });
  }

  #awaitPending(
    operationId: string,
    pending: PendingDispatch,
    timeoutMillis: number,
  ): Effect.Effect<RunnerDispatchResult> {
    pending.waiters += 1;
    return Effect.gen(function* () {
      const result = yield* Deferred.await(pending.deferred).pipe(
        Effect.timeoutOption(timeoutMillis),
      );
      return Option.isSome(result)
        ? result.value
        : failure("runner_timeout", "Runner did not reply before the timeout");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pending.waiters -= 1;
          if (pending.waiters === 0 && this.#pending.get(operationId) === pending)
            this.#pending.delete(operationId);
        }),
      ),
    );
  }
}

function normalizedTimeout(timeoutMillis: number): number {
  if (!Number.isFinite(timeoutMillis)) return DEFAULT_DISPATCH_TIMEOUT_MILLIS;
  return Math.min(MAX_DISPATCH_TIMEOUT_MILLIS, Math.max(1, Math.floor(timeoutMillis)));
}

function normalizedStatusTimeout(timeoutMillis: number): number {
  if (!Number.isFinite(timeoutMillis)) return DEFAULT_STATUS_TIMEOUT_MILLIS;
  return Math.min(MAX_STATUS_TIMEOUT_MILLIS, Math.max(1, Math.floor(timeoutMillis)));
}

const operationKey = (sessionId: string, operationId: string): string =>
  `${sessionId}\u0000${operationId}`;

export type { RunnerOperation };
