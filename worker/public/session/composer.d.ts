export type DeliveryMode = "follow_up" | "steer";
export type DeliveryStatus =
  | "submitting"
  | "accepted"
  | "queued"
  | "delivered"
  | "stale"
  | "ambiguous"
  | "failed";
export type DeliveryState = {
  readonly kind: DeliveryMode | "prompt";
  readonly message: string;
  readonly status: DeliveryStatus;
  readonly detail?: string;
};
export type SessionMemoryEntry = {
  draft: string;
  scrollTop: number;
  delivery?: DeliveryState;
};
export type ComposerProjection = {
  readonly active?: boolean;
  readonly tools?: ReadonlyMap<string, { readonly name?: string; readonly status?: string }>;
  readonly pendingUi?: ReadonlyMap<string, unknown>;
  readonly messages?: ReadonlyArray<{
    readonly id?: string;
    readonly role?: string;
    readonly content?:
      | string
      | ReadonlyArray<string | { readonly type?: string; readonly text?: string }>;
  }>;
  readonly queue?: {
    readonly steer?: ReadonlyArray<string | { readonly text?: string }>;
    readonly followUp?: ReadonlyArray<string | { readonly text?: string }>;
  };
};
export type ComposerPresentation = {
  readonly active: boolean;
  readonly recovery: boolean;
  readonly sendDisabled: boolean;
  readonly stopDisabled: boolean;
  readonly sendLabel: string;
  readonly status: string;
  readonly hint: string;
};
export type ComposerElements = {
  readonly recovery: { hidden: boolean };
  readonly deliveryControls: { hidden: boolean };
  readonly stopButton: { hidden: boolean; disabled: boolean };
  readonly sendButton: { disabled: boolean; textContent: string | null };
  readonly hint: { dataset: Record<string, string>; textContent: string | null };
};
export declare function createSessionMemory(): {
  entry(sessionId: string): SessionMemoryEntry;
  restoreDraft(sessionId: string, text: string): SessionMemoryEntry;
};
export declare function selectedDeliveryMode(root: Element): DeliveryMode;
export declare function shouldSubmitComposerKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean;
export declare function reconcileDelivery(
  delivery: DeliveryState | undefined,
  projection: ComposerProjection | undefined,
  event?: { readonly message?: { readonly role?: string; readonly content?: unknown } },
): DeliveryState | undefined;
export declare function currentActivity(
  projection: ComposerProjection | undefined,
): string | undefined;
export declare function composerPresentation(input: {
  projection?: ComposerProjection;
  lane: { paused?: string; items: ReadonlyArray<{ state: string }> };
  draft: string;
  delivery?: DeliveryState;
  deliveryMode: DeliveryMode;
}): ComposerPresentation;
export declare function renderComposerPresentation(
  elements: ComposerElements,
  presentation: ComposerPresentation,
): void;
