export interface KeyedWorklogEntry<Node> {
  readonly key: string;
  readonly signature: string;
  readonly render: () => Node;
}

export interface RenderedWorklogEntry<Node> {
  readonly node: Node;
  readonly signature: string;
}

export interface WorklogContainer<Node> {
  readonly children: ArrayLike<Node>;
  insertBefore(node: Node, before: Node | null): unknown;
  removeChild(node: Node): unknown;
}

export interface WorklogUpdate {
  readonly added: number;
  readonly removed: number;
  readonly replaced: number;
  readonly reused: number;
}

export function semanticSignature(value: unknown): string;

export function resolveKeyedItems<Node>(
  previous: ReadonlyMap<string, RenderedWorklogEntry<Node>>,
  entries: ReadonlyArray<KeyedWorklogEntry<Node>>,
): {
  readonly next: ReadonlyMap<string, RenderedWorklogEntry<Node>>;
  readonly nodes: ReadonlyArray<Node>;
  readonly added: number;
  readonly removed: number;
  readonly replaced: number;
  readonly reused: number;
};

export function createWorklogView<Node>(container: WorklogContainer<Node>): {
  update(entries: ReadonlyArray<KeyedWorklogEntry<Node>>): WorklogUpdate;
};

export function meaningfulWorklogAnnouncement(input: {
  readonly type?: unknown;
  readonly method?: unknown;
  readonly wasActive: boolean;
  readonly isActive: boolean;
}): string | undefined;
