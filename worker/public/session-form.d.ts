export interface RepositorySuggestion {
  readonly repo: string;
  readonly defaultBranch?: string;
  readonly lastUsedAt?: string;
}

export interface SessionSubmissionPayload {
  readonly repo: string;
  readonly prompt: string;
  readonly hardCapSeconds: number;
}

export interface SubmissionIdentity {
  readonly fingerprint: string;
  readonly key: string;
}

export function repositoryName(value: unknown): string | undefined;
export function promptText(value: unknown): string | undefined;
export function mergeRepositorySuggestions(
  tracked: unknown,
  sessions: unknown,
): RepositorySuggestion[];
export function submissionIdentity(
  previous: SubmissionIdentity | undefined,
  payload: SessionSubmissionPayload,
  createKey: () => string,
): SubmissionIdentity;
export function safeSessionPath(value: unknown, id: unknown, origin: string): string | undefined;
export function sessionDisplayStatus(value: unknown, pendingAction: unknown): string;
