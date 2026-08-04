export const PI_CONSOLE_PROTOCOL_VERSION: 1;

export type ConsoleCommandEnvelope = {
  readonly version: 1;
  readonly epoch: string;
  readonly commandId: string;
  readonly expectedSessionRevision: number;
  readonly intent: Readonly<Record<string, unknown>>;
};

export type ConsoleCommandTransportResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly readable: boolean;
  readonly body: unknown;
};

export function consoleUrl(sessionId: string, operation: string): string;

export function createConsoleClient(options: {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly eventSource: (url: URL) => unknown;
  readonly origin: string;
}): {
  readonly snapshot: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  readonly events: (
    sessionId: string,
    authority: { readonly epoch?: string; readonly sequence?: number },
  ) => unknown;
  readonly command: (
    sessionId: string,
    envelope: ConsoleCommandEnvelope,
  ) => Promise<ConsoleCommandTransportResult>;
};
