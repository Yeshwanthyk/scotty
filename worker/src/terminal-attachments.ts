import { Clock, Context, Data, Effect, Layer, Option, Result, Schema } from "effect";
import {
  type ScottyError,
  conflict,
  TerminalAttachmentLeasesSchema,
  type TerminalAttachmentLease,
} from "./contracts";

// oxlint-disable-next-line scotty/no-storage-key-literal -- storage: TerminalAttachments owns this authoritative Durable Object record
const TERMINAL_ATTACHMENTS_KEY = "scotty:terminal-attachments";
const TERMINAL_ATTACHMENT_ID_PATTERN = /^scotty-web-[0-9a-f]{12}$/u;
const MAX_TERMINAL_ATTACHMENTS = 8;
export const TERMINAL_ATTACHMENT_TTL_MS = 45_000;

const decodeTerminalAttachmentLeases = Schema.decodeUnknownOption(TerminalAttachmentLeasesSchema);

export type TerminalAttachmentReleaseCondition =
  | { readonly kind: "always" }
  | { readonly kind: "observedAt"; readonly value: string }
  | { readonly kind: "staleBefore"; readonly value: string };

type TerminalAttachmentStorageOperation = "clear" | "read" | "transaction";

export class TerminalAttachmentsFailure extends Data.TaggedError("TerminalAttachmentsFailure")<{
  readonly reason: "storage";
  readonly operation: TerminalAttachmentStorageOperation;
  readonly message: string;
}> {}

export interface TerminalAttachmentStorageTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (attachments: ReadonlyArray<TerminalAttachmentLease>) => Promise<void>;
}

export interface TerminalAttachmentStorage {
  readonly get: () => Promise<unknown | undefined>;
  readonly delete: () => Promise<void>;
  readonly transaction: <A>(
    operation: (transaction: TerminalAttachmentStorageTransaction) => Promise<A>,
  ) => Promise<A>;
}

export interface TerminalAttachmentsShape {
  readonly read: Effect.Effect<ReadonlyArray<TerminalAttachmentLease>, TerminalAttachmentsFailure>;
  readonly begin: (
    sessionId: string,
  ) => Effect.Effect<TerminalAttachmentLease, TerminalAttachmentsFailure | ScottyError>;
  readonly activate: (
    sessionId: string,
  ) => Effect.Effect<TerminalAttachmentLease | undefined, TerminalAttachmentsFailure>;
  readonly touch: (
    sessionId: string,
  ) => Effect.Effect<TerminalAttachmentLease | undefined, TerminalAttachmentsFailure>;
  readonly requestRelease: (
    sessionId: string,
    condition?: TerminalAttachmentReleaseCondition,
  ) => Effect.Effect<TerminalAttachmentLease | undefined, TerminalAttachmentsFailure>;
  readonly finalizeRelease: (
    sessionId: string,
    condition?: TerminalAttachmentReleaseCondition,
  ) => Effect.Effect<TerminalAttachmentLease | undefined, TerminalAttachmentsFailure>;
  readonly settleCreate: (
    sessionId: string,
  ) => Effect.Effect<TerminalAttachmentLease | undefined, TerminalAttachmentsFailure>;
  readonly remove: (sessionId: string) => Effect.Effect<void, TerminalAttachmentsFailure>;
  readonly expired: Effect.Effect<
    ReadonlyArray<TerminalAttachmentLease>,
    TerminalAttachmentsFailure
  >;
  readonly clear: Effect.Effect<void, TerminalAttachmentsFailure>;
}

export class TerminalAttachments extends Context.Service<
  TerminalAttachments,
  TerminalAttachmentsShape
>()("scotty/TerminalAttachments") {}

export const durableObjectTerminalAttachmentStorage = (
  storage: DurableObjectStorage,
): TerminalAttachmentStorage => ({
  get: () => storage.get(TERMINAL_ATTACHMENTS_KEY),
  delete: () => storage.delete(TERMINAL_ATTACHMENTS_KEY).then(() => undefined),
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(TERMINAL_ATTACHMENTS_KEY),
        put: (attachments) => transaction.put(TERMINAL_ATTACHMENTS_KEY, attachments),
      }),
    ),
});

export const terminalAttachmentsLayer = (
  storage: TerminalAttachmentStorage,
): Layer.Layer<TerminalAttachments> =>
  Layer.succeed(TerminalAttachments)(makeTerminalAttachments(storage));

export const terminalAttachmentCleanupBestEffort = <E, R>(
  sessionId: string,
  cleanup: Effect.Effect<void, E, R>,
): Effect.Effect<void, never, R> =>
  cleanup.pipe(
    Effect.catchCause(() =>
      Effect.logError("Terminal attachment cleanup failed").pipe(
        Effect.annotateLogs("terminalSessionId", sessionId),
      ),
    ),
  );

