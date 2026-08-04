export interface UiResponseProjection {
  readonly epoch?: unknown;
  readonly pendingUi: ReadonlyMap<string, { readonly method?: unknown }>;
  readonly deliveredUiResponses: Set<string>;
}

export function markUiResponseDelivered(
  projection: UiResponseProjection,
  latestProjection: UiResponseProjection | undefined,
  requestId: string,
): void;

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
  readonly hasCurrentRequest: (
    sessionId: string,
    projection: UiResponseProjection,
    requestId: string,
  ) => boolean;
  readonly hasCurrentDelivery: (sessionId: string, requestId: string) => boolean;
  readonly markDelivered: (
    sessionId: string,
    projection: UiResponseProjection,
    requestId: string,
  ) => void;
  readonly setCardPending: () => void;
  readonly setCardDelivered: () => void;
  readonly setCardRetryable: () => void;
  readonly reportError: (message: string) => void;
}): Promise<void>;
