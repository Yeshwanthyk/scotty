import type { SessionAuthority, StableState } from "./authority";
import { accept, reject, warmFrom } from "./control";
import type { Decision } from "./decision";
import type { SessionActorInput } from "./input";
import { validStable } from "./validity";

type ActivityInput = Extract<SessionActorInput, { _tag: "ActivityObserved" }>;

export const handleActivity = (current: SessionAuthority, input: ActivityInput): Decision => {
  if (input.revision !== current.revision)
    return reject(input.revision < current.revision ? "duplicate" : "revision_mismatch");
  const warm = warmFrom(current);
  if (warm === undefined) return reject("not_admissible");
  if (
    input.expectedRuntimeGeneration !== warm.readiness.runtime.runtimeGeneration ||
    input.expectedSupervisorEpoch !== warm.readiness.supervisor.supervisorEpoch ||
    input.activity.supervisorEpoch !== warm.readiness.supervisor.supervisorEpoch
  )
    return reject("stale_generation");
  if (
    warm.activity !== null &&
    warm.activity.supervisorEpoch === input.activity.supervisorEpoch &&
    input.activity.piSequence <= warm.activity.piSequence
  )
    return reject("duplicate");
  if (
    Date.parse(input.activity.observedAt) > Date.parse(input.timestamp) ||
    Date.parse(input.activity.expiresAt) <= Date.parse(input.timestamp)
  )
    return reject("invalid_progress");
  const stable: StableState = { ...warm, activity: input.activity };
  if (!validStable(stable)) return reject("invalid_progress");
  return accept(
    current.revision,
    current.session,
    current.hardCap,
    { _tag: "Stable", stable },
    {
      timestamp: input.timestamp,
      correlationId: input.correlationId,
      transitionNonce: null,
      eventType: "activity_observed",
      transitionKind: null,
      transitionPhase: null,
      resultCode: "observed",
      causeAttempt: null,
    },
    [],
  );
};
