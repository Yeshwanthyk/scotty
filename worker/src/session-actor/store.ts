import { Context, Duration, Effect, Equal, Layer, Predicate, Result, Schema } from "effect";
import { AuthorityStateSchema, decodeSessionAuthority, type SessionAuthority } from "./authority";
import type { AcceptedDecision, EffectIntent } from "./decision";
import {
  decodeLifecycleJournalEvent,
  makeLifecycleJournalEvent,
  type LifecycleJournalEvent,
} from "./journal";
import { validateAuthority } from "./reducer";

export type EvidenceMutation =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Put"; readonly value: unknown; readonly expected?: unknown }
  | { readonly _tag: "Delete"; readonly expected?: unknown };

export interface RawActorStorageSnapshot {
  readonly authority?: unknown;
  readonly revision?: unknown;
  readonly journalSequence?: unknown;
  readonly journalTail?: unknown;
  readonly evidence?: unknown;
}

export interface ActorStorageWrite {
  readonly authority: SessionAuthority;
  readonly revision: number;
  readonly journalSequence: number;
  readonly appendJournal: LifecycleJournalEvent;
  readonly evidence: EvidenceMutation;
}

export type ActorStorageTransactionPlan =
  | {
      readonly _tag: "NoCommit";
      readonly outcome: ActorStorageTransactionFailure;
    }
  | {
      readonly _tag: "Commit";
      readonly write: ActorStorageWrite;
      readonly outcome: { readonly _tag: "Committed" };
    };

export type ActorStorageTransactionOutcome =
  | { readonly _tag: "Committed" }
  | ActorStorageTransactionFailure;

export type ActorStorageTransactionFailure =
  | {
      readonly _tag: "Conflict";
      readonly reason: "revision" | "nonce" | "phase" | "evidence";
      readonly actualRevision: number;
    }
  | { readonly _tag: "Corrupt"; readonly key: ActorStorageKey };

export interface ActorStoragePort {
  readonly read: () => Promise<RawActorStorageSnapshot>;
  readonly transaction: (
    operation: (snapshot: RawActorStorageSnapshot) => ActorStorageTransactionPlan,
  ) => Promise<ActorStorageTransactionOutcome>;
}

export type ActorStorageKey = "authority" | "revision" | "journalSequence" | "journalTail";

export class ActorStoreConflict extends Schema.TaggedError<ActorStoreConflict>()(
  "ActorStoreConflict",
  {
    reason: Schema.Literals(["revision", "nonce", "phase", "evidence"]),
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
  },
) {}

export class ActorStoreCorrupt extends Schema.TaggedError<ActorStoreCorrupt>()(
  "ActorStoreCorrupt",
  { key: Schema.Literals(["authority", "revision", "journalSequence", "journalTail"]) },
) {}

export class ActorStoreReadFailure extends Schema.TaggedError<ActorStoreReadFailure>()(
  "ActorStoreReadFailure",
  { operation: Schema.Literal("read") },
) {}

export class ActorStoreTransactionOutcomeUnknown extends Schema.TaggedError<ActorStoreTransactionOutcomeUnknown>()(
  "ActorStoreTransactionOutcomeUnknown",
  { correlationId: Schema.String, expectedRevision: Schema.Int },
) {}

export class ActorStoreUnconfirmedCommit extends Schema.TaggedError<ActorStoreUnconfirmedCommit>()(
  "ActorStoreUnconfirmedCommit",
  { correlationId: Schema.String, expectedRevision: Schema.Int },
) {}

export type ActorStoreReadError = ActorStoreCorrupt | ActorStoreReadFailure;
export type ActorStoreCommitError =
  | ActorStoreConflict
  | ActorStoreCorrupt
  | ActorStoreTransactionOutcomeUnknown;
export type ActorStoreReconcileError =
  | ActorStoreConflict
  | ActorStoreCorrupt
  | ActorStoreReadFailure
  | ActorStoreUnconfirmedCommit;

export interface ActorStoreSnapshot {
  readonly authority: SessionAuthority | undefined;
  readonly revision: number;
  readonly journalSequence: number;
  readonly journalTail: LifecycleJournalEvent | undefined;
  readonly evidence: unknown | undefined;
}

export interface ActorCommitRequest {
  readonly expectedRevision: number;
  readonly expectedTransitionNonce: string | null;
  readonly expectedPhase: string | null;
  readonly decision: AcceptedDecision;
  readonly evidence: EvidenceMutation;
  readonly causeSequence: number | null;
}

export interface CommittedActorDecision {
  readonly authority: SessionAuthority;
  readonly journalEvent: LifecycleJournalEvent;
  readonly effectIntents: ReadonlyArray<EffectIntent>;
}