const decodeLeases = (stored: unknown): ReadonlyArray<TerminalAttachmentLease> =>
  Option.getOrElse(decodeTerminalAttachmentLeases(stored), () => []).filter((attachment) =>
    isTerminalAttachmentSessionId(attachment.sessionId),
  );

export const isTerminalAttachmentSessionId = (value: string): boolean =>
  TERMINAL_ATTACHMENT_ID_PATTERN.test(value);

const releaseConditionMatches = (
  attachment: TerminalAttachmentLease,
  condition: TerminalAttachmentReleaseCondition,
): boolean => {
  if (condition.kind === "observedAt") return attachment.lastSeenAt === condition.value;
  if (condition.kind === "staleBefore")
    return Date.parse(attachment.lastSeenAt) <= Date.parse(condition.value);
  return true;
};

const makeTerminalAttachments = (storage: TerminalAttachmentStorage): TerminalAttachmentsShape => {
  const storageFailure = (
    operation: TerminalAttachmentStorageOperation,
  ): TerminalAttachmentsFailure =>
    new TerminalAttachmentsFailure({
      reason: "storage",
      operation,
      message: "Terminal attachment storage operation failed",
    });

  const read = Effect.tryPromise({
    try: () => storage.get(),
    catch: () => storageFailure("read"),
  }).pipe(Effect.map(decodeLeases));

  const transact = <A, E>(
    operation: (attachments: ReadonlyArray<TerminalAttachmentLease>) => Result.Result<
      {
        readonly attachments: ReadonlyArray<TerminalAttachmentLease>;
        readonly value: A;
      },
      E
    >,
  ): Effect.Effect<A, TerminalAttachmentsFailure | E> =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const result = operation(decodeLeases(await transaction.get()));
          if (Result.isSuccess(result)) await transaction.put(result.success.attachments);
          return result;
        }),
      catch: () => storageFailure("transaction"),
    }).pipe(
      Effect.flatMap(Effect.fromResult),
      Effect.map((result) => result.value),
    );

  const update = (
    sessionId: string,
    transform: (attachment: TerminalAttachmentLease) => TerminalAttachmentLease | undefined,
  ): Effect.Effect<TerminalAttachmentLease | undefined, TerminalAttachmentsFailure> =>
    transact((attachments) => {
      let updated: TerminalAttachmentLease | undefined;
      const next = attachments.map((attachment) => {
        if (attachment.sessionId !== sessionId) return attachment;
        updated = transform(attachment);
        return updated ?? attachment;
      });
      return Result.succeed({ attachments: next, value: updated });
    });

  return TerminalAttachments.of({
    read,
    begin: Effect.fnUntraced(function* (sessionId) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact((attachments) => {
        if (attachments.some((attachment) => attachment.sessionId === sessionId))
          return Result.fail(conflict("Terminal attachment already exists"));
        if (attachments.length >= MAX_TERMINAL_ATTACHMENTS)
          return Result.fail(conflict("Too many terminal attachments"));
        const lease: TerminalAttachmentLease = {
          sessionId,
          status: "creating",
          lastSeenAt: now,
          createSettled: false,
        };
        return Result.succeed({ attachments: [...attachments, lease], value: lease });
      });
    }),
    activate: (sessionId) =>
      update(sessionId, (attachment) => ({
        ...attachment,
        status: attachment.status === "creating" ? "active" : attachment.status,
        createSettled: true,
      })),
    touch: Effect.fnUntraced(function* (sessionId) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* update(sessionId, (attachment) => ({
        ...attachment,
        lastSeenAt: now,
      }));
    }),
    requestRelease: (sessionId, condition = { kind: "always" }) =>
      update(sessionId, (attachment) =>
        releaseConditionMatches(attachment, condition)
          ? { ...attachment, status: "releasing" }
          : undefined,
      ),
    finalizeRelease: (sessionId, condition = { kind: "always" }) =>
      update(sessionId, (attachment) =>
        attachment.status === "releasing" || releaseConditionMatches(attachment, condition)
          ? { ...attachment, status: "releasing" }
          : undefined,
      ),
    settleCreate: (sessionId) =>
      update(sessionId, (attachment) =>
        attachment.status === "releasing" ? { ...attachment, createSettled: true } : undefined,
      ),
    remove: (sessionId) =>
      transact((attachments) =>
        Result.succeed({
          attachments: attachments.filter((attachment) => attachment.sessionId !== sessionId),
          value: undefined,
        }),
      ),
    expired: Effect.fnUntraced(function* () {
      const cutoff = (yield* Clock.currentTimeMillis) - TERMINAL_ATTACHMENT_TTL_MS;
      const attachments = yield* read;
      return attachments.filter(
        (attachment) =>
          attachment.status !== "releasing" && Date.parse(attachment.lastSeenAt) <= cutoff,
      );
    })(),
    clear: Effect.tryPromise({
      try: () => storage.delete(),
      catch: () => storageFailure("clear"),
    }),
  });
};
