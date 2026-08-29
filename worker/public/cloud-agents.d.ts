export type CloudAgent = {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly branch: string;
  readonly status: string;
  readonly provider: string;
};
export declare function normalizeCloudAgent(value: unknown): CloudAgent | undefined;
export declare function groupCloudAgents(
  agents: ReadonlyArray<CloudAgent>,
): ReadonlyArray<{ readonly repo: string; readonly agents: ReadonlyArray<CloudAgent> }>;
export declare function cloudAgentSignature(
  agents: ReadonlyArray<CloudAgent>,
  currentSessionId?: string,
): string;
export declare function renderCloudAgents(
  document: Document,
  target: HTMLElement,
  agents: ReadonlyArray<CloudAgent>,
  currentSessionId?: string,
): void;
export declare function createCloudAgentDirectory(options: {
  document: Document;
  target: HTMLElement;
  count: HTMLElement;
  fetch: typeof globalThis.fetch;
  onSelect(sessionId: string): void;
  onChange?(agents: ReadonlyArray<CloudAgent>): void;
  interval?: number;
}): {
  refresh(): Promise<ReadonlyArray<CloudAgent>>;
  setCurrent(sessionId: string): void;
  find(sessionId: string): CloudAgent | undefined;
  agents(): ReadonlyArray<CloudAgent>;
  dispose(): void;
};
