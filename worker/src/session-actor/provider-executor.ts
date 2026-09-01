import { Effect, Layer, Match } from "effect";
import { AuthorityStateSchema } from "./authority";
import {
  ProviderEffectBoundaryFailure,
  ProviderEffectExecutor,
  type CommittedProviderEffectIntent,
} from "./effects";
import { CreateTransitionProvider, executeCreateTransition } from "./transitions/create";
import {
  CheckpointTransitionProvider,
  executeCheckpointTransition,
} from "./transitions/checkpoint";
import { ResumeTransitionProvider, executeResumeTransition } from "./transitions/resume";
import { SleepTransitionProvider, executeSleepTransition } from "./transitions/sleep";

const unsupported = (
  committed: CommittedProviderEffectIntent,
  resultCode: string,
): ProviderEffectBoundaryFailure =>
  new ProviderEffectBoundaryFailure({
    expectedRevision: committed.authority.revision,
    transitionNonce: committed.intent.transitionNonce,
    attempt: committed.intent.attempt,
    expectedPhase: committed.intent.phase,
    expectedProviderRuntimeId: null,
    outcome: "rejected_before_admission",
    safeResultCode: resultCode,
    observedAt: committed.journalEvent.timestamp,
  });

export const sessionProviderEffectExecutorLayer: Layer.Layer<
  ProviderEffectExecutor,
  never,
  | CreateTransitionProvider
  | CheckpointTransitionProvider
  | SleepTransitionProvider
  | ResumeTransitionProvider
> = Layer.effect(
  ProviderEffectExecutor,
  Effect.gen(function* () {
    const create = yield* CreateTransitionProvider;
    const checkpoint = yield* CheckpointTransitionProvider;
    const sleep = yield* SleepTransitionProvider;
    const resume = yield* ResumeTransitionProvider;
    return ProviderEffectExecutor.of({
      execute: (committed) => {
        if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state))
          return Effect.fail(unsupported(committed, "authority_not_transitioning"));
        return Match.valueTags(committed.authority.state.transition, {
          Create: () => executeCreateTransition(create, committed),
          Checkpoint: () => executeCheckpointTransition(checkpoint, committed),
          Sleep: () => executeSleepTransition(sleep, committed),
          Resume: () => executeResumeTransition(resume, committed),
          WarmWork: () => Effect.fail(unsupported(committed, "warm_work_not_implemented")),
          Vaporize: () => Effect.fail(unsupported(committed, "vaporize_not_implemented")),
        });
      },
    });
  }),
);
