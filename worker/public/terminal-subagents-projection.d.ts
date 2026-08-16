export declare const SUBAGENTS_WIDGET_KEY: "pi-subagents/activity/v1";
export declare const SUBAGENTS_PROTOCOL_VERSION: 1;
export declare const SUBAGENTS_LIMITS: {
  readonly maxChildren: 4;
  readonly maxPrompt: 2048;
  readonly maxOutput: 4096;
  readonly maxFailure: 2048;
  readonly maxTranscript: 16;
  readonly maxTranscriptText: 512;
  readonly maxTools: 4;
  readonly maxQueued: 4;
};
export type SubagentStatus = "running" | "done" | "error";
export type SubagentTranscriptItem = {
  readonly kind: "user" | "assistant" | "thinking" | "tool";
  readonly text?: string;
  readonly name?: string;
  readonly args?: string;
  readonly output?: string;
  readonly isError?: boolean;
};
export type SubagentChild = {
  readonly id: string;
  readonly title: string;
  readonly status: "running";
  readonly backend: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly prompt: string;
  readonly output: string;
  readonly failure?: string;
  readonly transcript: readonly SubagentTranscriptItem[];
  readonly tools: readonly Record<string, unknown>[];
  readonly queued: readonly { kind: "steer" | "follow-up"; text: string }[];
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly settledAt?: number;
};
export type SubagentDetail = Omit<SubagentChild, "status"> & {
  readonly status: SubagentStatus;
};

export type SubagentTerminal = {
  readonly id: string;
  readonly title: string;
  readonly status: "done" | "error";
  readonly output: string;
  readonly failure?: string;
  readonly settledAt: number;
};
export type SubagentActivitySnapshot = {
  readonly version: 1;
  readonly revision: number;
  readonly generatedAt: number;
  readonly children: readonly SubagentChild[];
  readonly terminal?: SubagentTerminal;
};
export declare function isObject(value: unknown): value is Record<string, unknown>;
export declare function snapshotForWidget(value: unknown): SubagentActivitySnapshot | undefined;
export declare function subagentActivityFromWidget(
  value: unknown,
): SubagentActivitySnapshot | undefined;
export declare function subagentActivityState(
  snapshot: unknown,
  selectedId?: string,
): { snapshot: SubagentActivitySnapshot | undefined; selectedId: string | undefined };
export declare function selectedSubagent(
  snapshot: SubagentActivitySnapshot | undefined,
  id?: string,
): SubagentDetail | undefined;
export declare function subagentElapsed(child: SubagentChild | undefined, now?: number): string;
export declare function subagentCount(snapshot: SubagentActivitySnapshot | undefined): number;
export declare function subagentCountLabel(count: number): string;
export declare function subagentModelLabel(child: SubagentChild | undefined): string;
export declare function subagentTranscriptTail(child: SubagentChild | undefined): string;
