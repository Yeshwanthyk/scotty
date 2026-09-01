import { Data, Predicate, Result } from "effect";
import {
  AuthorityStateSchema,
  decodeSessionAuthority,
  StableStateSchema,
  TransitionSchema,
  type ActivityProof,
  type BackupIdentity,
  type SessionAuthority,
} from "../session-actor/authority";
import { decodeSessionActorMetadata, type SessionActorMetadata } from "../session-actor/metadata";
import type { MetadataStoragePort } from "../session-actor/metadata-store";
import { publicView } from "../session-actor/public-view";
import type {
  ActorStoragePort,
  ActorStorageTransactionPlan,
  RawActorStorageSnapshot,
} from "../session-actor/store";
import { decodeActorStorageSnapshot } from "../session-actor/store";
import {
  makeSessionActorDiagnostics,
  type SessionActorDiagnostics,
} from "../session-actor/diagnostics";
import type { SessionRecord } from "./contracts";

export const EVIDENCE_RECORD_KEY = "scotty:evidence";
export const HATCH_STATE_KEY = "scotty:hatch";
export const SESSION_ACTOR_AUTHORITY_KEY = "scotty:session-actor:authority";
export const SESSION_ACTOR_REVISION_KEY = "scotty:session-actor:revision";
export const SESSION_ACTOR_JOURNAL_SEQUENCE_KEY = "scotty:session-actor:journal-sequence";
export const SESSION_ACTOR_JOURNAL_TAIL_KEY = "scotty:session-actor:journal-tail";
export const SESSION_ACTOR_METADATA_KEY = "scotty:session-actor:metadata";
const SESSION_ACTOR_JOURNAL_PREFIX = "scotty:session-actor:journal:";
const SESSION_ACTOR_DIAGNOSTIC_JOURNAL_LIMIT = 256;

class SessionActorStorageFailure extends Data.TaggedError("SessionActorStorageFailure")<{
  readonly reason: "invalid";
}> {}

export interface SessionControlGate {
  readonly run: <A>(operation: () => Promise<A>) => Promise<A>;
}

