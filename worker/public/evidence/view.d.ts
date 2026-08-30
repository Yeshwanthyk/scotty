export interface EvidenceCheckpoint {
  readonly index: number;
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly action: string;
  readonly assertions: ReadonlyArray<{
    readonly kind: string;
    readonly passed: boolean;
    readonly expected?: unknown;
    readonly actual?: unknown;
  }>;
  readonly frame?: {
    readonly frameId: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly capturedAt: string;
    readonly offsetMillis: number;
  };
}

export interface EvidenceFrame {
  readonly frameId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly capturedAt: string;
  readonly offsetMillis: number;
  readonly stepIndex: number;
  readonly stepName: string;
  readonly stepStatus: "passed" | "failed";
}

export function isTerminalEvidenceStatus(status: unknown): boolean;
export function shouldPollEvidence(payload: unknown, detail: boolean): boolean;
export function orderedEvidenceSteps(summary: unknown): ReadonlyArray<EvidenceCheckpoint>;

export function orderedEvidenceFrames(summary: unknown): ReadonlyArray<EvidenceFrame>;
export function evidenceStatusLabel(status: unknown): string;

export function evidenceFailurePresentation(failure: unknown):
  | {
      readonly title: string;
      readonly detail: string;
      readonly hint?: string;
    }
  | undefined;
