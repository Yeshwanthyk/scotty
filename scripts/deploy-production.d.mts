import type { ContainerControlPlaneSnapshot } from "./container-control-plane.mjs";

export const CONTAINER_ROLLOUT_TIMEOUT_MS: number;
export const CONTAINER_ROLLOUT_POLL_MS: number;
export const CONTAINER_ROLLOUT_ABSENCE_QUIET_MS: number;

export type ContainerSettlementAssessment =
  | { readonly status: "waiting"; readonly message: string }
  | { readonly status: "settled"; readonly outcome: string; readonly message: string }
  | { readonly status: "failed"; readonly message: string };

export declare function assertSettledContainerBaseline(
  snapshot: ContainerControlPlaneSnapshot,
): void;

export declare function assessContainerSettlement(
  before: ContainerControlPlaneSnapshot,
  current: ContainerControlPlaneSnapshot,
  containerAction: "updated" | "noop" | "unknown",
  options?: { readonly quietMs?: number },
): ContainerSettlementAssessment;
