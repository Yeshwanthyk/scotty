export interface RepositorySuggestion {
  readonly repo: string;
  readonly defaultBranch?: string;
  readonly lastUsedAt?: string;
}

export interface RepositorySessionGroup<T> {
  readonly repo: string;
  readonly sessions: T[];
}

export interface SessionSubmissionPayload {
  readonly title: string;
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
export function titleText(value: unknown): string | undefined;
export function sessionTitle(session: { readonly title: unknown }): string;
export function mergeRepositorySuggestions(
  tracked: unknown,
  suppressed?: unknown,
): RepositorySuggestion[];
export function groupSessionsByRepository<
  T extends {
    readonly id?: unknown;
    readonly repo?: unknown;
    readonly status?: unknown;
    readonly createdAt?: unknown;
  },
>(sessions: readonly T[]): RepositorySessionGroup<T>[];
export function submissionIdentity(
  previous: SubmissionIdentity | undefined,
  payload: SessionSubmissionPayload,
  createKey: () => string,
): SubmissionIdentity;
export function safeSessionPath(value: unknown, id: unknown, origin: string): string | undefined;
export function sessionDisplayStatus(value: unknown, pendingAction: unknown): string;
export function sessionKeyboardAction(
  key: unknown,
  focusedIndex: unknown,
  sessionCount: unknown,
): { readonly type: "open" | "focus"; readonly index: number } | undefined;
