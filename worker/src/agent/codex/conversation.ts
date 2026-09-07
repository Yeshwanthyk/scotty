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
  return yield* decodeCanonicalConversationSnapshot({
    version: 1,
    transport: {
      epoch: snapshot.generation,
      baseSequence: 0,
      sequence: terminal || state === "failed" ? 2 : 1,
      sessionRevision: input.revision,
    },
    turns: [{ id: input.turnId, state, user, assistant, tools: [] }],
    queue: { steer: [], followUp: [] },
    truncated: { turns: false, values: user !== input.prompt || assistant !== text },
  });
});
