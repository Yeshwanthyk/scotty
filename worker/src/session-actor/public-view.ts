import { Match } from "effect";
import type { SessionAuthority, StableState, Transition } from "./authority";

export type PublicStatus = "booting" | "warm" | "sleeping" | "failed" | "gone";
export type PublicAction = "checkpoint" | "sleep" | "resume" | "work" | "vaporize";

export interface PublicSessionView {
  readonly status: PublicStatus;
  readonly deleting: boolean;
  readonly availableActions: ReadonlyArray<PublicAction>;
}

const stableStatus = (stable: StableState): PublicStatus =>
  Match.valueTags(stable, {
    Warm: (): PublicStatus => "warm",
    Sleeping: (): PublicStatus => "sleeping",
    Failed: (): PublicStatus => "failed",
    Gone: (): PublicStatus => "gone",
  });

const originStatus = (origin: Transition["origin"]): PublicStatus =>
  origin === "Absent"
    ? "booting"
    : ({ Warm: "warm", Sleeping: "sleeping", Failed: "failed", Gone: "gone" } as const)[origin];

const transitionStatus = (transition: Transition): PublicStatus =>
  Match.valueTags(transition, {
    Create: (): PublicStatus => "booting",
    Resume: (): PublicStatus => "booting",
    Checkpoint: (value) => originStatus(value.origin),
    Sleep: (value) => originStatus(value.origin),
    WarmWork: (value) => originStatus(value.origin),
    Vaporize: (value) => originStatus(value.origin),
  });

const actions = (
  status: PublicStatus,
  deleting: boolean,
  actionableFailure: boolean,
): ReadonlyArray<PublicAction> => {
  if (deleting || status === "gone" || status === "booting") return [];
  if (status === "warm") return ["checkpoint", "sleep", "work", "vaporize"];
  if (status === "sleeping") return ["resume", "vaporize"];
  return actionableFailure ? ["resume", "vaporize"] : ["vaporize"];
};

export const publicView = (
  authority: SessionAuthority | undefined,
): PublicSessionView | undefined => {
  if (authority === undefined) return undefined;
  return Match.valueTags(authority.state, {
    Stable: ({ stable }) => {
      const status = stableStatus(stable);
      const actionableFailure = Match.valueTags(stable, {
        Warm: () => false,
        Sleeping: () => false,
        Failed: ({ actionable }) => actionable,
        Gone: () => false,
      });
      return {
        status,
        deleting: false,
        availableActions: actions(status, false, actionableFailure),
      };
    },
    Transitioning: ({ transition }) => {
      const status = transitionStatus(transition);
      const deleting = Match.valueTags(transition, {
        Create: () => false,
        Checkpoint: () => false,
        Sleep: () => false,
        Resume: () => false,
        WarmWork: () => false,
        Vaporize: () => true,
      });
      return { status, deleting, availableActions: actions(status, deleting, false) };
    },
  });
};
