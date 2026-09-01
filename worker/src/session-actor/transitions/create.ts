import { Context, Effect, Layer, Match, Predicate, Schema } from "effect";
import {
  AuthorityStateSchema,
  type RuntimeProof,
  RuntimeProofSchema,
  type SessionAuthority,
  type SupervisorProof,
  SupervisorProofSchema,
  type Transition,
  TransitionSchema,
  type TransportProof,
  TransportProofSchema,
} from "../authority";
import type { CommittedProviderEffectIntent } from "../effects";
import { ProviderEffectBoundaryFailure, ProviderEffectExecutor } from "../effects";
import type { SessionActorInput } from "../input";

export type CreateTransition = Extract<Transition, { readonly _tag: "Create" }>;
export type CreateProof = CreateTransition["proof"];

const CreatePrivatePayloadReferenceSchema = Schema.Struct({
  reference: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
});
export type CreatePrivatePayloadReference = typeof CreatePrivatePayloadReferenceSchema.Type;

export class CreateProviderFailure extends Schema.TaggedError<CreateProviderFailure>()(
  "CreateProviderFailure",
  {
    outcome: Schema.Literals(["rejected_before_admission", "unknown_after_admission"]),
    safeResultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    observedAt: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  },
) {}

const ProviderResultBase = {
  observedAt: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  resultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
};

