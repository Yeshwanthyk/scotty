import { Context, Effect, Layer, Match, Schema } from "effect";
import type { VaporizeAbsenceCategory, Transition } from "../authority";
import { AuthorityStateSchema, TransitionSchema } from "../authority";
import type { CommittedProviderEffectIntent } from "../effects";
import { ProviderEffectBoundaryFailure } from "../effects";
import type { SessionActorInput } from "../input";

export type VaporizeTransition = Extract<Transition, { readonly _tag: "Vaporize" }>;

export class VaporizeProviderFailure extends Schema.TaggedError<VaporizeProviderFailure>()(
  "VaporizeProviderFailure",
  {
    outcome: Schema.Literals(["rejected_before_admission", "unknown_after_admission"]),
    safeResultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    observedAt: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  },
) {}

const ResultBase = {
  observedAt: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  resultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
};

export const VaporizeProviderResultSchema = Schema.Union([
  Schema.TaggedStruct("RuntimeAccessRevoked", ResultBase),
  Schema.TaggedStruct("HatchAbsent", ResultBase),
  Schema.TaggedStruct("EvidenceInterrupted", ResultBase),
  Schema.TaggedStruct("RuntimeAbsent", ResultBase),
  Schema.TaggedStruct("BackupsAbsent", ResultBase),
  Schema.TaggedStruct("EvidenceAbsent", ResultBase),
  Schema.TaggedStruct("GrantsReleased", ResultBase),
  Schema.TaggedStruct("AbsenceConfirmed", ResultBase),
]).pipe(Schema.toTaggedUnion("_tag"));
export type VaporizeProviderResult = typeof VaporizeProviderResultSchema.Type;

export interface VaporizeProviderContext {
  readonly authority: CommittedProviderEffectIntent["authority"];
  readonly transition: VaporizeTransition;
}

export interface VaporizeTransitionProviderShape {
  readonly revokeRuntimeAccess: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
  readonly closeHatch: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
  readonly interruptEvidence: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
  readonly destroyRuntime: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
  readonly deleteBackups: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
  readonly deleteEvidence: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
  readonly releaseGrants: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
  readonly confirmAbsence: (
    context: VaporizeProviderContext,
  ) => Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure>;
}

export class VaporizeTransitionProvider extends Context.Service<
  VaporizeTransitionProvider,
  VaporizeTransitionProviderShape
>()("scotty/SessionActor/VaporizeTransitionProvider") {}

export const vaporizeTransitionProviderLayer = (
  provider: VaporizeTransitionProviderShape,
): Layer.Layer<VaporizeTransitionProvider> =>
  Layer.succeed(VaporizeTransitionProvider)(VaporizeTransitionProvider.of(provider));

const boundaryFailure = (
  committed: CommittedProviderEffectIntent,
  transition: VaporizeTransition,
  failure: VaporizeProviderFailure,
): ProviderEffectBoundaryFailure =>
  new ProviderEffectBoundaryFailure({
    expectedRevision: committed.authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    expectedProviderRuntimeId: null,
    outcome: failure.outcome,
    safeResultCode: failure.safeResultCode,
    observedAt: failure.observedAt,
  });

const addAbsent = (
  transition: VaporizeTransition,
  observedAt: string,
  categories: ReadonlyArray<VaporizeAbsenceCategory>,
): VaporizeTransition["proof"] => ({
  ...transition.proof,
  cleanup: {
    absent: [...new Set([...transition.proof.cleanup.absent, ...categories])],
    lastObservedAt: observedAt,
  },
});

const factBase = (
  committed: CommittedProviderEffectIntent,
  transition: VaporizeTransition,
  observedAt: string,
) => ({
  revision: committed.authority.revision,
  transitionNonce: transition.nonce,
  attempt: transition.attempt,
  expectedPhase: transition.phase,
  timestamp: observedAt,
  correlationId: committed.journalEvent.correlationId,
});

const progress = (
  committed: CommittedProviderEffectIntent,
  transition: VaporizeTransition,
  nextPhase: VaporizeTransition["phase"],
  proof: VaporizeTransition["proof"],
  result: VaporizeProviderResult,
): SessionActorInput => ({
  _tag: "ProviderObservation",
  ...factBase(committed, transition, result.observedAt),
  expectedProviderRuntimeId: null,
  nextPhase,
  proof,
  resultCode: result.resultCode,
});

const complete = (
  committed: CommittedProviderEffectIntent,
  transition: VaporizeTransition,
  result: VaporizeProviderResult,
): SessionActorInput => ({
  _tag: "TransitionCompleted",
  ...factBase(committed, transition, result.observedAt),
  proof: addAbsent(transition, result.observedAt, ["schedules"]),
  resultCode: result.resultCode,
});

const staleResult = (
  committed: CommittedProviderEffectIntent,
  transition: VaporizeTransition,
  result: VaporizeProviderResult,
): Effect.Effect<never, ProviderEffectBoundaryFailure> =>
  Effect.fail(
    boundaryFailure(
      committed,
      transition,
      new VaporizeProviderFailure({
        outcome: "rejected_before_admission",
        safeResultCode: "vaporize_stale_provider_proof",
        observedAt: result.observedAt,
      }),
    ),
  );

