import { describe, expect, it } from "vitest";
import { projectDesktopTranscript } from "../src/desktop-transcript.ts";

describe("desktop transcript projection", () => {
  it("preserves assistant text, thinking, and completed tool calls in timeline order", () => {
    const projected = projectDesktopTranscript(
      [
        { role: "user", content: "Review this branch", id: "user-1" },
        {
          role: "assistant",
          id: "assistant-1",
          content: [
            { type: "thinking", thinking: "I should inspect the diff" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git diff" } },
            { type: "text", text: "The branch is clean." },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "3 files changed" }],
          isError: false,
        },
      ],
      [],
    );
    expect(projected).toEqual({
      truncated: false,
      items: [
        { kind: "user", id: "user-1", text: "Review this branch", imageCount: 0 },
        {
          kind: "thinking",
          id: "assistant-1-part-0",
          text: "I should inspect the diff",
        },
        {
          kind: "tool",
          id: "call-1",
          name: "bash",
          summary: "Ran command",
          detail: "git diff",
          status: "completed",
          result: "3 files changed",
        },
        {
          kind: "assistant",
          id: "assistant-1-part-2",
          text: "The branch is clean.",
        },
      ],
    });
  });

  it("renders every terminal assistant stop reason", () => {
    const projected = projectDesktopTranscript(
      [
        {
          role: "assistant",
          timestamp: 1,
          content: [],
          stopReason: "error",
        },
        {
          role: "assistant",
          timestamp: 2,
          content: [],
          stopReason: "length",
        },
        {
          role: "assistant",
          timestamp: 3,
          content: [],
          stopReason: "aborted",
        },
      ],
      [],
    );
    expect(projected.items).toEqual([
      {
        kind: "error",
        id: "message-assistant-1-error",
        message: "Unknown provider error",
      },
      {
        kind: "notice",
        id: "message-assistant-2-length",
        title: "Response incomplete",
        message: "The model reached its output token limit.",
        tone: "warning",
      },
      {
        kind: "notice",
        id: "message-assistant-3-aborted",
        title: "Response stopped",
        message: "The request was aborted.",
        tone: "info",
      },
    ]);
  });

  it("drops hidden custom messages and projects only visible custom content", () => {
    const projected = projectDesktopTranscript(
      [
        {
          role: "custom",
          customType: "hidden",
          content: "plain-secret",
          details: { secret: "plain-secret" },
          display: false,
          timestamp: 1,
        },
        {
          role: "custom",
          customType: "review",
          content: [
            { type: "text", text: "Visible update" },
            { type: "image", data: "raw" },
          ],
          details: { secret: "plain-secret" },
          display: true,
          timestamp: 2,
        },
      ],
      [],
    );
    expect(projected.items).toEqual([
      {
        kind: "notice",
        id: "message-custom-2",
        title: "review",
        message: "Visible update",
        tone: "info",
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("plain-secret");
  });

  it("projects mixed media and Pi summary messages without exposing image payloads", () => {
    const projected = projectDesktopTranscript(
      [
        {
          role: "user",
          timestamp: 1,
          content: [
            { type: "text", text: "Review this screenshot" },
            { type: "image", data: "base64-secret", mimeType: "image/png" },
          ],
        },
        {
          role: "bashExecution",
          timestamp: 2,
          command: "npm test",
          output: "passed",
          exitCode: 0,
          cancelled: false,
        },
        { role: "branchSummary", timestamp: 3, summary: "Returned from branch", fromId: "x" },
        {
          role: "compactionSummary",
          timestamp: 4,
          summary: "Earlier work",
          tokensBefore: 10,
        },
      ],
      [],
    );
    expect(projected.items.map((item) => item.kind)).toEqual(["user", "tool", "notice", "notice"]);
    expect(projected.items[0]).toMatchObject({
      text: "Review this screenshot",
      imageCount: 1,
    });
    expect(JSON.stringify(projected)).not.toContain("base64-secret");
  });

  it("merges live tools, classifies task operations, and redacts hostile values", () => {
    const projected = projectDesktopTranscript(
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "task-1",
              name: "TaskCreate",
              arguments: { subject: "Review", credential: "github_pat_secretvalue" },
            },
          ],
        },
      ],
      [
        {
          id: "task-1",
          name: "TaskCreate",
          arguments: { subject: "Review" },
          partialResult: "github_pat_result-secret",
        },
      ],
    );
    expect(projected.items).toEqual([
      {
        kind: "tool",
        id: "task-1",
        name: "TaskCreate",
        summary: "Created task",
        detail: "Review",
        status: "running",
        result: "[credential]-secret",
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("github_pat_");
  });

  it("bounds allocation and reports transcript loss", () => {
    const messages = Array.from({ length: 2_100 }, (_, index) => ({
      role: "user",
      timestamp: index,
      content: `message-${index}`,
    }));
    const projected = projectDesktopTranscript(messages, []);
    expect(projected.truncated).toBe(true);
    expect(projected.items).toHaveLength(2_000);
    expect(projected.items[0]).toMatchObject({ text: "message-100" });
    expect(projected.items.at(-1)).toMatchObject({ text: "message-2099" });
  });

  it("never splits Unicode surrogate pairs at projection bounds", () => {
    const projected = projectDesktopTranscript(
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: `${"a".repeat(255)}😀`,
              arguments: {},
            },
          ],
        },
      ],
      [],
    );
    const tool = projected.items[0];
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool") throw new Error("expected projected tool");
    expect(tool.name).toBe("a".repeat(255));
    expect(JSON.stringify(projected)).not.toContain("\\ud83d");
  });

  it("keeps unsupported shapes bounded without serializing their payload", () => {
    const projected = projectDesktopTranscript(
      [{ role: "unknown", payload: `plain-secret-${"x".repeat(4_000)}` }],
      [],
    );
    expect(projected.items).toEqual([
      {
        kind: "fallback",
        id: "message-unknown-0",
        text: "Unsupported unknown message",
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("plain-secret");
  });
});
