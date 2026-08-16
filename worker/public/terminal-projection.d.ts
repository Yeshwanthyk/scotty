export type TerminalTool = {
  readonly id: string;
  readonly name: string;
};

export type TerminalProjection = {
  epoch: string | undefined;
  sessionRevision: number | undefined;
  sequence: number;
  messages: unknown[];
  messageProjection: unknown;
  tools: Map<string, TerminalTool>;
  pendingUi: Map<string, unknown>;
  deliveredUiResponses: Set<string>;
  queue: { steer: unknown[]; followUp: unknown[] };
  active: boolean;
  state: {
    extensionStatus?: object;
    extensionTitle?: unknown;
    editorText?: unknown;
    processExited?: boolean;
  };
  capabilities: { models: unknown[]; thinkingLevels: unknown[] };
  activity: { subagents: unknown[]; workflows: unknown[] };
  subagents: import("./terminal-subagents-projection.js").SubagentActivitySnapshot | undefined;
  loaded: boolean;
};

export function isObject(value: unknown): value is object;
export function firstArray(...values: unknown[]): unknown[];
export function firstObject(...values: unknown[]): object;
export function firstString(...values: unknown[]): string | undefined;
export function messageText(value: unknown): string;
export function contentParts(message: unknown): unknown[];
export function blankProjection(): TerminalProjection;
export function projectionFromSnapshot(body: unknown): TerminalProjection;
export function eventPayload(payload: unknown): { readonly outer: object; readonly event: object };
export function applyEvent(projection: TerminalProjection, payload: unknown): string;
