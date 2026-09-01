import { Result, Schema } from "effect";
import {
  CheckpointPhaseSchema,
  CreatePhaseSchema,
  ResumePhaseSchema,
  SleepPhaseSchema,
  VaporizePhaseSchema,
  WarmWorkPhaseSchema,
} from "./authority";
import type { JournalEvent } from "./decision";

const SafeTextSchema = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const SafeTimestampSchema = Schema.NonEmptyString.check(Schema.isMaxLength(64));
const TransitionKindSchema = Schema.Literals([
  "Create",
  "Checkpoint",
  "Sleep",
  "Resume",
  "WarmWork",
  "Vaporize",
]);
const TransitionPhaseSchema = Schema.Union([
  CreatePhaseSchema,
  CheckpointPhaseSchema,
  SleepPhaseSchema,
  ResumePhaseSchema,
  WarmWorkPhaseSchema,
  VaporizePhaseSchema,
]);

export const LifecycleJournalEventSchema = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  timestamp: SafeTimestampSchema,
  correlationId: SafeTextSchema,
  transitionNonce: Schema.NullOr(SafeTextSchema),
  eventType: Schema.Literals([
    "admitted",
    "progressed",
    "completed",
    "deadline_reconciling",
    "provider_reconciling",
    "activity_observed",
    "runtime_observed",
    "availability_lost",
    "hard_cap_elapsed",
  ]),
  transitionKind: Schema.NullOr(TransitionKindSchema),
  transitionPhase: Schema.NullOr(TransitionPhaseSchema),
  resultCode: SafeTextSchema,
  causeSequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  causeAttempt: Schema.NullOr(SafeTextSchema),
});
export type LifecycleJournalEvent = typeof LifecycleJournalEventSchema.Type;

export const decodeLifecycleJournalEvent = Schema.decodeUnknownResult(LifecycleJournalEventSchema, {
  onExcessProperty: "error",
});

export const makeLifecycleJournalEvent = (
  sequence: number,
  revision: number,
  event: JournalEvent,
  causeSequence: number | null,
): Result.Result<LifecycleJournalEvent, "invalid_journal_event"> => {
  const decoded = decodeLifecycleJournalEvent({
    sequence,
    revision,
    ...event,
    causeSequence,
  });
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail("invalid_journal_event");
};
