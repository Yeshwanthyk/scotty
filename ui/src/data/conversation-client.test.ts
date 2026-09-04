import { describe, expect, it, vi } from "vitest";
import {
  decodeConversationSnapshot,
  isConversationLifecycleMismatch,
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
  queue: { steer: [], followUp: [] },
  truncated: { turns: false, values: false },
} as const;

describe("conversation client boundary", () => {
  it("distinguishes a lifecycle transition from a network reconnect", () => {
    expect(
      isConversationLifecycleMismatch({
        kind: "http",
        status: 409,
        code: "wrong_state",
        message: "Session is sleeping",
      }),
    ).toBe(true);
    expect(
      isConversationLifecycleMismatch({ kind: "network", message: "Scotty could not be reached." }),
    ).toBe(false);
  });

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

  it("retains the bounded steer and follow-up queue", () => {
    const queued = {
      ...snapshot,
      queue: {
        steer: [{ id: "steer-1", text: "Adjust the current approach" }],
        followUp: [{ id: "follow-up-1", text: "Then run the browser proof" }],
      },
    };
    expect(decodeConversationSnapshot(queued)?.queue).toEqual(queued.queue);
    expect(
      decodeConversationSnapshot({
        ...queued,
        queue: { ...queued.queue, followUp: [{ id: "", text: "invalid" }] },
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
