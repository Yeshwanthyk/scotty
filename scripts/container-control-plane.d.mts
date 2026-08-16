import type { Effect } from "effect";
import type { CloudflareEnvironment } from "alchemy/Cloudflare";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export interface ContainerControlPlaneHealthInstances {
  readonly active: number;
  readonly assigned: number;
  readonly healthy: number;
  readonly stopped: number;
  readonly failed: number;
  readonly scheduling: number;
  readonly starting: number;
}

export interface ContainerControlPlaneRolloutHealthInstances {
  readonly healthy: number;
  readonly failed: number;
  readonly scheduling: number;
  readonly starting: number;
}

export interface ContainerControlPlaneRolloutProgress {
  readonly totalSteps: number;
  readonly currentStep: number;
  readonly updatedInstances: number;
  readonly totalInstances: number;
}

export interface ContainerControlPlaneRollout {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly health: ContainerControlPlaneRolloutHealthInstances;
  readonly progress: ContainerControlPlaneRolloutProgress;
}

export interface ContainerControlPlaneApplication {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly activeRolloutId: string | null;
  readonly configurationDigest: string;
  readonly health: ContainerControlPlaneHealthInstances;
}

export interface ContainerControlPlaneSnapshot {
  readonly application: ContainerControlPlaneApplication;
  readonly rollouts: ReadonlyArray<ContainerControlPlaneRollout>;
}

export declare const readControlPlaneEffect: (input: {
  readonly accountId?: string;
  readonly applicationId: string;
}) => Effect.Effect<
  ContainerControlPlaneSnapshot,
  unknown,
  typeof Credentials | typeof CloudflareEnvironment
>;

export declare const readContainerControlPlane: (input: {
  readonly accountId?: string;
  readonly applicationId: string;
}) => Promise<ContainerControlPlaneSnapshot>;

export declare const parseContainerControlPlaneSnapshot: (
  output: string,
) => Promise<ContainerControlPlaneSnapshot>;
