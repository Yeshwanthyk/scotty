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

const evidence = (overrides: Partial<EvidenceSummary> = {}): EvidenceSummary => ({
  jobId: "job-1",
  status: "succeeded",
  totalSteps: 1,
  completedSteps: 1,
  frameCount: 1,
  recordVideo: false,
  videoAvailable: false,
  steps: [{ name: "Conversation view", status: "passed", frameId: "frame-1" }],
  ...overrides,
});

describe("conversation disclosure", () => {
  it.each(["completed", "streaming"] as const)(
    "renders published images in %s assistant messages",
    (state) => {
      const turn: ConversationTurn = {
        ...completed("image"),
        state,
        assistant: "![Fixed table](scotty-evidence:job-1)",
      };
      const markup = renderToStaticMarkup(
        <Conversation
          turns={[turn]}
          sessionId="a0b1c2d3e4f5"
          evidenceState={{ kind: "ready", sessionId: "a0b1c2d3e4f5", evidence: [evidence()] }}
        />,
      );
      expect(markup).toContain('alt="Fixed table"');
      expect(markup).toContain('src="/s/a0b1c2d3e4f5/evidence/job-1/frames/frame-1.png"');
    },
  );

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

describe("inline conversation evidence", () => {
  it("renders a failed run's screenshot beneath the tool that owns its persisted reference", () => {
    const turn: ConversationTurn = {
      ...completed("evidence"),
      assistant: "The run failed after capturing a checkpoint.",
      tools: [
        {
          id: "tool-evidence",
          invocation: "Browser evidence",
          label: "Browser evidence",
          state: "failed",
          output: "scotty-evidence:job-1",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <Conversation
        evidenceState={{
          kind: "ready",
          sessionId: "a0b1c2d3e4f5",
          evidence: [evidence({ status: "failed" })],
        }}
        sessionId="a0b1c2d3e4f5"
        turns={[turn]}
      />,
    );

    expect(markup).toContain('aria-label="Browser evidence"');
    expect(markup).toContain('src="/s/a0b1c2d3e4f5/evidence/job-1/frames/frame-1.png"');
    expect(markup.indexOf("scotty-evidence:job-1")).toBeLessThan(
      markup.indexOf('aria-label="Browser evidence"'),
    );
  });

  it("does not associate an assistant prose marker with evidence", () => {
    const turn: ConversationTurn = {
      ...completed("prose"),
      assistant: "Earlier proof was scotty-evidence:job-1.",
    };
    const markup = renderToStaticMarkup(
      <Conversation
        evidenceState={{
          kind: "ready",
          sessionId: "a0b1c2d3e4f5",
          evidence: [evidence()],
        }}
        sessionId="a0b1c2d3e4f5"
        turns={[turn]}
      />,
    );

    expect(markup).not.toContain('aria-label="Browser evidence"');
  });

  it("keeps the detail link and explains a referenced run with no screenshot artifact", () => {
    const turn: ConversationTurn = {
      ...completed("missing"),
      tools: [
        {
          id: "tool-evidence",
          invocation: "Browser evidence",
          label: "Browser evidence",
          state: "failed",
          output: "scotty-evidence:job-1",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <Conversation
        evidenceState={{
          kind: "ready",
          sessionId: "a0b1c2d3e4f5",
          evidence: [evidence({ status: "failed", frameCount: 0, steps: [] })],
        }}
        sessionId="a0b1c2d3e4f5"
        turns={[turn]}
      />,
    );

    expect(markup).toContain("No screenshots were captured for this run.");
    expect(markup).toContain('href="/s/a0b1c2d3e4f5/evidence/job-1"');
  });

  it("renders a native recording beneath the tool-owned evidence", () => {
    const turn: ConversationTurn = {
      ...completed("video"),
      tools: [
        {
          id: "tool-evidence",
          invocation: "Browser evidence",
          label: "Browser evidence",
          state: "completed",
          output: "scotty-evidence:job-1",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <Conversation
        evidenceState={{
          kind: "ready",
          sessionId: "a0b1c2d3e4f5",
          evidence: [evidence({ recordVideo: true, videoAvailable: true })],
        }}
        sessionId="a0b1c2d3e4f5"
        turns={[turn]}
      />,
    );

    expect(markup).toContain('aria-label="Browser evidence recording"');
    expect(markup).toContain('src="/s/a0b1c2d3e4f5/evidence/job-1/video.webm"');
  });

  it("does not expose evidence loaded for a different session", () => {
    const turn: ConversationTurn = {
      ...completed("isolated"),
      tools: [
        {
          id: "tool-evidence",
          invocation: "Browser evidence",
          label: "Browser evidence",
          state: "completed",
          output: "scotty-evidence:job-1",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <Conversation
        evidenceState={{
          kind: "ready",
          sessionId: "b0b1c2d3e4f5",
          evidence: [evidence()],
        }}
        sessionId="a0b1c2d3e4f5"
        turns={[turn]}
      />,
    );

    expect(markup).toContain("Loading screenshots…");
    expect(markup).not.toContain("frames/frame-1.png");
    expect(markup).not.toContain("/s/b0b1c2d3e4f5/evidence/");
  });
});
