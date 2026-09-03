import { Match, Predicate, Result, Schema } from "effect";
import type { SessionOperation, SessionView } from "../session/contracts";
import type { SessionActorMetadata } from "../session-actor/metadata";
import type { SessionAuthority } from "../session-actor/authority";
import { publicView } from "../session-actor/public-view";

const UiSessionLifecycleSchema = Schema.Literals(["warm", "sleeping", "failed", "gone"]);
const UiSessionActionSchema = Schema.Literals([
  "create",
  "checkpoint",
  "sleep",
  "resume",
  "work",
  "evidence",
  "hatch",
  "down",
  "vaporize",
]);
const UiSessionAuthoritySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stable"),
    lifecycle: UiSessionLifecycleSchema,
    failure: Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        recoverable: Schema.Boolean,
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("transitioning"),
    action: UiSessionActionSchema,
    phase: Schema.String,
    mode: Schema.Literals(["executing", "reconciling"]),
    startedAt: Schema.String,
  }),
]);

const UiSessionCapabilitiesSchema = Schema.Struct({
  checkpoint: Schema.Boolean,
  sleep: Schema.Boolean,
  resume: Schema.Boolean,
  work: Schema.Boolean,
  vaporize: Schema.Boolean,
});

export const UiSessionSchema = Schema.Struct({
  identity: Schema.Struct({ id: Schema.String }),
  authority: UiSessionAuthoritySchema,
  runtime: Schema.Struct({
    provider: Schema.Literals(["cloudflare", "runner"]),
    readiness: Schema.Literals(["unchecked", "not-applicable"]),
  }),
  capabilities: UiSessionCapabilitiesSchema,
  display: Schema.Struct({
    title: Schema.String,
    repository: Schema.String,
    branch: Schema.NullOr(Schema.String),
    defaultBranch: Schema.NullOr(Schema.String),
  }),
  times: Schema.Struct({
    capRemainingSeconds: Schema.Number,
  }),
});
export type UiSession = typeof UiSessionSchema.Type;
type UiTransitionAction = Extract<
  UiSession["authority"],
  { readonly kind: "transitioning" }
>["action"];

export const UiSessionResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  session: UiSessionSchema,
});
export type UiSessionResponse = typeof UiSessionResponseSchema.Type;

export const UiSessionListItemSchema = Schema.Struct({
  ...UiSessionSchema.fields,
  projection: Schema.Struct({ projectedAt: Schema.String }),
});
export type UiSessionListItem = typeof UiSessionListItemSchema.Type;

export const UiSessionListResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(UiSessionListItemSchema),
});
export type UiSessionListResponse = typeof UiSessionListResponseSchema.Type;

export class UiSessionProjectionInvalid extends Schema.TaggedError<UiSessionProjectionInvalid>()(
  "UiSessionProjectionInvalid",
  { sessionId: Schema.String, reason: Schema.Literal("booting_without_operation") },
) {}

const warmWorkAction = (
  workKind: "Evidence" | "Hatch" | "Down" | "ManualCheckpoint" | "RuntimePreparation",
): "evidence" | "hatch" | "down" | "checkpoint" | "work" =>
  (
    ({
      Evidence: "evidence",
      Hatch: "hatch",
      Down: "down",
      ManualCheckpoint: "checkpoint",
      RuntimePreparation: "work",
    }) as const
  )[workKind];

const authorityView = (authority: SessionAuthority): UiSessionResponse["session"]["authority"] =>
  Match.valueTags(authority.state, {
    Stable: ({ stable }) =>
      Match.valueTags(stable, {
        Warm: () => ({ kind: "stable" as const, lifecycle: "warm" as const, failure: null }),
        Sleeping: () => ({
          kind: "stable" as const,
          lifecycle: "sleeping" as const,
          failure: null,
        }),
        Failed: ({ actionable, code }) => ({
          kind: "stable" as const,
          lifecycle: "failed" as const,
          failure: { code, recoverable: actionable },
        }),
        Gone: () => ({ kind: "stable" as const, lifecycle: "gone" as const, failure: null }),
      }),
    Transitioning: ({ transition }) => ({
      kind: "transitioning" as const,
      action: Match.valueTags(transition, {
        Create: () => "create" as const,
        Checkpoint: () => "checkpoint" as const,
        Sleep: () => "sleep" as const,
        Resume: () => "resume" as const,
        WarmWork: ({ workKind }) => warmWorkAction(workKind),
        Vaporize: () => "vaporize" as const,
      }),
      phase: transition.phase,
      mode: transition.mode,
      startedAt: transition.startedAt,
    }),
  });