interface ActorStoreShape {
  readonly read: Effect.Effect<ActorStoreSnapshot, ActorStoreReadError>;
  readonly commit: (
    request: ActorCommitRequest,
  ) => Effect.Effect<CommittedActorDecision, ActorStoreCommitError>;
  readonly reconcileUnknownCommit: (
    request: ActorCommitRequest,
  ) => Effect.Effect<CommittedActorDecision, ActorStoreReconcileError>;
}

export class ActorStore extends Context.Service<ActorStore, ActorStoreShape>()(
  "scotty/SessionActor/Store",
) {}

const decodeCounter = (
  value: unknown,
  key: "revision" | "journalSequence",
): Result.Result<number, ActorStoreCorrupt> => {
  if (value === undefined) return Result.succeed(0);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return Result.fail(new ActorStoreCorrupt({ key }));
  return Result.succeed(value);
};

const validateSnapshotCoherence = (
  authority: SessionAuthority | undefined,
  revision: number,
  journalSequence: number,
  journalTail: LifecycleJournalEvent | undefined,
): ActorStorageKey | undefined => {
  if (authority === undefined && revision !== 0) return "authority";
  if (authority !== undefined && authority.revision !== revision) return "authority";
  if (journalSequence !== revision) return "journalSequence";
  if (journalSequence === 0 && journalTail !== undefined) return "journalTail";
  if (
    journalSequence > 0 &&
    (journalTail === undefined ||
      journalTail.sequence !== journalSequence ||
      journalTail.revision !== revision)
  )
    return "journalTail";
  return undefined;
};

export const decodeActorStorageSnapshot = (
  raw: RawActorStorageSnapshot,
): Result.Result<ActorStoreSnapshot, ActorStoreCorrupt> => {
  const revision = decodeCounter(raw.revision, "revision");
  if (Result.isFailure(revision)) return Result.fail(revision.failure);
  const journalSequence = decodeCounter(raw.journalSequence, "journalSequence");
  if (Result.isFailure(journalSequence)) return Result.fail(journalSequence.failure);
  const revisionValue = revision.success;
  const journalSequenceValue = journalSequence.success;

  let authority: SessionAuthority | undefined;
  if (raw.authority !== undefined) {
    const decoded = decodeSessionAuthority(raw.authority);
    if (Result.isFailure(decoded)) return Result.fail(new ActorStoreCorrupt({ key: "authority" }));
    authority = decoded.success;
    if (!validateAuthority(authority))
      return Result.fail(new ActorStoreCorrupt({ key: "authority" }));
  }

  let journalTail: LifecycleJournalEvent | undefined;
  if (raw.journalTail !== undefined) {
    const decoded = decodeLifecycleJournalEvent(raw.journalTail);
    if (Result.isFailure(decoded))
      return Result.fail(new ActorStoreCorrupt({ key: "journalTail" }));
    journalTail = decoded.success;
  }

  const corruptKey = validateSnapshotCoherence(
    authority,
    revisionValue,
    journalSequenceValue,
    journalTail,
  );
  if (corruptKey !== undefined) return Result.fail(new ActorStoreCorrupt({ key: corruptKey }));

  return Result.succeed({
    authority,
    revision: revisionValue,
    journalSequence: journalSequenceValue,
    journalTail,
    evidence: raw.evidence,
  });
};

const currentTransitionFence = (
  authority: SessionAuthority | undefined,
): { readonly nonce: string | null; readonly phase: string | null } => {
  if (authority === undefined || !AuthorityStateSchema.guards.Transitioning(authority.state))
    return { nonce: null, phase: null };
  return {
    nonce: authority.state.transition.nonce,
    phase: authority.state.transition.phase,
  };
};

const conflict = (
  reason: "revision" | "nonce" | "phase" | "evidence",
  request: ActorCommitRequest,
  actualRevision: number,
): ActorStorageTransactionPlan => ({
  _tag: "NoCommit",
  outcome: { _tag: "Conflict", reason, actualRevision },
});

