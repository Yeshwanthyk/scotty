export interface TerminalWebSocket {
  binaryType: string;
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  close(): void;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
}

export interface TerminalWebSocketConstructor {
  readonly OPEN: number;
  readonly CLOSING: number;
  new (url: URL): TerminalWebSocket;
}

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

export type TerminalConnectionState =
  | "closed"
  | "connecting"
  | "connected"
  | "disconnected"
  | "exited"
  | "reconnecting"
  | "unavailable";

export declare function terminalSocketUrl(
  sessionId: string,
  origin: string,
  dimensions?: Partial<TerminalDimensions>,
): URL;
export declare function terminalRestartUrl(sessionId: string): string;
export declare function createTerminalConnection(options: {
  WebSocket: TerminalWebSocketConstructor;
  origin: string;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
  dimensions: () => TerminalDimensions;
  onData: (data: Uint8Array) => void;
  onState: (state: TerminalConnectionState, message: string) => void;
  onReady: () => void;
}): {
  connect: (sessionId: string) => void;
  disconnect: () => void;
  reconnect: () => void;
  send: (data: string) => void;
  resize: () => void;
  dispose: () => void;
};
