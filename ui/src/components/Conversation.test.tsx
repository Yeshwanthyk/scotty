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
  it("renders the existing streaming snapshot immediately", () => {
    const streaming: ConversationTurn = {
      ...completed("current"),
      state: "streaming",
      assistant: "Previously received response text",
    };
    const markup = renderToStaticMarkup(<Conversation turns={[streaming]} />);

    expect(markup).toContain(streaming.assistant);
  });

  it("renders the newest completed turn in full and keeps older work folded", () => {
    const markup = renderToStaticMarkup(
      <Conversation turns={[completed("one"), completed("two")]} />,
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
    const markup = renderToStaticMarkup(<Conversation turns={[completed("older"), streaming]} />);

    expect(markup).toContain('data-turn-disclosure="folded"');
    expect(markup).not.toContain('data-turn-disclosure="latest"');
    expect(markup).toContain('aria-label="Current turn"');
  });

  it("puts the current prompt before its working status and activity", () => {
    const streaming: ConversationTurn = {
      ...completed("current"),
      state: "streaming",
      tools: [
        {
          id: "tool-current",
          invocation: "read({ path: 'README.md' })",
          label: "Reading project",
          state: "running",
        },
      ],
    };
    const markup = renderToStaticMarkup(<Conversation turns={[streaming]} />);

    expect(markup.indexOf("Question current")).toBeLessThan(markup.indexOf("Working"));
    expect(markup.indexOf("Working")).toBeLessThan(markup.indexOf("Reading project"));
  });

  it("includes the complete tool invocation in its disclosure", () => {
    const invocation = `bash(${"readable-argument ".repeat(100)})`;
    const withTool: ConversationTurn = {
      ...completed("tool"),
      tools: [
        {
          id: "tool-1",
          invocation,
          label: "Running command",
          state: "completed",
        },
      ],
    };
    const markup = renderToStaticMarkup(<Conversation turns={[withTool]} />);

    expect(markup).toContain('aria-label="Complete tool invocation"');
    expect(markup.split(invocation)).toHaveLength(3);
  });
});
