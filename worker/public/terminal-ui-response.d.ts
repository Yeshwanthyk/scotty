export interface UiResponseProjection {
  readonly epoch?: unknown;
  readonly pendingUi: ReadonlyMap<string, { readonly method?: unknown }>;
  readonly deliveredUiResponses: Set<string>;
}

export function createUiResponseTracker(): {
  readonly begin: (sessionId: string, epoch: unknown, requestId: string) => void;
  readonly finish: (sessionId: string, epoch: unknown, requestId: string) => void;
  readonly markDelivered: (sessionId: string, epoch: unknown, requestId: string) => void;
  readonly sync: (sessionId: string, epoch: unknown, requestIds: Iterable<string>) => void;
  readonly isPending: (sessionId: string, epoch: unknown, requestId: string) => boolean;
  readonly isDelivered: (sessionId: string, epoch: unknown, requestId: string) => boolean;
  readonly hasPending: (sessionId: string) => boolean;
};

export function uiResponseCardState(
  delivered: boolean,
  pending: boolean,
): { readonly disabled: boolean; readonly label: string };

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
  readonly setPendingState: (
    sessionId: string,
    projection: UiResponseProjection,
    requestId: string,
    pending: boolean,
  ) => void;
  readonly setCardPending: () => void;
  readonly setCardDelivered: () => void;
  readonly setCardRetryable: () => void;
  readonly reportError: (message: string) => void;
}): Promise<void>;
