import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../domain/conversation";
import type { EvidenceSummary } from "../data/session-workbench";
import { Conversation } from "./Conversation";

const completed = (id: string): ConversationTurn => ({
  id,
  state: "completed",
  user: `Question ${id}`,
  assistant: `Answer ${id}`,
  tools: [],
});

const evidence: EvidenceSummary = {
  jobId: "job-1",
  status: "succeeded",
  totalSteps: 1,
  completedSteps: 1,
  frameCount: 1,
  recordVideo: true,
  videoAvailable: true,
  steps: [{ name: "Conversation view", status: "passed", frameId: "frame-1" }],
};

describe("conversation disclosure", () => {
  it.each([true, false])(
    "renders the existing streaming snapshot immediately (animateStreaming=%s)",
    (animateStreaming) => {
      const streaming: ConversationTurn = {
        ...completed("current"),
        state: "streaming",
        assistant: "Previously received response text",
      };
      const markup = renderToStaticMarkup(
        <Conversation animateStreaming={animateStreaming} turns={[streaming]} />,
      );

      expect(markup).toContain(streaming.assistant);
    },
  );

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
    const markup = renderToStaticMarkup(
      <Conversation animateStreaming={false} turns={[streaming]} />,
    );

    expect(markup.indexOf("Question current")).toBeLessThan(markup.indexOf("Working"));
    expect(markup.indexOf("Working")).toBeLessThan(markup.indexOf("Reading project"));
  });

  it("renders referenced authenticated pictures and video inside the owning turn", () => {
    const turn: ConversationTurn = {
      ...completed("evidence"),
      tools: [
        {
          id: "tool-evidence",
          invocation: "Browser evidence",
          label: "Browser evidence",
          state: "completed",
          output: '{"jobId":"job-1","summaryUrl":"/s/a0b1c2d3e4f5/evidence/job-1"}',
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <Conversation
        animateStreaming={false}
        evidence={[evidence]}
        sessionId="a0b1c2d3e4f5"
        turns={[turn]}
      />,
    );

    expect(markup).toContain('aria-label="Browser evidence"');
    expect(markup).toContain('src="/s/a0b1c2d3e4f5/evidence/job-1/frames/frame-1.png"');
    expect(markup).toContain('aria-label="Browser evidence recording"');
    expect(markup).toContain('src="/s/a0b1c2d3e4f5/evidence/job-1/video.webm"');
    expect(markup).toContain("controls");
  });

  it("does not attach unreferenced evidence to a conversation turn", () => {
    const markup = renderToStaticMarkup(
      <Conversation
        animateStreaming={false}
        evidence={[evidence]}
        sessionId="a0b1c2d3e4f5"
        turns={[completed("plain")]}
      />,
    );

    expect(markup).not.toContain('aria-label="Browser evidence"');
    expect(markup).not.toContain("video.webm");
  });

  it("does not confuse an evidence job with an identifier that only shares its prefix", () => {
    const turn: ConversationTurn = {
      ...completed("other-evidence"),
      assistant: "Proof: scotty-evidence:job-10",
    };
    const markup = renderToStaticMarkup(
      <Conversation evidence={[evidence]} sessionId="a0b1c2d3e4f5" turns={[turn]} />,
    );

    expect(markup).not.toContain('aria-label="Browser evidence"');
  });
});
