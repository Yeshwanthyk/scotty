import type { Artifact } from "./artifacts.js";

export interface SummaryProjection {
  readonly update: string;
  readonly artifacts: ReadonlyArray<Artifact & { readonly reference: string }>;
}

export interface SummaryEvidence {
  readonly jobId: string;
  readonly status: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly frameCount: number;
  readonly failure?: {
    readonly code: string;
    readonly step?: number;
  };
  readonly video?: {
    readonly artifactId: "recording";
    readonly sha256: string;
    readonly bytes: number;
    readonly capturedAt: string;
    readonly offsetMillis: number;
  };
  readonly steps: ReadonlyArray<{
    readonly index: number;
    readonly name: string;
    readonly status: "passed" | "failed";
    readonly assertions: ReadonlyArray<{ readonly passed: boolean }>;
    readonly frame?: { readonly frameId: string; readonly offsetMillis: number };
  }>;
}

export type SummaryHatch =
  | { readonly configured: false; readonly available: false }
  | {
      readonly configured: true;
      readonly hatchId: string;
      readonly serviceName: string;
      readonly desiredStatus: "open" | "closed";
      readonly observedStatus:
        | "starting"
        | "running"
        | "sleeping"
        | "unhealthy"
        | "stopped"
        | "failed";
      readonly exposure: "not_exposed" | "active" | "unexpose_pending" | "closed";
      readonly available: boolean;
    };

export declare function extractSummaryReferences(text: string): ReadonlyArray<string>;
export declare function summaryProjection(
  projection: unknown,
  sessionId: string,
): SummaryProjection;
export declare function decodeSummaryEvidence(
  value: unknown,
  jobId: string,
): SummaryEvidence | undefined;
export declare function decodeSummaryHatch(value: unknown): SummaryHatch | undefined;
export declare function createEvidenceLoader<T>(
  load: (sessionId: string, jobId: string) => Promise<T | undefined>,
): {
  readonly current: (sessionId: string, jobId: string) => T | undefined;
  readonly load: (sessionId: string, jobId: string) => Promise<T | undefined>;
  readonly reset: () => void;
};
export declare function createHatchStatusLoader<T>(load: (sessionId: string) => Promise<T>): {
  readonly current: (sessionId: string) => T | undefined;
  readonly refresh: (sessionId: string) => Promise<T>;
  readonly reset: () => void;
};
export declare function createSummaryView(options: {
  readonly document: Document;
  readonly root: HTMLElement;
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}): {
  readonly render: (projection: unknown, sessionId: string) => void;
  readonly reset: () => void;
};
