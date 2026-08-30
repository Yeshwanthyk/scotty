import { createHash } from "node:crypto";
import { Effect, FileSystem, Option, Path, PlatformError, Predicate, Result, Schema } from "effect";
import {
  encodeRunnerOperation,
  type RunnerOperation,
  type RunnerResponse,
  RunnerResponseSchema,
} from "../../protocol/runner";

const RECEIPT_DIRECTORY_MODE = 0o700;
const RECEIPT_FILE_MODE = 0o600;

const ReceiptIdentityFields = {
  operationId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
};

const StartedReceiptSchema = Schema.Struct({
  ...ReceiptIdentityFields,
  status: Schema.Literal("started"),
  intentSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
type StartedReceipt = typeof StartedReceiptSchema.Type;

const CompletedReceiptSchema = Schema.Struct({
  ...ReceiptIdentityFields,
  status: Schema.Literal("completed"),
  intentSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  response: RunnerResponseSchema,
});
type CompletedReceipt = typeof CompletedReceiptSchema.Type;

const RecoveryFenceSchema = Schema.Struct({
  ...ReceiptIdentityFields,
  status: Schema.Literal("recovery_required"),
  intentSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
type RecoveryFence = typeof RecoveryFenceSchema.Type;
type RecoveryFenceState =
  | { readonly _tag: "NoRecoveryFence" }
  | { readonly _tag: "CorruptRecoveryFence" }
  | { readonly _tag: "ActiveRecoveryFence"; readonly fence: RecoveryFence };

const decodeStartedReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StartedReceiptSchema),
  { onExcessProperty: "error" },
);
const decodeCompletedReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CompletedReceiptSchema),
  { onExcessProperty: "error" },
);
const decodeRecoveryFence = Schema.decodeUnknownEffect(Schema.fromJsonString(RecoveryFenceSchema), {
  onExcessProperty: "error",
});
const encodeStartedReceipt = Schema.encodeSync(Schema.fromJsonString(StartedReceiptSchema));
const encodeCompletedReceipt = Schema.encodeSync(Schema.fromJsonString(CompletedReceiptSchema));
const encodeRecoveryFence = Schema.encodeSync(Schema.fromJsonString(RecoveryFenceSchema));

export type RunnerOperationPreparation =
  | { readonly _tag: "ExecuteOperation" }
  | { readonly _tag: "ReplayOperation"; readonly response: RunnerResponse }
  | { readonly _tag: "OperationConflict" }
  | { readonly _tag: "OperationUnknown" }
  | { readonly _tag: "RecoveryRequired" };

interface RunnerOperationJournalShape {
  readonly prepare: (
    operation: RunnerOperation,
  ) => Effect.Effect<RunnerOperationPreparation, PlatformError.PlatformError>;
  readonly complete: (
    operation: RunnerOperation,
    response: RunnerResponse,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly clearRecoveryFence: (
    sessionId: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Makes the durable receipt journal for one runner root.
 *
 * Exactly one live journal writer may own a root. The runner command satisfies
 * that contract by constructing one runtime for its process.
 */
export const makeRunnerOperationJournal = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const receiptsRoot = path.join(path.resolve(root), "receipts");
  const recoveryRoot = path.join(path.resolve(root), "recovery");

  const coordinates = (identity: { readonly operationId: string; readonly sessionId: string }) => {
    const sessionDirectory = path.join(receiptsRoot, `session-${sha256(identity.sessionId)}`);
    const operationDirectory = path.join(
      sessionDirectory,
      `operation-${sha256(identity.operationId)}`,
    );
    return {
      sessionDirectory,
      operationDirectory,
      startedPath: path.join(operationDirectory, "started.json"),
      completedPath: path.join(operationDirectory, "completed.json"),
    };
  };

  const recoveryCoordinates = (sessionId: string) => {
    const sessionDirectory = path.join(recoveryRoot, `session-${sha256(sessionId)}`);
    return {
      sessionDirectory,
      fencePath: path.join(sessionDirectory, "recovery-required.json"),
    };
  };

  const syncDirectory = (directory: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(directory, { flag: "r" });
        yield* handle.sync;
      }),
    );

  const ensurePrivateDirectory = Effect.fnUntraced(function* (directory: string) {
    const exists = yield* fs.exists(directory);
    if (!exists) {
      yield* fs.makeDirectory(directory, {
        recursive: true,
        mode: RECEIPT_DIRECTORY_MODE,
      });
    }
    yield* fs.chmod(directory, RECEIPT_DIRECTORY_MODE);
    if (!exists) {
      yield* syncDirectory(path.dirname(directory));
    }
  });

