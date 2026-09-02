export type CloudAgent = {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly branch: string;
  readonly status: string;
  readonly provider: string;
  readonly createdAt: string;
};
export declare function normalizeCloudAgent(value: unknown): CloudAgent | undefined;
export declare function isActiveCloudAgent(agent: CloudAgent): boolean;
export declare function groupCloudAgents(
  agents: ReadonlyArray<CloudAgent>,
  currentSessionId?: string,
): ReadonlyArray<{ readonly repo: string; readonly agents: ReadonlyArray<CloudAgent> }>;
export declare function cloudAgentGroupWindow(
  agents: ReadonlyArray<CloudAgent>,
  currentSessionId?: string,
  options?: { readonly expanded?: boolean; readonly maximumSleeping?: number },
): { readonly agents: ReadonlyArray<CloudAgent>; readonly hidden: number };
export declare function filterCloudAgents(
  agents: ReadonlyArray<CloudAgent>,
  query: string,
): ReadonlyArray<CloudAgent>;
export declare function cloudAgentSignature(
  agents: ReadonlyArray<CloudAgent>,
  currentSessionId?: string,
): string;
export declare function renderCloudAgents(
  document: Document,
  target: HTMLElement,
  agents: ReadonlyArray<CloudAgent>,
  currentSessionId?: string,
  emptyMessage?: string,
  options?: {
    readonly expandedRepositories?: ReadonlySet<string>;
    readonly maximumSleeping?: number;
    readonly filtering?: boolean;
  },
): void;
export declare function createCloudAgentDirectory(options: {
  document: Document;
  target: HTMLElement;
  count: HTMLElement;
  filter?: HTMLInputElement;
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
