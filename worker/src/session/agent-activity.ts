import { Context, Effect } from "effect";
import type { SessionAuthority } from "../session-actor/authority";

export type TurnActivity = boolean | "unknown";

export class AgentTurnActivity extends Context.Service<
  AgentTurnActivity,
  {
    readonly isTurnActive: (authority: SessionAuthority) => Effect.Effect<TurnActivity>;
  }
>()("scotty/Session/AgentTurnActivity") {}

export const drainDecision = (
  now: number,
  drainAt: number,
  deadline: number,
  activity: TurnActivity,
): "wait" | "sleep" => {
  const forceAt = deadline - Math.min(5 * 60_000, (deadline - drainAt) / 2);
  return activity === true && now < forceAt ? "wait" : "sleep";
};
