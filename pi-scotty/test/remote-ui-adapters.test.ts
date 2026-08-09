import { describe, expect, it } from "vitest";
import type { Schema } from "effect";
import { redactRemoteString } from "../src/redaction.ts";
import { adaptRemoteMessage, adaptRemoteTool } from "../src/remote-ui-adapters.ts";

type AssistantFixture = {
  readonly role: string;
  readonly content: Schema.Json;
  readonly stopReason: string;
  readonly timestamp: number;
};

const assistant = (content: Schema.Json, overrides: Partial<AssistantFixture> = {}) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  timestamp: 42,
  ...overrides,
});

describe("untrusted remote Pi UI adapters", () => {
  it("removes 7-bit and 8-bit terminal control sequences", () => {
    const rendered = redactRemoteString("safe\u001b[31m red\u009b32m green\u009d0;title\u009c end");
    expect(rendered).toBe("safe red32m green0;title end");
    expect(rendered).not.toContain("\u001b");
    expect(
      [...rendered].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x80 || codePoint > 0x9f;
      }),
    ).toBe(true);
  });

  it("adapts only supported user and assistant content into Pi component inputs", () => {
    expect(adaptRemoteMessage({ role: "user", content: "hello" })).toEqual({
      kind: "user",
      text: "hello",
    });

    const adapted = adaptRemoteMessage(
      assistant([
        { type: "thinking", thinking: "considering" },
        { type: "text", text: "done" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      ]),
    );
    expect(adapted.kind).toBe("assistant");
    if (adapted.kind !== "assistant") return;
    expect(adapted.message.content).toEqual([
      { type: "thinking", thinking: "considering" },
      { type: "text", text: "done" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(adapted.tools[0]?.presentationName).toBe("read (remote)");
  });

  it("uses bounded redacted fallback for custom, malformed, and image messages", () => {
    const credential = "github_pat_secretvalue";
    const adapted = [
      { role: "custom", content: credential },
      assistant([{ type: "image", data: credential, mimeType: "image/png" }]),
      assistant([{ type: "toolCall", id: "bad", name: credential, arguments: "not-an-object" }]),
    ].map(adaptRemoteMessage);
    expect(adapted.map((entry) => entry.kind)).toEqual(["fallback", "fallback", "fallback"]);
    const text = adapted.map((entry) => (entry.kind === "fallback" ? entry.text : ""));
    expect(text.every((value) => value.includes("[credential]"))).toBe(true);
    expect(text.every((value) => !value.includes(credential))).toBe(true);
    expect(text.every((value) => value.length <= 2_000)).toBe(true);
  });

  it("forces every remote tool call through generic presentation", () => {
    expect(
      adaptRemoteTool({ id: "edit-1", name: "edit", arguments: { path: "/host/secret" } })
        .presentationName,
    ).toBe("edit (remote)");
    expect(
      adaptRemoteTool({ id: "custom-1", name: "extension_tool", arguments: { value: 1 } })
        .presentationName,
    ).toBe("extension_tool (remote)");
    expect(adaptRemoteTool({ id: "read-1", name: "read", arguments: "bad" })).toMatchObject({
      presentationName: "read (remote)",
      arguments: {},
    });
  });

  it("adapts text-only tool results without retaining images or details", () => {
    expect(
      adaptRemoteMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "safe output" }],
        details: { hostOnly: true },
        isError: false,
      }),
    ).toEqual({
      kind: "tool_result",
      result: {
        toolCallId: "call-1",
        toolName: "read",
        text: "safe output",
        isError: false,
      },
    });
  });
});
