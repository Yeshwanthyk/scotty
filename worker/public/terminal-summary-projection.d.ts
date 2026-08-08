import type { BrowserHatchReference } from "./terminal-hatch-reference.js";

export interface SummaryEvidencePaths {
  readonly summary: string;
  readonly replay: string;
  readonly frame: (frameId: string) => string | undefined;
}

export interface SummaryEvidence {
  readonly kind: "evidence";
  readonly version: 1;
  readonly jobId: string;
  readonly status: "succeeded" | "failed" | "interrupted" | "unsupported";
  readonly completedSteps: number;
  readonly frameCount: number;
  readonly paths: SummaryEvidencePaths;
}

export interface UnavailableSummaryEvidence {
  readonly kind: "unavailable";
  readonly jobId: string;
}

export interface UnavailableSummaryHatch {
  readonly kind: "unavailable";
  readonly hatchId: string;
}

export type SessionSummaryProjection =
  | {
      readonly kind: "empty";
      readonly hatches: readonly [];
      readonly evidence: readonly [];
    }
  | {
      readonly kind: "summary";
      readonly conversationKey: string;
      readonly update: string;
      readonly hatches: ReadonlyArray<BrowserHatchReference | UnavailableSummaryHatch>;
      readonly evidence: ReadonlyArray<SummaryEvidence | UnavailableSummaryEvidence>;
    };

export function assistantEvidenceReferences(source: unknown): string[];
export function assistantHatchReferences(source: unknown): string[];

export function projectSessionSummary(
  messages: readonly unknown[] | undefined,
  tools: ReadonlyMap<string, unknown> | undefined,
  sessionId: string,
): SessionSummaryProjection;
