import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { resolveMarkdownImage, type MarkdownEvidence } from "./MarkdownImage";

const sessionId = "a0b1c2d3e4f5";
const evidence: MarkdownEvidence = {
  kind: "ready",
  sessionId,
  evidence: [
    {
      jobId: "job-1",
      status: "succeeded",
      totalSteps: 2,
      completedSteps: 2,
      frameCount: 2,
      recordVideo: false,
      videoAvailable: false,
      steps: [
        { name: "First", status: "passed", frameId: "frame-1" },
        { name: "Second", status: "passed", frameId: "frame-2" },
      ],
    },
  ],
};
const render = (source: string, state: MarkdownEvidence = evidence) =>
  renderToStaticMarkup(<Markdown source={source} sessionId={sessionId} evidence={state} />);

describe("published Markdown images", () => {
  it("uses the first persisted screenshot, preserves alt/title, and works inside links and tables", () => {
    const output = render(
      '| Result |\n| --- |\n| [![Fixed table](scotty-evidence:job-1 "Desktop proof")](https://example.com) |',
    );
    expect(output).toContain("<img");
    expect(output).toContain('alt="Fixed table"');
    expect(output).toContain('title="Desktop proof"');
    expect(output).toContain('src="/s/a0b1c2d3e4f5/evidence/job-1/frames/frame-1.png"');
    expect(output).not.toContain("frame-2.png");
    expect(output.match(/<a /gu)).toHaveLength(1);
  });

  it.each([
    "/workspace/a0b1c2d3e4f5/work/markdown-evidence/after-table-detail.png",
    "../private.png",
    "/etc/passwd",
    "https://example.com/tracker.png",
    "//example.com/tracker.png",
    "data:image/svg+xml;base64,AAAA",
    "file:///etc/passwd",
    "javascript:alert%281%29",
    "/s/a0b1c2d3e4f5/evidence/job-1/frames/frame-1.png",
    "scotty-evidence:../job-1",
    "scotty-evidence:job-1%2fsecret",
    "scotty-evidence:job-1?token=secret",
    "scotty-evidence:job-1#fragment",
    `scotty-evidence:${"a".repeat(129)}`,
  ])("does not request unsupported or unsafe source %s", (source) => {
    const output = render(`![Private image](${source})`);
    expect(output).not.toContain("<img");
    expect(output).not.toContain("src=");
    expect(output).toContain("Image unavailable");
  });

  it("does not resolve another session's evidence or untrusted frame paths", () => {
    expect(
      render("![Result](scotty-evidence:job-1)", { ...evidence, sessionId: "other-session" }),
    ).not.toContain("<img");
    const invalid: MarkdownEvidence = {
      ...evidence,
      evidence: [
        {
          jobId: "job-1",
          status: "succeeded",
          totalSteps: 1,
          completedSteps: 1,
          frameCount: 1,
          recordVideo: false,
          videoAvailable: false,
          steps: [{ name: "Unsafe", status: "passed", frameId: "../secret" }],
        },
      ],
    };
    expect(render("![Result](scotty-evidence:job-1)", invalid)).not.toContain("<img");
    expect(resolveMarkdownImage("scotty-evidence:job-1", "../session", evidence).kind).toBe(
      "unavailable",
    );
  });

  it("reports missing references, frames, metadata errors, and loading distinctly", () => {
    expect(render("![Missing](scotty-evidence:missing)")).toContain("No published screenshot");
    expect(render("![Result](scotty-evidence:job-1)", { ...evidence, evidence: [] })).not.toContain(
      "<img",
    );
    expect(render("![Result](scotty-evidence:job-1)", { kind: "loading", sessionId })).toContain(
      "Loading image: Result",
    );
    expect(
      render("![Result](scotty-evidence:job-1)", {
        kind: "error",
        sessionId,
        message: "private diagnostic",
      }),
    ).toContain("Screenshot details could not be loaded");
    expect(
      render("![Result](scotty-evidence:job-1)", {
        kind: "error",
        sessionId,
        message: "private diagnostic",
      }),
    ).not.toContain("private diagnostic");
  });
});
