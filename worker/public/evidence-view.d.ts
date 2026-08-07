export interface ReplayFrame {
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
export function orderedReplayFrames(summary: unknown): ReadonlyArray<ReplayFrame>;
export function replayDelayMillis(frames: ReadonlyArray<ReplayFrame>, index: number): number;
export function evidenceStatusLabel(status: unknown): string;
