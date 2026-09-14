import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../domain/conversation";
import { Conversation } from "./Conversation";

describe("current activity", () => {
  it("promotes the active summary beside the live working state", () => {
    const turn: ConversationTurn = {
      id: "active-turn",
      state: "streaming",
      user: "What are you doing now?",
      activitySummary: "Checking the current-activity interface",
      assistant: "",
      tools: [
        {
          id: "evidence",
          state: "running",
          label: "Checking the current-activity interface",
          invocation: "Browser evidence",
        },
      ],
    };

    const markup = renderToStaticMarkup(<Conversation animateStreaming={false} turns={[turn]} />);

    expect(markup.indexOf("Working")).toBeLessThan(
      markup.indexOf("Checking the current-activity interface"),
    );
    expect(markup.match(/Checking the current-activity interface/gu)).toHaveLength(2);
    expect(markup).toContain('role="status"');
    expect(markup.match(/data-design="current-activity"/gu)).toHaveLength(1);
  });
});
