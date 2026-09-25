import { Context, Effect, Result, Schema } from "effect";
import { isSidecarSelection } from "../../../protocol/agents/agents";
import type { SidecarAgentSelection } from "../../../protocol/agents/agent-selection";
import { PI_CONSOLE_MAX_RESPONSE_BYTES } from "../../../protocol/agents/pi/pi-console";
import { readSidecarSandbox } from "../agent/sidecar/client";
import { PI_SESSION_PORT } from "../sandbox/auth";
import { SandboxRuntime } from "../sandbox/runtime";
import {
  AuthorityStateSchema,
  StableStateSchema,
  TransitionSchema,
  type ReadinessProof,
  type SessionAuthority,
} from "../session-actor/authority";
import { SessionActorMetadataStore } from "../session-actor/metadata-store";

export type TurnActivity = boolean | "unknown";

export class AgentTurnActivity extends Context.Service<
  AgentTurnActivity,
  {
    readonly isTurnActive: (authority: SessionAuthority) => Effect.Effect<TurnActivity>;
  }
>()("scotty/Session/AgentTurnActivity") {}

const decodePiTurnActivity = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ state: Schema.Struct({ isStreaming: Schema.Boolean }) })),
  { onExcessProperty: "ignore" },
);

// Evidence and Hatch lease the warm runtime without replacing its readiness.
// Message admission still retains its Stable/Warm authority fence.
export const sidecarConversationReadiness = (
  authority: SessionAuthority,
): ReadinessProof | null => {
  if (AuthorityStateSchema.guards.Stable(authority.state))
    return StableStateSchema.guards.Warm(authority.state.stable)
      ? authority.state.stable.readiness
      : null;
  const transition = authority.state.transition;
  return TransitionSchema.guards.WarmWork(transition) &&
    (transition.workKind === "Evidence" || transition.workKind === "Hatch")
    ? transition.proof.readiness
    : null;
};

const sidecarTurnActivity = Effect.fnUntraced(function* (
  authority: SessionAuthority,
  selection: SidecarAgentSelection,
) {
  const readiness = sidecarConversationReadiness(authority);
  if (readiness === null) return "unknown";
  const metadata = yield* (yield* SessionActorMetadataStore).read(authority);
  const control = metadata?.sidecarControl;
  if (control === undefined) return "unknown";
  const snapshot = yield* readSidecarSandbox(
    {
      sessionId: authority.session.id,
      generation: readiness.runtime.runtimeGeneration,
      selection,
      token: control.token,
    },
    readiness.supervisor.supervisorEpoch,
  );
  return snapshot.prompt.status === "admitting" || snapshot.prompt.status === "running";
});

const piTurnActivity = Effect.fnUntraced(function* () {
  const response = yield* (yield* SandboxRuntime).fetchPortBody(
    "/snapshot",
    PI_SESSION_PORT,
    "GET",
    PI_CONSOLE_MAX_RESPONSE_BYTES,
  );
  if (response.status !== 200) return "unknown";
  const decoded = decodePiTurnActivity(response.body);
  return Result.isSuccess(decoded) ? decoded.success.state.isStreaming : "unknown";
});

export const readAgentTurnActivity = Effect.fnUntraced(function* (authority: SessionAuthority) {
  const selection = authority.session.selection;
  const activity: TurnActivity = yield* isSidecarSelection(selection)
    ? sidecarTurnActivity(authority, selection)
    : piTurnActivity();
  return activity;
});

// Sleep needs time to create and restore-verify its backup before the deadline.
export const HARD_CAP_SLEEP_RESERVE_MS = 3 * 60_000;

export const drainDecision = (
  now: number,
  drainAt: number,
  deadline: number,
  activity: TurnActivity,
): "wait" | "sleep" => {
  const reserve = Math.max(
    Math.min(5 * 60_000, (deadline - drainAt) / 2),
    HARD_CAP_SLEEP_RESERVE_MS,
  );
  const forceAt = Math.max(drainAt, deadline - reserve);
  return activity === true && now < forceAt ? "wait" : "sleep";
};
