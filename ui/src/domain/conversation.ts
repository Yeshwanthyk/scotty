export type ToolActivityState = "completed" | "running" | "failed" | "cancelled";
export type ConversationTurnState = "completed" | "streaming" | "failed" | "aborted";

export interface ToolActivity {
  readonly id: string;
  readonly label: string;
  readonly invocation: string;
  readonly state: ToolActivityState;
  readonly output?: string;
}

export interface ConversationTurn {
  readonly id: string;
  readonly state: ConversationTurnState;
  readonly user: string;
  readonly activitySummary?: string;
  readonly tools: ReadonlyArray<ToolActivity>;
  readonly assistant: string;
  readonly elapsedSeconds?: number;
}

export const streamedTextAt = (text: string, visibleCharacters: number): string =>
  text.slice(0, Math.max(0, Math.min(text.length, visibleCharacters)));

export const turnActivityLabel = (turn: ConversationTurn): string => {
  const failed = turn.tools.filter((tool) => tool.state === "failed").length;
  if (turn.state === "streaming") return "Working";
  if (turn.state === "failed") return "Failed";
  if (turn.state === "aborted") return "Stopped";
  if (failed > 0) return `${failed} failed`;
  if (turn.tools.length === 0) return "Answered";
  return `${turn.tools.length} ${turn.tools.length === 1 ? "action" : "actions"}`;
};

export const turnPreview = (turn: ConversationTurn, maximum = 92): string => {
  const compact = turn.user.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1).trimEnd()}…`;
};