export const CreateProviderResultSchema = Schema.Union([
  Schema.TaggedStruct("PayloadResolved", ProviderResultBase),
  Schema.TaggedStruct("WorkspacePrepared", {
    ...ProviderResultBase,
    workspaceId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  }),
  Schema.TaggedStruct("RuntimeMaterialized", {
    ...ProviderResultBase,
    runtime: RuntimeProofSchema,
  }),
  Schema.TaggedStruct("RuntimeReadyConfirmed", {
    ...ProviderResultBase,
    runtime: RuntimeProofSchema,
  }),
  Schema.TaggedStruct("SupervisorStarted", {
    ...ProviderResultBase,
    processId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  }),
  Schema.TaggedStruct("SupervisorReadyConfirmed", {
    ...ProviderResultBase,
    supervisor: SupervisorProofSchema,
  }),
  Schema.TaggedStruct("TransportVerified", {
    ...ProviderResultBase,
    transport: TransportProofSchema,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type CreateProviderResult = typeof CreateProviderResultSchema.Type;

export interface CreateProviderContext {
  readonly authority: SessionAuthority;
  readonly transition: CreateTransition;
  readonly payload: CreatePrivatePayloadReference;
}

export interface CreateTransitionProviderShape {
  readonly lookupPayload: (
    authority: SessionAuthority,
    transition: CreateTransition,
  ) => Effect.Effect<CreatePrivatePayloadReference, CreateProviderFailure>;
  readonly prepareWorkspace: (
    context: CreateProviderContext,
  ) => Effect.Effect<
    Extract<CreateProviderResult, { readonly _tag: "WorkspacePrepared" }>,
    CreateProviderFailure
  >;
  readonly materializeRuntime: (
    context: CreateProviderContext,
  ) => Effect.Effect<
    Extract<CreateProviderResult, { readonly _tag: "RuntimeMaterialized" }>,
    CreateProviderFailure
  >;
  readonly confirmRuntimeReady: (
    context: CreateProviderContext,
  ) => Effect.Effect<
    Extract<CreateProviderResult, { readonly _tag: "RuntimeReadyConfirmed" }>,
    CreateProviderFailure
  >;
  readonly startSupervisor: (
    context: CreateProviderContext,
  ) => Effect.Effect<
    Extract<CreateProviderResult, { readonly _tag: "SupervisorStarted" }>,
    CreateProviderFailure
  >;
  readonly confirmSupervisorReady: (
    context: CreateProviderContext,
  ) => Effect.Effect<
    Extract<CreateProviderResult, { readonly _tag: "SupervisorReadyConfirmed" }>,
    CreateProviderFailure
  >;
  readonly verifyTransport: (
    context: CreateProviderContext,
  ) => Effect.Effect<
    Extract<CreateProviderResult, { readonly _tag: "TransportVerified" }>,
    CreateProviderFailure
  >;
  readonly reconcile: (
    context: CreateProviderContext,
  ) => Effect.Effect<CreateProviderResult, CreateProviderFailure>;
}

export class CreateTransitionProvider extends Context.Service<
  CreateTransitionProvider,
  CreateTransitionProviderShape
>()("scotty/SessionActor/CreateTransitionProvider") {}

export const createTransitionProviderLayer = (
  provider: CreateTransitionProviderShape,
): Layer.Layer<CreateTransitionProvider> =>
  Layer.succeed(CreateTransitionProvider)(CreateTransitionProvider.of(provider));

const sameRuntime = (left: RuntimeProof, right: RuntimeProof): boolean =>
  left.providerRuntimeId === right.providerRuntimeId &&
  left.runtimeGeneration === right.runtimeGeneration &&
  left.containerIncarnation === right.containerIncarnation;

const supervisorMatchesRuntime = (supervisor: SupervisorProof, runtime: RuntimeProof): boolean =>
  supervisor.runtimeGeneration === runtime.runtimeGeneration &&
  supervisor.containerIncarnation === runtime.containerIncarnation;

const transportMatches = (
  transport: TransportProof,
  runtime: RuntimeProof,
  supervisor: SupervisorProof,
): boolean =>
  transport.runtimeGeneration === runtime.runtimeGeneration &&
  transport.containerIncarnation === runtime.containerIncarnation &&
  transport.supervisorEpoch === supervisor.supervisorEpoch;

const currentProviderRuntimeId = (transition: CreateTransition): string | null =>
  transition.proof.readiness.runtime?.providerRuntimeId ?? null;

const boundaryFailure = (
  committed: CommittedProviderEffectIntent,
  transition: CreateTransition,
  failure: CreateProviderFailure,
): ProviderEffectBoundaryFailure =>
  new ProviderEffectBoundaryFailure({
    expectedRevision: committed.authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    expectedProviderRuntimeId: currentProviderRuntimeId(transition),
    outcome: failure.outcome,
    safeResultCode: failure.safeResultCode,
    observedAt: failure.observedAt,
  });

const staleProof = (
  committed: CommittedProviderEffectIntent,
  transition: CreateTransition,
  observedAt: string,
): ProviderEffectBoundaryFailure =>
  boundaryFailure(
    committed,
    transition,
    new CreateProviderFailure({
      outcome: "rejected_before_admission",
      safeResultCode: "create_stale_provider_proof",
      observedAt,
    }),
  );

const factBase = (
  committed: CommittedProviderEffectIntent,
  transition: CreateTransition,
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
  transition: CreateTransition,
  nextPhase: CreateTransition["phase"],
  proof: CreateProof,
  observedAt: string,
  resultCode: string,
): SessionActorInput => ({
  _tag: "ProviderObservation",
  ...factBase(committed, transition, observedAt),
  expectedProviderRuntimeId: currentProviderRuntimeId(transition),
  nextPhase,
  proof,
  resultCode,
});

const completed = (
  committed: CommittedProviderEffectIntent,
  transition: CreateTransition,
  proof: CreateProof,
  observedAt: string,
  resultCode: string,
): SessionActorInput => ({
  _tag: "TransitionCompleted",
  ...factBase(committed, transition, observedAt),
  proof,
  resultCode,
});

const applyResult = (
  committed: CommittedProviderEffectIntent,
  transition: CreateTransition,
  result: CreateProviderResult,
): Effect.Effect<SessionActorInput, ProviderEffectBoundaryFailure> =>
  Match.valueTags(result, {
    PayloadResolved: (value) =>
      transition.phase === "IntentCommitted"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "WorkspacePreparing",
              transition.proof,
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    WorkspacePrepared: (value) =>
      transition.phase === "WorkspacePreparing"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "RuntimeMaterializing",
              { ...transition.proof, workspaceId: value.workspaceId },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    RuntimeMaterialized: (value) =>
      transition.phase === "RuntimeMaterializing"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "RuntimeReady",
              {
                ...transition.proof,
                readiness: { ...transition.proof.readiness, runtime: value.runtime },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    RuntimeReadyConfirmed: (value) => {
      const runtime = transition.proof.readiness.runtime;
      return transition.phase === "RuntimeReady" &&
        runtime !== null &&
        sameRuntime(value.runtime, runtime)
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "SupervisorStarting",
              transition.proof,
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
    SupervisorStarted: (value) => {
      const runtime = transition.proof.readiness.runtime;
      return transition.phase === "SupervisorStarting" &&
        runtime !== null &&
        value.processId.length > 0
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "SupervisorReady",
              transition.proof,
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
    SupervisorReadyConfirmed: (value) => {
      const runtime = transition.proof.readiness.runtime;
      return transition.phase === "SupervisorReady" &&
        runtime !== null &&
        supervisorMatchesRuntime(value.supervisor, runtime)
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "TransportVerifying",
              {
                ...transition.proof,
                readiness: { ...transition.proof.readiness, supervisor: value.supervisor },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
    TransportVerified: (value) => {
      const runtime = transition.proof.readiness.runtime;
      const supervisor = transition.proof.readiness.supervisor;
      if (
        transition.phase !== "TransportVerifying" ||
        runtime === null ||
        supervisor === null ||
        !transportMatches(value.transport, runtime, supervisor)
      )
        return Effect.fail(staleProof(committed, transition, value.observedAt));
      return Effect.succeed(
        completed(
          committed,
          transition,
          {
            ...transition.proof,
            readiness: { ...transition.proof.readiness, transport: value.transport },
          },
          value.observedAt,
          value.resultCode,
        ),
      );
    },
  });

const dispatch = (
  provider: CreateTransitionProvider["Service"],
  context: CreateProviderContext,
): Effect.Effect<CreateProviderResult, CreateProviderFailure> =>
  Match.value(context.transition.phase).pipe(
    Match.when("IntentCommitted", () =>
      Effect.succeed({
        _tag: "PayloadResolved" as const,
        observedAt: context.transition.lastProgressAt,
        resultCode: "create_payload_resolved",
      }),
    ),
    Match.when("WorkspacePreparing", () => provider.prepareWorkspace(context)),
    Match.when("RuntimeMaterializing", () => provider.materializeRuntime(context)),
    Match.when("RuntimeReady", () => provider.confirmRuntimeReady(context)),
    Match.when("SupervisorStarting", () => provider.startSupervisor(context)),
    Match.when("SupervisorReady", () => provider.confirmSupervisorReady(context)),
    Match.when("TransportVerifying", () => provider.verifyTransport(context)),
    Match.exhaustive,
  );

export const executeCreateTransition = Effect.fnUntraced(function* (
  provider: CreateTransitionProvider["Service"],
  committed: CommittedProviderEffectIntent,
) {
  if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state))
    return yield* Effect.fail(
      new ProviderEffectBoundaryFailure({
        expectedRevision: committed.authority.revision,
        transitionNonce: committed.intent.transitionNonce,
        attempt: committed.intent.attempt,
        expectedPhase: committed.intent.phase,
        expectedProviderRuntimeId: null,
        outcome: "rejected_before_admission",
        safeResultCode: "create_authority_not_transitioning",
        observedAt: committed.journalEvent.timestamp,
      }),
    );
  const transition = committed.authority.state.transition;
  if (!TransitionSchema.guards.Create(transition))
    return yield* Effect.fail(
      new ProviderEffectBoundaryFailure({
        expectedRevision: committed.authority.revision,
        transitionNonce: committed.intent.transitionNonce,
        attempt: committed.intent.attempt,
        expectedPhase: committed.intent.phase,
        expectedProviderRuntimeId: null,
        outcome: "rejected_before_admission",
        safeResultCode: "create_transition_not_supported",
        observedAt: committed.journalEvent.timestamp,
      }),
    );
  if (
    committed.intent.transitionKind !== "Create" ||
    committed.intent.transitionNonce !== transition.nonce ||
    committed.intent.attempt !== transition.attempt ||
    committed.intent.phase !== transition.phase
  )
    return yield* Effect.fail(
      boundaryFailure(
        committed,
        transition,
        new CreateProviderFailure({
          outcome: "rejected_before_admission",
          safeResultCode: "create_intent_fence_mismatch",
          observedAt: committed.journalEvent.timestamp,
        }),
      ),
    );
  const payload = yield* provider
    .lookupPayload(committed.authority, transition)
    .pipe(Effect.mapError((failure) => boundaryFailure(committed, transition, failure)));
  const context = { authority: committed.authority, transition, payload };
  const result = yield* (
    Predicate.isTagged(committed.intent, "ReconcileTransition")
      ? provider.reconcile(context)
      : dispatch(provider, context)
  ).pipe(Effect.mapError((failure) => boundaryFailure(committed, transition, failure)));
  return yield* applyResult(committed, transition, result);
});

export const createProviderEffectExecutorLayer: Layer.Layer<
  ProviderEffectExecutor,
  never,
  CreateTransitionProvider
> = Layer.effect(
  ProviderEffectExecutor,
  Effect.map(CreateTransitionProvider, (provider) =>
    ProviderEffectExecutor.of({
      execute: (committed) => executeCreateTransition(provider, committed),
    }),
  ),
);
