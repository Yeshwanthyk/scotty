export interface UiResponseProjection {
  readonly pendingUi: ReadonlyMap<string, { readonly method?: unknown }>;
  readonly deliveredUiResponses: Set<string>;
}

export function sendUiResponseForProjection(options: {
  readonly sessionId: string;
  readonly projection: UiResponseProjection;
  readonly requestId: string;
  readonly value: unknown;
  readonly cancelled?: boolean;
  readonly sendCommand: (
    intent: Readonly<Record<string, unknown>>,
    label: string,
  ) => Promise<{ readonly status?: unknown }>;
  readonly isCurrentProjection: (sessionId: string, projection: UiResponseProjection) => boolean;
  readonly setCardPending: () => void;
  readonly setCardDelivered: () => void;
  readonly setCardRetryable: () => void;
  readonly reportError: (message: string) => void;
}): Promise<void>;