const applyResult = (
  committed: CommittedProviderEffectIntent,
  transition: VaporizeTransition,
  result: VaporizeProviderResult,
): Effect.Effect<SessionActorInput, ProviderEffectBoundaryFailure> =>
  Match.valueTags(result, {
    RuntimeAccessRevoked: (value) =>
      transition.phase === "Admitted"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "RuntimeAccessRevoked",
              { ...transition.proof, revokedAt: value.observedAt },
              value,
            ),
          )
        : staleResult(committed, transition, value),
    HatchAbsent: (value) =>
      transition.phase === "RuntimeAccessRevoked"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "HatchClosing",
              addAbsent(transition, value.observedAt, ["hatch"]),
              value,
            ),
          )
        : staleResult(committed, transition, value),
    EvidenceInterrupted: (value) =>
      transition.phase === "HatchClosing"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "EvidenceInterrupting",
              addAbsent(transition, value.observedAt, []),
              value,
            ),
          )
        : staleResult(committed, transition, value),
    RuntimeAbsent: (value) =>
      transition.phase === "EvidenceInterrupting"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "RuntimeDestroying",
              addAbsent(transition, value.observedAt, ["runtime"]),
              value,
            ),
          )
        : staleResult(committed, transition, value),
    BackupsAbsent: (value) =>
      transition.phase === "RuntimeDestroying"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "BackupsDeleting",
              addAbsent(transition, value.observedAt, ["backups"]),
              value,
            ),
          )
        : staleResult(committed, transition, value),
    EvidenceAbsent: (value) =>
      transition.phase === "BackupsDeleting"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "EvidenceDeleting",
              addAbsent(transition, value.observedAt, ["evidence"]),
              value,
            ),
          )
        : staleResult(committed, transition, value),
    GrantsReleased: (value) =>
      transition.phase === "EvidenceDeleting"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "GrantsReleasing",
              addAbsent(transition, value.observedAt, ["grants", "idempotency"]),
              value,
            ),
          )
        : staleResult(committed, transition, value),
    AbsenceConfirmed: (value) =>
      transition.phase === "GrantsReleasing"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "AbsenceConfirming",
              addAbsent(transition, value.observedAt, []),
              value,
            ),
          )
        : transition.phase === "AbsenceConfirming"
          ? Effect.succeed(complete(committed, transition, value))
          : staleResult(committed, transition, value),
  });

const executePhase = (
  provider: VaporizeTransitionProviderShape,
  context: VaporizeProviderContext,
): Effect.Effect<VaporizeProviderResult, VaporizeProviderFailure> =>
  Match.value(context.transition.phase).pipe(
    Match.when("Admitted", () => provider.revokeRuntimeAccess(context)),
    Match.when("RuntimeAccessRevoked", () => provider.closeHatch(context)),
    Match.when("HatchClosing", () => provider.interruptEvidence(context)),
    Match.when("EvidenceInterrupting", () => provider.destroyRuntime(context)),
    Match.when("RuntimeDestroying", () => provider.deleteBackups(context)),
    Match.when("BackupsDeleting", () => provider.deleteEvidence(context)),
    Match.when("EvidenceDeleting", () => provider.releaseGrants(context)),
    Match.when("GrantsReleasing", () => provider.confirmAbsence(context)),
    Match.when("AbsenceConfirming", () => provider.confirmAbsence(context)),
    Match.exhaustive,
  );

export const executeVaporizeTransition = (
  provider: VaporizeTransitionProviderShape,
  committed: CommittedProviderEffectIntent,
): Effect.Effect<SessionActorInput, ProviderEffectBoundaryFailure> => {
  if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state))
    return Effect.fail(
      new ProviderEffectBoundaryFailure({
        expectedRevision: committed.authority.revision,
        transitionNonce: committed.intent.transitionNonce,
        attempt: committed.intent.attempt,
        expectedPhase: committed.intent.phase,
        expectedProviderRuntimeId: null,
        outcome: "rejected_before_admission",
        safeResultCode: "vaporize_authority_not_transitioning",
        observedAt: committed.journalEvent.timestamp,
      }),
    );
  const transition = committed.authority.state.transition;
  if (!TransitionSchema.guards.Vaporize(transition))
    return Effect.fail(
      new ProviderEffectBoundaryFailure({
        expectedRevision: committed.authority.revision,
        transitionNonce: committed.intent.transitionNonce,
        attempt: committed.intent.attempt,
        expectedPhase: committed.intent.phase,
        expectedProviderRuntimeId: null,
        outcome: "rejected_before_admission",
        safeResultCode: "vaporize_transition_mismatch",
        observedAt: committed.journalEvent.timestamp,
      }),
    );
  return executePhase(provider, { authority: committed.authority, transition }).pipe(
    Effect.mapError((failure) => boundaryFailure(committed, transition, failure)),
    Effect.flatMap((result) => applyResult(committed, transition, result)),
  );
};
