import { Match, Result, Schema } from "effect";
import type { SessionProjection, SessionView } from "../session/contracts";
import type {
  ActivityProof,
  BackupIdentity,
  SessionAuthority,
  StableState,
  Transition,
} from "./authority";
import type { SessionActorMetadata } from "./metadata";

export type PublicStatus = "booting" | "warm" | "sleeping" | "failed" | "gone";
export type PublicAction = "checkpoint" | "sleep" | "resume" | "work" | "vaporize";

export interface PublicSessionView {
  readonly status: PublicStatus;
  readonly deleting: boolean;
  readonly availableActions: ReadonlyArray<PublicAction>;
}

export interface SessionProjectionTimestamp {
  readonly iso: string;
  readonly epochMillis: number;
}

export class SessionActorProjectionUnavailable extends Schema.TaggedError<SessionActorProjectionUnavailable>()(
  "SessionActorProjectionUnavailable",
  { code: Schema.Literal("workspace_not_observed") },
) {}

const stableStatus = (stable: StableState): PublicStatus =>
  Match.valueTags(stable, {
    Warm: (): PublicStatus => "warm",
    Sleeping: (): PublicStatus => "sleeping",
    Failed: (): PublicStatus => "failed",
    Gone: (): PublicStatus => "gone",
  });

const originStatus = (origin: Transition["origin"]): PublicStatus =>
  origin === "Absent"
    ? "booting"
    : ({ Warm: "warm", Sleeping: "sleeping", Failed: "failed", Gone: "gone" } as const)[origin];

const transitionStatus = (transition: Transition): PublicStatus =>
  Match.valueTags(transition, {
    Create: (): PublicStatus => "booting",
    Resume: (): PublicStatus => "booting",
    Checkpoint: (value) => originStatus(value.origin),
    Sleep: (value) => originStatus(value.origin),
    WarmWork: (value) => originStatus(value.origin),
    Vaporize: (value) => originStatus(value.origin),
  });

const actions = (
  status: PublicStatus,
  deleting: boolean,
  actionableFailure: boolean,
): ReadonlyArray<PublicAction> => {
  if (deleting || status === "gone" || status === "booting") return [];
  if (status === "warm") return ["checkpoint", "sleep", "work", "vaporize"];
  if (status === "sleeping") return ["resume", "vaporize"];
  return actionableFailure ? ["resume", "vaporize"] : ["vaporize"];
};

export const publicView = (
  authority: SessionAuthority | undefined,
): PublicSessionView | undefined => {
  if (authority === undefined) return undefined;
  return Match.valueTags(authority.state, {
    Stable: ({ stable }) => {
      const status = stableStatus(stable);
      const actionableFailure = Match.valueTags(stable, {
        Warm: () => false,
        Sleeping: () => false,
        Failed: ({ actionable }) => actionable,
        Gone: () => false,
      });
      return {
        status,
        deleting: false,
        availableActions: actions(status, false, actionableFailure),
      };
    },
    Transitioning: ({ transition }) => {
      const status = transitionStatus(transition);
      const deleting = Match.valueTags(transition, {
        Create: () => false,
        Checkpoint: () => false,
        Sleep: () => false,
        Resume: () => false,
        WarmWork: () => false,
        Vaporize: () => true,
      });
      return { status, deleting, availableActions: actions(status, deleting, false) };
    },
  });
};

interface AuthorityProjectionDetails {
  readonly backupId?: string;
  readonly activity?: ActivityProof;
  readonly failure?: SessionProjection["failure"];
}

const backupDetails = (backup: BackupIdentity | null): AuthorityProjectionDetails =>
  backup === null ? {} : { backupId: backup.backupId };

const stableProjectionDetails = (stable: StableState): AuthorityProjectionDetails =>
  Match.valueTags(stable, {
    Warm: ({ backups, activity }) => ({
      ...(backups.currentBackupId === null ? {} : { backupId: backups.currentBackupId }),
      ...(activity === null ? {} : { activity }),
    }),
    Sleeping: ({ backup }) => backupDetails(backup),
    Failed: ({ code, actionable, backup }) => ({
      ...backupDetails(backup),
      failure: { code, message: code, recoverable: actionable },
    }),
    Gone: () => ({}),
  });

const transitionProjectionDetails = (transition: Transition): AuthorityProjectionDetails =>
  Match.valueTags(transition, {
    Create: () => ({}),
    Checkpoint: ({ proof }) =>
      proof.backup.currentBackupId === null ? {} : { backupId: proof.backup.currentBackupId },
    Sleep: ({ proof }) =>
      proof.backup.currentBackupId === null ? {} : { backupId: proof.backup.currentBackupId },
    Resume: ({ proof }) => backupDetails(proof.backup),
    WarmWork: ({ proof }) => ({
      ...(proof.backups.currentBackupId === null
        ? {}
        : { backupId: proof.backups.currentBackupId }),
      ...(proof.activity === null ? {} : { activity: proof.activity }),
    }),
    Vaporize: () => ({}),
  });

const projectionDetails = (authority: SessionAuthority): AuthorityProjectionDetails =>
  Match.valueTags(authority.state, {
    Stable: ({ stable }) => stableProjectionDetails(stable),
    Transitioning: ({ transition }) => transitionProjectionDetails(transition),
  });

export const sessionProjectionFromActor = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata,
  updatedAt: string,
  projectedAt: SessionProjectionTimestamp,
): Result.Result<SessionProjection, SessionActorProjectionUnavailable> => {
  const workspace = metadata.createObservations.workspace;
  if (workspace === null)
    return Result.fail(new SessionActorProjectionUnavailable({ code: "workspace_not_observed" }));

  const view = publicView(authority);
  if (view === undefined)
    return Result.fail(new SessionActorProjectionUnavailable({ code: "workspace_not_observed" }));
  const details = projectionDetails(authority);
  const activity = details.activity;
  const execution = authority.session.execution;
  return Result.succeed({
    id: authority.session.id,
    title: authority.session.title,
    status: view.status,
    ...(view.deleting ? { deleting: true } : {}),
    provider: execution.provider,
    ...(execution.provider === "runner" ? { runner: execution.runnerName } : {}),
    repo: workspace.repository,
    defaultBranch: workspace.defaultBranch,
    branch: metadata.branch,
    ...(details.backupId === undefined ? {} : { backupId: details.backupId }),
    ...(activity === undefined ? {} : { agentState: activity.state }),
    ...(activity === undefined ? {} : { lastAgentEventAt: activity.observedAt }),
    createdAt: authority.session.createdAt,
    updatedAt,
    hardCapAt: metadata.hardCap.deadlineAt,
    projectedAt: projectedAt.iso,
    ...(details.failure === undefined ? {} : { failure: details.failure }),
    sandboxBundle: { digest: metadata.createObservations.bundle?.digest ?? null },
  });
};

export const sessionViewFromActor = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata,
  updatedAt: string,
  projectedAt: SessionProjectionTimestamp,
): Result.Result<SessionView, SessionActorProjectionUnavailable> => {
  const projection = sessionProjectionFromActor(authority, metadata, updatedAt, projectedAt);
  if (Result.isFailure(projection)) return Result.fail(projection.failure);
  return Result.succeed({
    ...projection.success,
    ageSeconds: Math.max(
      0,
      Math.floor((projectedAt.epochMillis - Date.parse(projection.success.createdAt)) / 1000),
    ),
    capRemainingSeconds: Math.max(
      0,
      Math.floor((Date.parse(projection.success.hardCapAt) - projectedAt.epochMillis) / 1000),
    ),
  });
};
