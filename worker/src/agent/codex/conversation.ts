import { Effect } from "effect";
import {
  CONVERSATION_MAX_TEXT_BYTES,
  decodeCanonicalConversationSnapshot,
  type CanonicalConversationTurn,
} from "../../../../protocol/conversation";
import type { CodexSnapshot } from "./runtime";

const boundedText = (text: string): string => {
  const encoder = new TextEncoder();
  let bytes = 0;
  let bounded = "";
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > CONVERSATION_MAX_TEXT_BYTES) break;
    bounded += character;
  }
  return bounded;
};

type CodexPromptState = (typeof CodexSnapshot.Type)["prompt"];

const projectFailedTurn = (
  turn: CanonicalConversationTurn,
  state: CanonicalConversationTurn["state"],
  prompt: CodexPromptState,
  fallbackId: string,
  activitySummary: string | undefined,
): CanonicalConversationTurn => {
  const failedId =
    state === "failed" && "turnId" in prompt && prompt.turnId !== null ? prompt.turnId : fallbackId;
  if (state !== "failed" || turn.id !== failedId || turn.state !== "failed") return turn;
  return {
    ...turn,
    ...(activitySummary === undefined ? {} : { activitySummary }),
    tools: turn.tools.map((tool) =>
      tool.state === "running" ? { ...tool, state: "failed" as const } : tool,
    ),
  };
};

export const codexConversation = Effect.fnUntraced(function* (
  snapshot: typeof CodexSnapshot.Type,
  input: {
    readonly prompt: string;
    readonly turnId: string;
    readonly revision: number;
    readonly followUpBlocked?: boolean;
    readonly followUp?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  },
) {
  const prompt = snapshot.prompt;
  const user = boundedText(input.prompt);
  const text = prompt.status === "terminal" ? prompt.text : "";
  const assistant = boundedText(text);
  const terminal = prompt.status === "terminal";
  const state = terminal
    ? prompt.outcome === "interrupted"
      ? "aborted"
      : prompt.outcome
    : prompt.status === "failed" || snapshot.failure !== null
      ? "failed"
      : "streaming";
  const activitySummary =
    state === "failed" && snapshot.failure !== null
      ? boundedText(`Runtime failure: ${snapshot.failure}`)
      : undefined;
  const fallbackTurn: CanonicalConversationTurn = {
    id: input.turnId,
    state,
    user,
    assistant,
    tools: snapshot.tools ?? [],
  };
  const turns =
    snapshot.turns === undefined || snapshot.turns.length === 0
      ? [projectFailedTurn(fallbackTurn, state, prompt, input.turnId, activitySummary)]
      : snapshot.turns.map((turn) =>
          projectFailedTurn(turn, state, prompt, input.turnId, activitySummary),
        );
  return yield* decodeCanonicalConversationSnapshot({
    version: 1,
    followUpAvailable: prompt.status !== "failed" && snapshot.failure === null,
    followUpBlocked: input.followUpBlocked ?? false,
    transport: {
      epoch: snapshot.generation,
      baseSequence: 0,
      sequence: snapshot.sequence ?? (terminal || state === "failed" ? 2 : 1),
      sessionRevision: input.revision,
    },
    turns,
    queue: { steer: [], followUp: input.followUp ?? [] },
    truncated: {
      turns: snapshot.turnsTruncated === true,
      values: snapshot.toolsTruncated === true || user !== input.prompt || assistant !== text,
    },
  });
});
