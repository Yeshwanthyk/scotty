import { Context, Effect, Layer, Schema } from "effect";

export interface ActorAlarmFence {
  readonly kind: "deadline" | "reconcile";
  readonly alarmId: string;
  readonly revision: number;
  readonly transitionNonce: string;
  readonly attempt: string;
  readonly expectedPhase: string;
  readonly expectedDeadlineAt: string;
  readonly correlationId: string;
}

export const actorAlarmId = (
  kind: ActorAlarmFence["kind"],
  transitionNonce: string,
  attempt: string,
  deadlineAt: string,
  expectedPhase?: string,
): string =>
  kind === "deadline"
    ? `${transitionNonce}:${attempt}:${deadlineAt}`
    : `${transitionNonce}:${attempt}:reconcile:${expectedPhase ?? "unknown"}:${deadlineAt}`;

export class ActorAlarmOutcomeUnknown extends Schema.TaggedError<ActorAlarmOutcomeUnknown>()(
  "ActorAlarmOutcomeUnknown",
  {
    alarmId: Schema.String,
    transitionNonce: Schema.String,
    attempt: Schema.String,
  },
) {}

interface ActorAlarmSchedulerShape {
  readonly arm: (fence: ActorAlarmFence) => Effect.Effect<void, ActorAlarmOutcomeUnknown>;
}

export class ActorAlarmScheduler extends Context.Service<
  ActorAlarmScheduler,
  ActorAlarmSchedulerShape
>()("scotty/SessionActor/AlarmScheduler") {}

export const actorAlarmSchedulerLayer = (
  arm: ActorAlarmSchedulerShape["arm"],
): Layer.Layer<ActorAlarmScheduler> =>
  Layer.succeed(ActorAlarmScheduler)(ActorAlarmScheduler.of({ arm }));
