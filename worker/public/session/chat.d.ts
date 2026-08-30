export type ChatJsonValue =
  | null
  | boolean
  | number
  | string
  | ChatJsonObject
  | ReadonlyArray<ChatJsonValue>;
export interface ChatJsonObject {
  readonly [key: string]: ChatJsonValue;
}
export type ChatMessage = ChatJsonObject & {
  readonly id?: string;
  readonly role?: string;
  readonly content?: string | ReadonlyArray<ChatJsonValue>;
};
export type ChatProjection = {
  readonly epoch: string;
  readonly sessionRevision: number;
  sequence: number;
  state: ChatJsonObject;
  messages: Array<ChatMessage>;
  tools: Map<string, ChatJsonObject>;
  pendingUi: Map<string, ChatJsonObject>;
  queue: { steer: Array<ChatJsonValue>; followUp: Array<ChatJsonValue> };
  active: boolean;
};
export type ChatTurn = {
  readonly key: string;
  readonly user?: ChatMessage;
  readonly assistants: ReadonlyArray<ChatMessage>;
  readonly tools: ReadonlyArray<ChatJsonObject>;
};
export declare function sanitizeText(value: unknown, maximum?: number): string;
export declare function projectionFromSnapshot(snapshot: unknown): ChatProjection;
export declare function applyEvent(
  projection: ChatProjection,
  envelope: unknown,
): "ignored" | "refresh" | "duplicate" | "applied";
export declare function conversationTurns(projection: ChatProjection): ReadonlyArray<ChatTurn>;
export declare function safeMarkdownTree(source: string, baseUrl?: string): ReadonlyArray<unknown>;
export declare function createChatView(options: {
  document: Document;
  feed: HTMLElement;
  baseUrl: string;
}): {
  render(projection: ChatProjection, sessionId: string): void;
  reset(): void;
};