export const makeSessionControlGate = (): SessionControlGate => {
  let tail: Promise<void> = Promise.resolve();
  return {
    run: async <A>(operation: () => Promise<A>): Promise<A> => {
      const preceding = tail;
      let release = (): void => undefined;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await preceding;
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: the Promise mutex must release on both fulfillment and rejection
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
};

export interface SessionEvidenceTransaction {
  readonly getRecord: () => Promise<unknown | undefined>;
  readonly getEvidence: () => Promise<unknown | undefined>;
  readonly getRuntimeEpoch: () => Promise<unknown | undefined>;
  readonly putEvidence: (evidence: unknown) => Promise<void>;
  readonly deleteEvidence: () => Promise<void>;
}

export interface SessionAuxiliaryStorage {
  readonly getEvidence: () => Promise<unknown | undefined>;
  readonly evidenceTransaction: <A>(
    operation: (transaction: SessionEvidenceTransaction) => Promise<A>,
  ) => Promise<A>;
}

const actorOperation = (authority: SessionAuthority): SessionRecord["operation"] => {
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return null;
  const transition = authority.state.transition;
  const kind = TransitionSchema.guards.Create(transition)
    ? "create"
    : TransitionSchema.guards.Checkpoint(transition) || TransitionSchema.guards.Sleep(transition)
      ? "snapshot"
      : TransitionSchema.guards.Resume(transition)
        ? "resume"
        : TransitionSchema.guards.Vaporize(transition)
          ? "vaporize"
          : transition.workKind === "Evidence"
            ? "evidence"
            : transition.workKind === "Hatch"
              ? "hatch"
              : transition.workKind === "Down"
                ? "down"
                : "snapshot";
  return {
    kind,
    nonce: transition.nonce,
    startedAt: transition.startedAt,
    ...(kind === "create" ? { createPhase: "runtime" as const } : {}),
  };
};

interface ActorStableRecordDetails {
  readonly ownedBackupIds: ReadonlyArray<string>;
  readonly currentBackup: BackupIdentity | null;
  readonly activity: ActivityProof | null;
  readonly failure: SessionRecord["failure"] | undefined;
}

const actorStableRecordDetails = (authority: SessionAuthority): ActorStableRecordDetails => {
  if (!AuthorityStateSchema.guards.Stable(authority.state))
    return { ownedBackupIds: [], currentBackup: null, activity: null, failure: undefined };
  const stable = authority.state.stable;
  if (StableStateSchema.guards.Warm(stable))
    return {
      ownedBackupIds: stable.backups.ownedBackupIds,
      currentBackup: stable.backups.prepared,
      activity: stable.activity,
      failure: undefined,
    };
  if (StableStateSchema.guards.Sleeping(stable))
    return {
      ownedBackupIds: stable.ownedBackupIds,
      currentBackup: stable.backup,
      activity: null,
      failure: undefined,
    };
  if (StableStateSchema.guards.Failed(stable))
    return {
      ownedBackupIds: stable.ownedBackupIds,
      currentBackup: stable.backup,
      activity: null,
      failure: { code: stable.code, message: stable.code, recoverable: stable.actionable },
    };
  return { ownedBackupIds: [], currentBackup: null, activity: null, failure: undefined };
};

export const sessionRecordFromActor = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata,
  updatedAt: string,
): SessionRecord | undefined => {
  const workspace = metadata.createObservations.workspace;
  const view = publicView(authority);
  if (workspace === null || view === undefined) return undefined;
  const { ownedBackupIds, currentBackup, activity, failure } = actorStableRecordDetails(authority);
  const grants = metadata.createObservations.credentialGrants?.grants;
  return {
    id: authority.session.id,
    title: authority.session.title,
    status: view.status,
    operation: actorOperation(authority),
    execution:
      authority.session.execution.provider === "cloudflare"
        ? { provider: "cloudflare" }
        : {
            provider: "runner",
            runner: authority.session.execution.runnerName,
            runtimeId: authority.session.id,
          },
    provider: authority.session.execution.provider,
    ...(authority.session.execution.provider === "runner"
      ? { runner: authority.session.execution.runnerName }
      : {}),
    repo: workspace.repository,
    repoExistsAtCreate: workspace.repositoryExists,
    defaultBranch: workspace.defaultBranch,
    branch: metadata.branch,
    createdAt: authority.session.createdAt,
    updatedAt,
    hardCapAt: authority.hardCap.deadlineAt,
    hardCapDurationSeconds: authority.hardCap.durationSeconds,
    ownedBackupIds,
    ...(currentBackup === null
      ? {}
      : {
          backup: {
            current: { id: currentBackup.backupId, dir: `/workspace/${authority.session.id}` },
          },
        }),
    ...(activity === null
      ? {}
      : { agentState: activity.state, lastAgentEventAt: activity.observedAt }),
    ...(failure === undefined ? {} : { failure }),
    sandboxBundle: { digest: metadata.createObservations.bundle?.digest ?? null },
    ...(grants === undefined
      ? {}
      : { credentialGrant: { sessionId: authority.session.id, grants } }),
  };
};

export const readActorSessionRecord = async (
  transaction: DurableObjectTransaction,
): Promise<unknown | undefined> => {
  const [storedAuthority, storedMetadata, journalTail] = await Promise.all([
    transaction.get<unknown>(SESSION_ACTOR_AUTHORITY_KEY),
    transaction.get<unknown>(SESSION_ACTOR_METADATA_KEY),
    transaction.get<{ readonly timestamp?: unknown }>(SESSION_ACTOR_JOURNAL_TAIL_KEY),
  ]);
  if (storedAuthority === undefined || storedMetadata === undefined) return undefined;
  const authority = decodeSessionAuthority(storedAuthority);
  const metadata = decodeSessionActorMetadata(storedMetadata);
  if (Result.isFailure(authority) || Result.isFailure(metadata)) return undefined;
  return sessionRecordFromActor(
    authority.success,
    metadata.success,
    typeof journalTail?.timestamp === "string"
      ? journalTail.timestamp
      : authority.success.session.createdAt,
  );
};

export const readActorRuntimeGeneration = async (
  transaction: DurableObjectTransaction,
): Promise<unknown | undefined> => {
  const storedAuthority = await transaction.get<unknown>(SESSION_ACTOR_AUTHORITY_KEY);
  if (storedAuthority === undefined) return undefined;
  const authority = decodeSessionAuthority(storedAuthority);
  if (Result.isFailure(authority)) return undefined;
  const readiness = AuthorityStateSchema.guards.Stable(authority.success.state)
    ? StableStateSchema.guards.Warm(authority.success.state.stable)
      ? authority.success.state.stable.readiness
      : undefined
    : "readiness" in authority.success.state.transition.proof
      ? authority.success.state.transition.proof.readiness
      : undefined;
  return readiness?.runtime?.runtimeGeneration;
};

export const durableObjectSessionAuxiliaryStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate = makeSessionControlGate(),
): SessionAuxiliaryStorage => ({
  getEvidence: () => storage.get(EVIDENCE_RECORD_KEY),
  evidenceTransaction: (operation) =>
    controlGate.run(() =>
      storage.transaction((transaction) =>
        operation({
          getRecord: () => readActorSessionRecord(transaction),
          getEvidence: () => transaction.get(EVIDENCE_RECORD_KEY),
          getRuntimeEpoch: () => readActorRuntimeGeneration(transaction),
          putEvidence: (evidence) => transaction.put(EVIDENCE_RECORD_KEY, evidence),
          deleteEvidence: () => transaction.delete(EVIDENCE_RECORD_KEY).then(() => undefined),
        }),
      ),
    ),
});

