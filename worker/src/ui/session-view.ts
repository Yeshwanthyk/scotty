import { Match, Predicate, Schema } from "effect";
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
const UiSessionOriginSchema = Schema.Literals(["absent", "warm", "sleeping", "failed", "gone"]);

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
    origin: UiSessionOriginSchema,
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

export const UiSessionResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  session: Schema.Struct({
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
  }),
});
export type UiSessionResponse = typeof UiSessionResponseSchema.Type;

const lowerOrigin = (
  origin: "Absent" | "Warm" | "Sleeping" | "Failed" | "Gone",
): "absent" | "warm" | "sleeping" | "failed" | "gone" =>
  (
    ({
      Absent: "absent",
      Warm: "warm",
      Sleeping: "sleeping",
      Failed: "failed",
      Gone: "gone",
    }) as const
  )[origin];

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
      origin: lowerOrigin(transition.origin),
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
  const provider = authority.session.execution.provider;
  const stableWarm =
    Predicate.isTagged(authority.state, "Stable") &&
    Predicate.isTagged(authority.state.stable, "Warm");
  return {
    version: 1,
    session: {
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
    },
  };
};
