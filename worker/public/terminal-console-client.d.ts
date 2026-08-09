import type {
  PiConsoleCommandErrorV1,
  PiConsoleCommandReceiptV1,
  PiConsoleCommandV1,
  PiConsoleStaleCommandV1,
  PiConsoleUnavailableV1,
} from "../../protocol/pi-console";

export const PI_CONSOLE_PROTOCOL_VERSION: 1;

export type ConsoleCommandEnvelope = PiConsoleCommandV1;

export type ConsoleJson =
  | null
  | boolean
  | number
  | string
  | readonly ConsoleJson[]
  | { readonly [key: string]: ConsoleJson };

export type ConsoleCommandResponseBody =
  | PiConsoleCommandReceiptV1
  | PiConsoleCommandErrorV1
  | PiConsoleStaleCommandV1
  | PiConsoleUnavailableV1
  | ConsoleJson;

export type ConsoleCommandTransportResult =
  | {
      readonly ok: boolean;
      readonly status: number;
      readonly readable: true;
      readonly body: ConsoleCommandResponseBody;
    }
  | {
      readonly ok: boolean;
      readonly status: number;
      readonly readable: false;
      readonly body: undefined;
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