const sessionActorJournalKey = (sequence: number): string =>
  `${SESSION_ACTOR_JOURNAL_PREFIX}${String(sequence).padStart(16, "0")}`;

const readActorStorageSnapshot = async (
  storage: DurableObjectStorage | DurableObjectTransaction,
): Promise<RawActorStorageSnapshot> => {
  const [authority, revision, journalSequence, journalTail, evidence] = await Promise.all([
    storage.get<unknown>(SESSION_ACTOR_AUTHORITY_KEY),
    storage.get<unknown>(SESSION_ACTOR_REVISION_KEY),
    storage.get<unknown>(SESSION_ACTOR_JOURNAL_SEQUENCE_KEY),
    storage.get<unknown>(SESSION_ACTOR_JOURNAL_TAIL_KEY),
    storage.get<unknown>(EVIDENCE_RECORD_KEY),
  ]);
  return { authority, revision, journalSequence, journalTail, evidence };
};

const applyActorStorageCommit = async (
  transaction: DurableObjectTransaction,
  plan: Extract<ActorStorageTransactionPlan, { readonly _tag: "Commit" }>,
): Promise<void> => {
  const journalKey = sessionActorJournalKey(plan.write.journalSequence);
  const existingJournal = await transaction.get<unknown>(journalKey);
  if (existingJournal !== undefined) {
    // oxlint-disable-next-line scotty/no-promise-reject -- boundary: rejecting the native transaction prevents overwriting an immutable journal event
    return Promise.reject(new SessionActorStorageFailure({ reason: "invalid" }));
  }
  const writes: Array<Promise<void>> = [
    transaction.put(SESSION_ACTOR_AUTHORITY_KEY, plan.write.authority),
    transaction.put(SESSION_ACTOR_REVISION_KEY, plan.write.revision),
    transaction.put(SESSION_ACTOR_JOURNAL_SEQUENCE_KEY, plan.write.journalSequence),
    transaction.put(SESSION_ACTOR_JOURNAL_TAIL_KEY, plan.write.appendJournal),
    transaction.put(journalKey, plan.write.appendJournal),
  ];
  if (Predicate.isTagged(plan.write.evidence, "Put"))
    writes.push(transaction.put(EVIDENCE_RECORD_KEY, plan.write.evidence.value));
  if (Predicate.isTagged(plan.write.evidence, "Delete"))
    writes.push(transaction.delete(EVIDENCE_RECORD_KEY).then(() => undefined));
  await Promise.all(writes);
};

export const durableObjectSessionActorStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate = makeSessionControlGate(),
): ActorStoragePort => ({
  read: () => storage.transaction((transaction) => readActorStorageSnapshot(transaction)),
  transaction: (operation) =>
    controlGate.run(() =>
      storage.transaction(async (transaction) => {
        const plan = operation(await readActorStorageSnapshot(transaction));
        if (Predicate.isTagged(plan, "NoCommit")) return plan.outcome;
        await applyActorStorageCommit(transaction, plan);
        return plan.outcome;
      }),
    ),
});

export const readDurableObjectSessionActorDiagnostics = async (
  storage: DurableObjectStorage,
): Promise<Result.Result<SessionActorDiagnostics, "absent" | "invalid">> =>
  storage.transaction(async (transaction) => {
    const snapshot = decodeActorStorageSnapshot(await readActorStorageSnapshot(transaction));
    if (Result.isFailure(snapshot)) return Result.fail("invalid" as const);
    const { authority, journalSequence, journalTail } = snapshot.success;
    if (authority === undefined || journalTail === undefined) return Result.fail("absent" as const);
    const storedJournal = await transaction.list<unknown>({
      prefix: SESSION_ACTOR_JOURNAL_PREFIX,
      reverse: true,
      limit: SESSION_ACTOR_DIAGNOSTIC_JOURNAL_LIMIT,
    });
    const diagnostics = makeSessionActorDiagnostics(authority, journalSequence, journalTail, [
      ...storedJournal.values(),
    ]);
    return Result.isSuccess(diagnostics)
      ? Result.succeed(diagnostics.success)
      : Result.fail("invalid" as const);
  });

export const durableObjectSessionActorMetadataStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate = makeSessionControlGate(),
): MetadataStoragePort => ({
  read: () => storage.get<unknown>(SESSION_ACTOR_METADATA_KEY),
  transaction: (decide) =>
    controlGate.run(() =>
      storage.transaction(async (transaction) => {
        const mutation = decide(await transaction.get<unknown>(SESSION_ACTOR_METADATA_KEY));
        if (Predicate.isTagged(mutation, "Put"))
          await transaction.put(SESSION_ACTOR_METADATA_KEY, mutation.value);
        if (Predicate.isTagged(mutation, "Delete"))
          await transaction.delete(SESSION_ACTOR_METADATA_KEY);
        return mutation.outcome;
      }),
    ),
});