const planCommit = (
  raw: RawActorStorageSnapshot,
  request: ActorCommitRequest,
): ActorStorageTransactionPlan => {
  const decoded = decodeActorStorageSnapshot(raw);
  if (Result.isFailure(decoded))
    return { _tag: "NoCommit", outcome: { _tag: "Corrupt", key: decoded.failure.key } };
  const current = decoded.success;
  if (current.revision !== request.expectedRevision)
    return conflict("revision", request, current.revision);
  const fence = currentTransitionFence(current.authority);
  if (fence.nonce !== request.expectedTransitionNonce)
    return conflict("nonce", request, current.revision);
  if (fence.phase !== request.expectedPhase) return conflict("phase", request, current.revision);
  if (
    !Predicate.isTagged(request.evidence, "Keep") &&
    "expected" in request.evidence &&
    !Equal.equals(current.evidence, request.evidence.expected)
  )
    return conflict("evidence", request, current.revision);
  if (request.decision.nextAuthority.revision !== current.revision + 1)
    return { _tag: "NoCommit", outcome: { _tag: "Corrupt", key: "authority" } };

  const nextSequence = current.journalSequence + 1;
  const journal = makeLifecycleJournalEvent(
    nextSequence,
    request.decision.nextAuthority.revision,
    request.decision.journalEvent,
    request.causeSequence,
  );
  if (Result.isFailure(journal))
    return { _tag: "NoCommit", outcome: { _tag: "Corrupt", key: "journalTail" } };
  return {
    _tag: "Commit",
    write: {
      authority: request.decision.nextAuthority,
      revision: request.decision.nextAuthority.revision,
      journalSequence: nextSequence,
      appendJournal: journal.success,
      evidence: request.evidence,
    },
    outcome: { _tag: "Committed" },
  };
};

const committed = (
  request: ActorCommitRequest,
  journalEvent: LifecycleJournalEvent,
): CommittedActorDecision => ({
  authority: request.decision.nextAuthority,
  journalEvent,
  effectIntents: request.decision.effectIntents,
});

export const makeActorStore = (
  port: ActorStoragePort,
  transactionTimeout: Duration.Input = "5 seconds",
): ActorStoreShape => {
  const read: ActorStoreShape["read"] = Effect.tryPromise({
    try: () => port.read(),
    catch: () => new ActorStoreReadFailure({ operation: "read" }),
  }).pipe(
    Effect.flatMap((raw) => {
      const decoded = decodeActorStorageSnapshot(raw);
      return Result.isSuccess(decoded)
        ? Effect.succeed(decoded.success)
        : Effect.fail(decoded.failure);
    }),
  );

  const transaction = Effect.fnUntraced(function* (request: ActorCommitRequest) {
    const unknown = () =>
      new ActorStoreTransactionOutcomeUnknown({
        correlationId: request.decision.journalEvent.correlationId,
        expectedRevision: request.expectedRevision,
      });
    const attempted = Effect.tryPromise({
      try: () => port.transaction((snapshot) => planCommit(snapshot, request)),
      catch: unknown,
    });
    return yield* attempted.pipe(
      Effect.timeoutOrElse({ duration: transactionTimeout, orElse: () => Effect.fail(unknown()) }),
    );
  });

  const commit = Effect.fnUntraced(function* (request: ActorCommitRequest) {
    const outcome = yield* transaction(request);
    if (Predicate.isTagged(outcome, "Corrupt"))
      return yield* new ActorStoreCorrupt({ key: outcome.key });
    if (Predicate.isTagged(outcome, "Conflict"))
      return yield* new ActorStoreConflict({
        reason: outcome.reason,
        expectedRevision: request.expectedRevision,
        actualRevision: outcome.actualRevision,
      });
    const journal = makeLifecycleJournalEvent(
      request.expectedRevision + 1,
      request.decision.nextAuthority.revision,
      request.decision.journalEvent,
      request.causeSequence,
    );
    if (Result.isFailure(journal)) return yield* new ActorStoreCorrupt({ key: "journalTail" });
    return committed(request, journal.success);
  });

  const reconcileUnknownCommit = Effect.fnUntraced(function* (request: ActorCommitRequest) {
    const current = yield* read;
    const journal = makeLifecycleJournalEvent(
      request.expectedRevision + 1,
      request.decision.nextAuthority.revision,
      request.decision.journalEvent,
      request.causeSequence,
    );
    if (Result.isFailure(journal)) return yield* new ActorStoreCorrupt({ key: "journalTail" });
    if (
      current.revision === request.decision.nextAuthority.revision &&
      Equal.equals(current.authority, request.decision.nextAuthority) &&
      Equal.equals(current.journalTail, journal.success)
    )
      return committed(request, journal.success);
    if (current.revision !== request.expectedRevision)
      return yield* new ActorStoreConflict({
        reason: "revision",
        expectedRevision: request.expectedRevision,
        actualRevision: current.revision,
      });
    return yield* new ActorStoreUnconfirmedCommit({
      correlationId: request.decision.journalEvent.correlationId,
      expectedRevision: request.expectedRevision,
    });
  });

  return ActorStore.of({ read, commit, reconcileUnknownCommit });
};

export const actorStoreLayer = (
  port: ActorStoragePort,
  transactionTimeout?: Duration.Input,
): Layer.Layer<ActorStore> => Layer.succeed(ActorStore)(makeActorStore(port, transactionTimeout));
