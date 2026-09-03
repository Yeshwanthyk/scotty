import { Context, Effect, Layer, Schema } from "effect";
import type { SessionAuthority } from "./authority";
import type { EffectIntent } from "./decision";
import type { SessionActorInput } from "./input";
import type { LifecycleJournalEvent } from "./journal";

export type ProviderEffectIntent = Exclude<
  EffectIntent,
  { readonly _tag: "ArmDeadline" | "ArmReconciliation" }
>;

export interface CommittedEffectIntent {
  readonly authority: SessionAuthority;
  readonly journalEvent: LifecycleJournalEvent;
  readonly intent: EffectIntent;
}

export interface CommittedProviderEffectIntent extends CommittedEffectIntent {
  readonly intent: ProviderEffectIntent;
}

export type EffectObservation =
  | { readonly _tag: "NoObservation" }
  | { readonly _tag: "Observation"; readonly input: SessionActorInput };

export class ProviderEffectBoundaryFailure extends Schema.TaggedError<ProviderEffectBoundaryFailure>()(
  "ProviderEffectBoundaryFailure",
  {
    expectedRevision: Schema.Int,
    transitionNonce: Schema.String,
    attempt: Schema.String,
    expectedPhase: Schema.String,
    expectedProviderRuntimeId: Schema.NullOr(Schema.String),
    outcome: Schema.Literals(["rejected_before_admission", "unknown_after_admission"]),
    safeResultCode: Schema.String,
    observedAt: Schema.String,
  },
) {}

interface ProviderEffectExecutorShape {
  readonly execute: (
    committed: CommittedProviderEffectIntent,
  ) => Effect.Effect<SessionActorInput, ProviderEffectBoundaryFailure>;
}

export class ProviderEffectExecutor extends Context.Service<
  ProviderEffectExecutor,
  ProviderEffectExecutorShape
>()("scotty/SessionActor/ProviderEffectExecutor") {}

export const providerEffectExecutorLayer = (
  execute: ProviderEffectExecutorShape["execute"],
): Layer.Layer<ProviderEffectExecutor> =>
  Layer.succeed(ProviderEffectExecutor)(ProviderEffectExecutor.of({ execute }));
