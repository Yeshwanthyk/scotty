export type JsonValue = null | boolean | number | string | JsonObject | ReadonlyArray<JsonValue>;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type PiIntent =
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | { readonly type: "steer" | "follow_up"; readonly message: string }
  | { readonly type: "abort" }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };
export type CommandEnvelope = {
  readonly epoch: string;
  readonly commandId: string;
  readonly expectedSessionRevision: number;
  readonly intent: PiIntent;
};
export type CommandTransportResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly readable: boolean;
  readonly body?: unknown;
};
export type PiEventSource = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
};
export type CommandOutcome = {
  readonly status: string;
  readonly receipt?: JsonObject;
  readonly response?: unknown;
  readonly message?: string;
};
export type LaneItem = {
  readonly sessionId: string;
  readonly envelope: CommandEnvelope;
  readonly label: string;
  readonly state: string;
  readonly outcome?: CommandOutcome;
};
export declare const canonicalJson: (value: unknown) => string;
export declare const commandIntentDigest: (intent: unknown) => Promise<string>;
export declare function consoleUrl(sessionId: string, operation: string): string;
export declare function createConsoleTransport(options: {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  eventSource: (url: URL) => PiEventSource;
  origin: string;
}): {
  snapshot(sessionId: string, signal?: AbortSignal): Promise<unknown>;
  events(sessionId: string, authority: { epoch?: string; sequence?: number }): PiEventSource;
  command(sessionId: string, envelope: CommandEnvelope): Promise<CommandTransportResult>;
};
export declare function classifyCommandResult(
  result: CommandTransportResult,
  envelope: CommandEnvelope,
): Promise<CommandOutcome>;
export declare function createCommandLane(options: {
  send: (sessionId: string, envelope: CommandEnvelope) => Promise<CommandTransportResult>;
  randomUUID: () => string;
  onChange?: (items: ReadonlyArray<unknown>) => void;
}): {
  enqueue(input: {
    sessionId: string;
    epoch: string;
    expectedSessionRevision: number;
    intent: PiIntent;
    label: string;
  }): {
    commandId: string;
    outcome: Promise<CommandOutcome>;
  };
  discard(sessionId: string): { discardedCount: number };
  state(sessionId: string): { paused?: string; items: ReadonlyArray<LaneItem> };
};
export declare function createPiConnection(options: {
  transport: ReturnType<typeof createConsoleTransport>;
  randomUUID: () => string;
  onEvent: (event: unknown) => void;
  onState: (state: string, message?: string) => void;
  onLaneChange: (items: ReadonlyArray<unknown>) => void;
}): {
  open(sessionId: string): Promise<unknown>;
  close(): void;
  command(
    authority: { sessionId: string; epoch: string; expectedSessionRevision: number },
    intent: PiIntent,
    label: string,
  ): ReturnType<ReturnType<typeof createCommandLane>["enqueue"]>;
  discard(sessionId: string): { discardedCount: number };
  laneState(sessionId: string): { paused?: string; items: ReadonlyArray<LaneItem> };
};
