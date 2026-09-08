import { Effect } from "effect";
import {
  CONVERSATION_MAX_TEXT_BYTES,
  decodeCanonicalConversationSnapshot,
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

export const codexConversation = Effect.fnUntraced(function* (
  snapshot: typeof CodexSnapshot.Type,
  input: { readonly prompt: string; readonly turnId: string; readonly revision: number },
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
  const turns =
    snapshot.turns === undefined || snapshot.turns.length === 0
      ? [{ id: input.turnId, state, user, assistant, tools: snapshot.tools ?? [] }]
      : snapshot.turns;
  return yield* decodeCanonicalConversationSnapshot({
    version: 1,
    transport: {
      epoch: snapshot.generation,
      baseSequence: 0,
      sequence: snapshot.sequence ?? (terminal || state === "failed" ? 2 : 1),
      sessionRevision: input.revision,
    },
    turns,
    queue: { steer: [], followUp: [] },
    truncated: {
      turns: snapshot.turnsTruncated === true,
      values: snapshot.toolsTruncated === true || user !== input.prompt || assistant !== text,
    },
  });
});
