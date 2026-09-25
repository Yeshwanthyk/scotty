import { describe, expect, it } from "vitest";
import { activeConversationTurn, type ConversationTurn } from "./conversation";

const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: "turn-1",
  state: "completed",
  user: "Check the session lifecycle",
  tools: [],
  assistant: "Done.",
  ...overrides,
});

describe("conversation presentation", () => {
  it("uses only a canonical streaming turn as the active turn", () => {
    expect(activeConversationTurn([turn({ state: "completed" })])).toBeUndefined();
    expect(activeConversationTurn([turn({ state: "failed" })])).toBeUndefined();
    expect(activeConversationTurn([turn({ state: "aborted" })])).toBeUndefined();
    expect(activeConversationTurn([turn({ id: "streaming", state: "streaming" })])).toMatchObject({
      id: "streaming",
      state: "streaming",
    });
  });
});
