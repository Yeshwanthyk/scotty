export type ComposerDraftEntry = { draft: string };

export type ComposerDraftSubmission = {
  readonly sessionId: string;
  readonly draft: string;
  readonly revision: number;
};

export type ComposerDraftOutcome = "accepted" | "rejected" | "stale" | "ambiguous" | "discarded";

export function createComposerDrafts(entryForSession: (sessionId: string) => ComposerDraftEntry): {
  readonly set: (sessionId: string, draft: string) => string;
  readonly begin: (sessionId: string, draft: string) => ComposerDraftSubmission;
  readonly settle: (submission: ComposerDraftSubmission, status: ComposerDraftOutcome) => boolean;
};
