export interface BrowserEvidencePaths {
  readonly summary: string;
  readonly replay: string;
  readonly frame: (frameId: string) => string | undefined;
}

export interface BrowserEvidenceAttachment {
  readonly kind: "evidence";
  readonly version: 1;
  readonly jobId: string;
  readonly status: "succeeded" | "failed" | "interrupted" | "unsupported";
  readonly completedSteps: number;
  readonly frameCount: number;
  readonly failure?: { readonly code: string; readonly step?: number };
  readonly paths: BrowserEvidencePaths;
}

export interface UnavailableBrowserEvidenceAttachment {
  readonly kind: "unavailable";
}

export interface BrowserEvidenceSummary {
  readonly status: string;
  readonly passedAssertions: number;
  readonly totalAssertions: number;
  readonly frames: ReadonlyArray<{
    readonly frameId: string;
    readonly stepIndex: number;
    readonly stepName: string;
  }>;
}

export function browserEvidencePaths(
  sessionId: string,
  jobId: string,
): BrowserEvidencePaths | undefined;

export function browserEvidenceAttachment(
  tool: unknown,
  sessionId: string,
): BrowserEvidenceAttachment | UnavailableBrowserEvidenceAttachment | undefined;

export function browserEvidenceSummary(
  value: unknown,
  attachment: BrowserEvidenceAttachment | UnavailableBrowserEvidenceAttachment | undefined,
): BrowserEvidenceSummary | undefined;

export function browserEvidenceStatusLabel(status: string): string;

export function browserEvidenceNoFrameCopy(status: string): string;
