import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../domain/conversation";
import { Conversation } from "./Conversation";

const completed = (id: string): ConversationTurn => ({
  id,
  state: "completed",
  user: `Question ${id}`,
  assistant: `Answer ${id}`,
  tools: [],
});

describe("conversation disclosure", () => {
  it("renders the newest completed turn in full and keeps older work folded", () => {
    const markup = renderToStaticMarkup(
      <Conversation animateStreaming={false} turns={[completed("one"), completed("two")]} />,
    );

    expect(markup.match(/data-turn-disclosure="folded"/gu)).toHaveLength(1);
    expect(markup.match(/data-turn-disclosure="latest"/gu)).toHaveLength(1);
    expect(markup.indexOf("Answer one")).toBeLessThan(markup.indexOf("Answer two"));
  });

  it("keeps completed turns folded while the current turn is streaming", () => {
    const streaming: ConversationTurn = {
      ...completed("current"),
      state: "streaming",
    };
    const markup = renderToStaticMarkup(
      <Conversation animateStreaming={false} turns={[completed("older"), streaming]} />,
    );

    expect(markup).toContain('data-turn-disclosure="folded"');
    expect(markup).not.toContain('data-turn-disclosure="latest"');
    expect(markup).toContain('aria-label="Current turn"');
  });
});