  const ensureRootDirectory = Effect.fnUntraced(function* () {
    const exists = yield* fs.exists(root);
    if (exists) return;
    yield* fs.makeDirectory(root, {
      recursive: true,
      mode: RECEIPT_DIRECTORY_MODE,
    });
    yield* syncDirectory(path.dirname(root));
  });

  const writeAtomic = Effect.fnUntraced(function* (
    target: string,
    contents: string,
    parent: string,
  ) {
    const temporary = `${target}.tmp`;
    yield* fs.remove(temporary, { force: true });
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(temporary, {
            flag: "wx",
            mode: RECEIPT_FILE_MODE,
          });
          yield* handle.writeAll(new TextEncoder().encode(contents));
          yield* handle.sync;
        }),
      );
      yield* fs.rename(temporary, target);
    }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))));
    yield* syncDirectory(parent);
  });

  const ensureJournalDirectories = Effect.fnUntraced(function* (
    sessionDirectory: string,
    operationDirectory: string,
  ) {
    yield* ensureRootDirectory();
    yield* ensurePrivateDirectory(receiptsRoot);
    yield* ensurePrivateDirectory(sessionDirectory);
    yield* ensurePrivateDirectory(operationDirectory);
  });

  const ensureRecoveryDirectory = Effect.fnUntraced(function* (sessionDirectory: string) {
    yield* ensureRootDirectory();
    yield* ensurePrivateDirectory(recoveryRoot);
    yield* ensurePrivateDirectory(sessionDirectory);
  });

  const readStarted = Effect.fnUntraced(function* (startedPath: string) {
    const text = yield* fs.readFileString(startedPath);
    const decoded = yield* Effect.result(decodeStartedReceipt(text));
    return Result.match(decoded, {
      onFailure: () => Option.none<StartedReceipt>(),
      onSuccess: Option.some,
    });
  });

  const readCompleted = Effect.fnUntraced(function* (completedPath: string) {
    const text = yield* fs.readFileString(completedPath);
    const decoded = yield* Effect.result(decodeCompletedReceipt(text));
    return Result.match(decoded, {
      onFailure: () => Option.none<CompletedReceipt>(),
      onSuccess: Option.some,
    });
  });

  const readRecoveryFence = Effect.fnUntraced(function* (fencePath: string) {
    const text = yield* fs.readFileString(fencePath);
    const decoded = yield* Effect.result(decodeRecoveryFence(text));
    return Result.match(decoded, {
      onFailure: () => Option.none<RecoveryFence>(),
      onSuccess: Option.some,
    });
  });

  const clearRecoveryFence = Effect.fnUntraced(function* (sessionId: string) {
    const { fencePath, sessionDirectory } = recoveryCoordinates(sessionId);
    if (!(yield* fs.exists(fencePath))) return;
    yield* fs.remove(fencePath);
    yield* syncDirectory(sessionDirectory);
  });

  const completedReceiptMatchesFence = Effect.fnUntraced(function* (
    expectedSessionId: string,
    fence: RecoveryFence,
  ) {
    if (fence.sessionId !== expectedSessionId) return false;
    const { completedPath, startedPath } = coordinates(fence);
    const [startedExists, completedExists] = yield* Effect.all([
      fs.exists(startedPath),
      fs.exists(completedPath),
    ]);
    if (!startedExists || !completedExists) return false;
    const [started, completed] = yield* Effect.all([
      readStarted(startedPath),
      readCompleted(completedPath),
    ]);
    return (
      Option.isSome(started) &&
      Option.isSome(completed) &&
      started.value.operationId === fence.operationId &&
      started.value.sessionId === fence.sessionId &&
      started.value.intentSha256 === fence.intentSha256 &&
      completed.value.operationId === fence.operationId &&
      completed.value.sessionId === fence.sessionId &&
      completed.value.intentSha256 === fence.intentSha256 &&
      completed.value.response.operationId === fence.operationId &&
      completed.value.response.sessionId === fence.sessionId
    );
  });

  const recoveryFenceState = Effect.fnUntraced(function* (sessionId: string) {
    const { fencePath } = recoveryCoordinates(sessionId);
    if (!(yield* fs.exists(fencePath))) {
      return { _tag: "NoRecoveryFence" } as const;
    }
    const fence = yield* readRecoveryFence(fencePath);
    if (Option.isNone(fence) || fence.value.sessionId !== sessionId) {
      return { _tag: "CorruptRecoveryFence" } as const;
    }
    if (!(yield* completedReceiptMatchesFence(sessionId, fence.value))) {
      return { _tag: "ActiveRecoveryFence", fence: fence.value } as const;
    }
    yield* clearRecoveryFence(sessionId);
    return { _tag: "NoRecoveryFence" } as const;
  });

  const prepareFresh = Effect.fnUntraced(function* (
    operation: RunnerOperation,
    intentSha256: string,
    startedPath: string,
    operationDirectory: string,
  ) {
    const recoveryState: RecoveryFenceState = yield* recoveryFenceState(operation.sessionId);
    if (
      Predicate.isTagged(recoveryState, "ActiveRecoveryFence") &&
      recoveryState.fence.operationId === operation.operationId
    )
      return recoveryState.fence.intentSha256 === intentSha256
        ? ({ _tag: "OperationUnknown" } as const)
        : ({ _tag: "OperationConflict" } as const);
    if (
      !Predicate.isTagged(recoveryState, "NoRecoveryFence") &&
      !Predicate.isTagged(operation, "InspectRuntime") &&
      !Predicate.isTagged(operation, "StopRuntime")
    )
      return { _tag: "RecoveryRequired" } as const;
    if (Predicate.isTagged(operation, "ExecRuntime")) {
      const { fencePath, sessionDirectory } = recoveryCoordinates(operation.sessionId);
      yield* ensureRecoveryDirectory(sessionDirectory);
      const fence: RecoveryFence = {
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        status: "recovery_required",
        intentSha256,
      };
      yield* writeAtomic(fencePath, encodeRecoveryFence(fence), sessionDirectory);
    }
    const started: StartedReceipt = {
      operationId: operation.operationId,
      sessionId: operation.sessionId,
      status: "started",
      intentSha256,
    };
    yield* writeAtomic(startedPath, encodeStartedReceipt(started), operationDirectory);
    return { _tag: "ExecuteOperation" } as const;
  });

  const prepare = Effect.fnUntraced(function* (operation: RunnerOperation) {
    const { completedPath, operationDirectory, sessionDirectory, startedPath } =
      coordinates(operation);
    yield* ensureJournalDirectories(sessionDirectory, operationDirectory);

    const [startedExists, completedExists] = yield* Effect.all([
      fs.exists(startedPath),
      fs.exists(completedPath),
    ]);

    const intentSha256 = sha256(encodeRunnerOperation(operation));
    if (!startedExists && !completedExists)
      return yield* prepareFresh(operation, intentSha256, startedPath, operationDirectory);

    if (!startedExists) {
      return { _tag: "OperationUnknown" } as const;
    }

    const started = yield* readStarted(startedPath);
    if (Option.isNone(started)) {
      return { _tag: "OperationUnknown" } as const;
    }
    if (
      started.value.operationId !== operation.operationId ||
      started.value.sessionId !== operation.sessionId
    ) {
      return { _tag: "OperationUnknown" } as const;
    }
    if (started.value.intentSha256 !== intentSha256) {
      return { _tag: "OperationConflict" } as const;
    }
    if (!completedExists) {
      return { _tag: "OperationUnknown" } as const;
    }

    const completed = yield* readCompleted(completedPath);
    if (Option.isNone(completed)) {
      return { _tag: "OperationUnknown" } as const;
    }
    if (
      completed.value.operationId !== operation.operationId ||
      completed.value.sessionId !== operation.sessionId ||
      completed.value.intentSha256 !== intentSha256 ||
      completed.value.response.operationId !== operation.operationId ||
      completed.value.response.sessionId !== operation.sessionId
    ) {
      return { _tag: "OperationUnknown" } as const;
    }
    if (
      Predicate.isTagged(operation, "StopRuntime") &&
      Predicate.isTagged(completed.value.response, "RunnerSuccess")
    ) {
      yield* clearRecoveryFence(operation.sessionId);
    } else {
      yield* recoveryFenceState(operation.sessionId);
    }
    return { _tag: "ReplayOperation", response: completed.value.response } as const;
  });

  const complete = Effect.fnUntraced(function* (
    operation: RunnerOperation,
    response: RunnerResponse,
  ) {
    const { completedPath, operationDirectory } = coordinates(operation);
    const completed: CompletedReceipt = {
      operationId: operation.operationId,
      sessionId: operation.sessionId,
      status: "completed",
      intentSha256: sha256(encodeRunnerOperation(operation)),
      response,
    };
    yield* writeAtomic(completedPath, encodeCompletedReceipt(completed), operationDirectory);
  });

  return {
    prepare,
    complete,
    clearRecoveryFence,
  } satisfies RunnerOperationJournalShape;
});
