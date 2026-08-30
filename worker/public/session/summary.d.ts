import type { Artifact } from "./artifacts.js";

export interface SummaryProjection {
  readonly update: string;
  readonly artifacts: ReadonlyArray<Artifact & { readonly reference: string }>;
}

export declare function extractSummaryReferences(text: string): ReadonlyArray<string>;
export declare function summaryProjection(
  projection: unknown,
  sessionId: string,
): SummaryProjection;
export declare function decodeSummaryEvidence(value: unknown, jobId: string): unknown;
export declare function decodeSummaryHatch(value: unknown, hatchId: string): unknown;
export declare function createSummaryView(options: {
  readonly document: Document;
  readonly root: HTMLElement;
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}): {
  readonly render: (projection: unknown, sessionId: string) => void;
  readonly reset: () => void;
};
