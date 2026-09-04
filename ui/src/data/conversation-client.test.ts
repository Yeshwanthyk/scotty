import { describe, expect, it, vi } from "vitest";
import {
  decodeConversationSnapshot,
  readConversation,
  steerConversation,
} from "./conversation-client";

const snapshot = {
  version: 1,
  transport: {
    epoch: "epoch-1",
    baseSequence: 3,
    sequence: 7,
    sessionRevision: 2,
  },
  turns: [
    {
      id: "turn-1",
      state: "streaming",
      user: "Inspect the session console",
      activitySummary: "1 action in progress",
      tools: [
        {
          id: "tool-1",
          state: "running",
          label: "Reading project",
          invocation: "read(README.md)",
        },
      ],
      assistant: "The transport is connected.",
    },
  ],
  truncated: { turns: false, values: false },
} as const;

describe("conversation client boundary", () => {
  it("strictly decodes the canonical conversation projection", () => {
    expect(decodeConversationSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeConversationSnapshot({ ...snapshot, privateState: true })).toBeUndefined();
    expect(
      decodeConversationSnapshot({
        ...snapshot,
        turns: [{ ...snapshot.turns[0], state: "unknown" }],
      }),
    ).toBeUndefined();
    expect(
      decodeConversationSnapshot({
        ...snapshot,
        turns: [{ ...snapshot.turns[0], elapsedSeconds: 7 * 24 * 60 * 60 + 1 }],
      }),
    ).toBeUndefined();
  });

  it("reads a same-origin snapshot without caching it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(snapshot));
    await expect(readConversation("session-1", { fetch: fetchMock })).resolves.toEqual({
      ok: true,
      snapshot,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/conversation",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      }),
    );
  });

  it("preserves typed read failures instead of fabricating readiness", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "upstream", message: "Conversation snapshot is unavailable" } },
          { status: 502 },
        ),
      );
    await expect(readConversation("session-1", { fetch: fetchMock })).resolves.toEqual({
      ok: false,
      failure: {
        kind: "http",
        status: 502,
        code: "upstream",
        message: "Conversation snapshot is unavailable",
      },
    });
  });

  it("submits one authenticated steer and classifies ambiguous outcomes", async () => {
    const acceptedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        id: "session-1",
        status: "accepted",
        commandId: "command-1",
        epoch: "epoch-1",
        sessionRevision: 2,
      }),
    );
    await expect(
      steerConversation("session-1", "Continue the investigation", { fetch: acceptedFetch }),
    ).resolves.toEqual({ ok: true, status: "accepted" });
    expect(acceptedFetch).toHaveBeenCalledWith(
      "/api/sessions/session-1/steer",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ message: "Continue the investigation" }),
      }),
    );

    const ambiguousFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        id: "session-1",
        status: "ambiguous",
        reason: "command_transport_failed",
      }),
    );
    await expect(
      steerConversation("session-1", "Do not send twice", { fetch: ambiguousFetch }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "ambiguous",
        message: "Delivery could not be confirmed. Check the conversation before sending again.",
      },
    });
  });
});
