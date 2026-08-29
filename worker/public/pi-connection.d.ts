export type PiIntent = Readonly<Record<string, unknown> & { readonly type: string }>;
export type CommandEnvelope = {
  readonly version: 1;
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
export declare const PI_CONSOLE_PROTOCOL_VERSION: 1;
export declare const canonicalJson: (value: unknown) => string;
export declare const commandIntentDigest: (intent: unknown) => Promise<string>;
export declare function consoleUrl(sessionId: string, operation: string): string;
export declare function createConsoleTransport(options: {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  eventSource: (url: URL) => EventSource;
  origin: string;
}): {
  snapshot(sessionId: string, signal?: AbortSignal): Promise<unknown>;
  events(sessionId: string, authority: { epoch?: string; sequence?: number }): EventSource;
  command(sessionId: string, envelope: CommandEnvelope): Promise<CommandTransportResult>;
};
export declare function classifyCommandResult(
  result: CommandTransportResult,
  envelope: CommandEnvelope,
): Promise<{ readonly status: string; readonly [key: string]: unknown }>;
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
    outcome: Promise<{ readonly status: string; readonly [key: string]: unknown }>;
  };
  discard(sessionId: string): { discardedCount: number };
  state(sessionId: string): { paused?: string; items: ReadonlyArray<Record<string, unknown>> };
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
  laneState(sessionId: string): { paused?: string; items: ReadonlyArray<Record<string, unknown>> };
};
