import { describe, expect, it } from "vitest";
import { projectDesktopTranscript } from "../src/desktop-transcript.ts";

describe("desktop transcript projection", () => {
  it("preserves assistant text, thinking, and completed tool calls in timeline order", () => {
    expect(
      projectDesktopTranscript(
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
      ),
    ).toEqual([
      { kind: "user", id: "user-1", text: "Review this branch" },
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
    ]);
  });

  it("renders provider failures as explicit error items instead of empty assistant cards", () => {
    const projected = projectDesktopTranscript(
      [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "OAuth refresh failed for openai-codex",
        },
      ],
      [],
    );
    expect(projected).toEqual([
      {
        kind: "error",
        id: "message-0-error",
        message: "OAuth refresh failed for openai-codex",
      },
    ]);
  });

  it("merges live tools, classifies common operations, and redacts hostile values", () => {
    const projected = projectDesktopTranscript(
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-1",
              name: "read",
              arguments: { path: "README.md", credential: "github_pat_secretvalue" },
            },
          ],
        },
      ],
      [
        {
          id: "read-1",
          name: "read",
          arguments: { path: "README.md" },
          partialResult: "github_pat_result-secret",
        },
      ],
    );
    expect(projected).toEqual([
      {
        kind: "tool",
        id: "read-1",
        name: "read",
        summary: "Read file",
        detail: "README.md",
        status: "running",
        result: "[credential]-secret",
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("github_pat_");
  });

  it("keeps unknown remote shapes bounded and redacted", () => {
    const projected = projectDesktopTranscript(
      [{ role: "custom", payload: `github_pat_secret${"x".repeat(4_000)}` }],
      [],
    );
    expect(projected[0]?.kind).toBe("fallback");
    expect(JSON.stringify(projected)).not.toContain("github_pat_");
    expect(JSON.stringify(projected).length).toBeLessThan(2_200);
  });
});
