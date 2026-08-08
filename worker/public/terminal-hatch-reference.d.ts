export interface BrowserHatchPaths {
  readonly status: string;
  readonly open: string;
  readonly stop: string;
  readonly wake: string;
}

export interface BrowserHatchReference {
  readonly kind: "hatch";
  readonly version: 1;
  readonly hatchId: string;
  readonly paths: BrowserHatchPaths;
}

export interface UnavailableBrowserHatchReference {
  readonly kind: "unavailable";
}

export interface BrowserHatchStatus {
  readonly version: 1;
  readonly status: "configured";
  readonly hatchId: string;
  readonly generation: number;
  readonly service: { readonly name: string; readonly port: number };
  readonly desiredStatus: "open" | "closed";
  readonly observedStatus: "starting" | "running" | "sleeping" | "unhealthy" | "stopped" | "failed";
  readonly exposure: "not_exposed" | "active" | "unexpose_pending" | "closed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHealthyAt?: string;
}

export function browserHatchPaths(
  sessionId: string,
  hatchId: string,
): BrowserHatchPaths | undefined;

export function browserHatchReference(
  tool: unknown,
  sessionId: string,
): BrowserHatchReference | UnavailableBrowserHatchReference | undefined;

export function browserHatchStatus(
  value: unknown,
  reference: BrowserHatchReference,
): BrowserHatchStatus | undefined;

export function hatchStatusLabel(status: BrowserHatchStatus | undefined): string;
export function hatchStatusCopy(status: BrowserHatchStatus): string;
export function hatchActions(status: BrowserHatchStatus): {
  readonly open: boolean;
  readonly verify: true;
  readonly wakeAndOpen: boolean;
  readonly stop: boolean;
};
