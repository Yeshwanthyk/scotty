export interface ShowcaseLoadFailure {
  readonly title: string;
  readonly detail: string;
  readonly retry: boolean;
}

export interface ShowcaseVideoState {
  readonly label: string;
  readonly detail: string;
}

export function formatShowcaseDuration(seconds: number): string;
export function showcaseLoadFailure(input?: {
  readonly status?: number;
  readonly code?: string;
}): ShowcaseLoadFailure;
export function showcaseVideoState(kind: string): ShowcaseVideoState;
