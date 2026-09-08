import { describe, expect, it } from "vitest";
import {
  activeConversationTurn,
  streamedTextAt,
  turnActivityLabel,
  turnPreview,
  type ConversationTurn,
} from "./conversation";

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

  it("bounds streaming text without splitting past the source", () => {
    expect(streamedTextAt("Scotty", -2)).toBe("");
    expect(streamedTextAt("Scotty", 4)).toBe("Scot");
    expect(streamedTextAt("Scotty", 100)).toBe("Scotty");
  });

  it("summarizes terminal and active activity", () => {
    expect(turnActivityLabel(turn())).toBe("Answered");
    expect(
      turnActivityLabel(
        turn({
          tools: [{ id: "tool-1", label: "Read", invocation: "read", state: "completed" }],
        }),
      ),
    ).toBe("1 action");
    expect(turnActivityLabel(turn({ state: "streaming" }))).toBe("Working");
    expect(turnActivityLabel(turn({ state: "aborted" }))).toBe("Stopped");
  });

  it("keeps folded previews compact", () => {
    expect(turnPreview(turn({ user: "one\n\n two   three" }))).toBe("one two three");
    expect(turnPreview(turn({ user: "x".repeat(100) }), 12)).toBe(`${"x".repeat(11)}…`);
    expect(turnPreview(turn({ user: "", assistant: "Research complete." }))).toBe(
      "Research complete.",
    );
    expect(
      turnPreview(turn({ user: "", assistant: "", activitySummary: "Compacting context" })),
    ).toBe("Compacting context");
    expect(turnPreview(turn({ user: "", assistant: "" }))).toBe("Conversation turn");
  });
});