const capabilitiesView = (
  authority: SessionAuthority,
): UiSessionResponse["session"]["capabilities"] => {
  const actions = new Set(publicView(authority)?.availableActions ?? []);
  return {
    checkpoint: actions.has("checkpoint"),
    sleep: actions.has("sleep"),
    resume: actions.has("resume"),
    work: actions.has("work"),
    vaporize: actions.has("vaporize"),
  };
};

export const uiSessionResponseFromActor = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata | undefined,
  now: number,
): UiSessionResponse => {
  return {
    version: 1,
    session: uiSessionFromActor(authority, metadata, now),
  };
};

const uiSessionFromActor = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata | undefined,
  now: number,
): UiSession => {
  const provider = authority.session.execution.provider;
  const stableWarm =
    Predicate.isTagged(authority.state, "Stable") &&
    Predicate.isTagged(authority.state.stable, "Warm");
  return {
    identity: { id: authority.session.id },
    authority: authorityView(authority),
    runtime: {
      provider,
      readiness: provider === "cloudflare" && stableWarm ? "unchecked" : "not-applicable",
    },
    capabilities: capabilitiesView(authority),
    display: {
      title: authority.session.title,
      repository: authority.session.repository,
      branch: metadata?.branch ?? null,
      defaultBranch: metadata?.createObservations.workspace?.defaultBranch ?? null,
    },
    times: {
      capRemainingSeconds: Math.max(
        0,
        Math.floor((Date.parse(authority.hardCap.deadlineAt) - now) / 1_000),
      ),
    },
  };
};

const projectedAction = {
  create: "create",
  snapshot: "checkpoint",
  sleep: "sleep",
  resume: "resume",
  evidence: "evidence",
  hatch: "hatch",
  down: "down",
  vaporize: "vaporize",
} as const satisfies Record<SessionOperation["kind"], UiTransitionAction>;

const projectionAction = (operation: SessionOperation): UiSession["authority"] => ({
  kind: "transitioning",
  action: projectedAction[operation.kind],
  phase: operation.phase ?? operation.createPhase ?? "Pending",
  mode: operation.mode ?? "executing",
  startedAt: operation.startedAt,
});

const stableProjectionAuthority = (
  projection: SessionView,
): Result.Result<UiSession["authority"], UiSessionProjectionInvalid> => {
  if (projection.status === "booting")
    return Result.fail(
      new UiSessionProjectionInvalid({
        sessionId: projection.id,
        reason: "booting_without_operation",
      }),
    );
  return Result.succeed({
    kind: "stable",
    lifecycle: projection.status,
    failure:
      projection.status === "failed"
        ? {
            code: projection.failure?.code ?? "unknown",
            recoverable: projection.failure?.recoverable ?? false,
          }
        : null,
  });
};

export const uiSessionListItemFromProjection = (
  projection: SessionView,
): Result.Result<UiSessionListItem, UiSessionProjectionInvalid> => {
  const authority =
    projection.operation === undefined
      ? stableProjectionAuthority(projection)
      : Result.succeed(projectionAction(projection.operation));
  if (Result.isFailure(authority)) return Result.fail(authority.failure);
  const stableWarm = authority.success.kind === "stable" && authority.success.lifecycle === "warm";
  const transitioning = authority.success.kind === "transitioning";
  const failure = authority.success.kind === "stable" ? authority.success.failure : null;
  return Result.succeed({
    identity: { id: projection.id },
    authority: authority.success,
    runtime: {
      provider: projection.provider,
      readiness:
        projection.provider === "cloudflare" && stableWarm ? "unchecked" : "not-applicable",
    },
    capabilities: transitioning
      ? { checkpoint: false, sleep: false, resume: false, work: false, vaporize: false }
      : {
          checkpoint: stableWarm,
          sleep: stableWarm,
          resume:
            authority.success.lifecycle === "sleeping" ||
            (authority.success.lifecycle === "failed" && failure?.recoverable === true),
          work: stableWarm,
          vaporize: authority.success.lifecycle !== "gone",
        },
    display: {
      title: projection.title,
      repository: projection.repo,
      branch: projection.status === "gone" ? null : projection.branch,
      defaultBranch: projection.status === "gone" ? null : projection.defaultBranch,
    },
    times: { capRemainingSeconds: projection.capRemainingSeconds },
    projection: { projectedAt: projection.projectedAt },
  });
};

export const uiSessionListResponseFromProjections = (
  projections: ReadonlyArray<SessionView>,
): Result.Result<UiSessionListResponse, UiSessionProjectionInvalid> => {
  const sessions: UiSessionListItem[] = [];
  for (const projection of projections) {
    const session = uiSessionListItemFromProjection(projection);
    if (Result.isFailure(session)) return Result.fail(session.failure);
    sessions.push(session.success);
  }
  return Result.succeed({ version: 1, sessions });
};
