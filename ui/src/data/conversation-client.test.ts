import { describe, expect, it, vi } from "vitest";
import {
  decodeConversationSnapshot,
  interruptConversation,
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

  it.each(["completed", "streaming", "failed", "aborted"])(
    "preserves the %s turn state through decoding and reading",
    async (state) => {
      const expected = {
        ...snapshot,
        turns: [{ ...snapshot.turns[0], state }],
      };
      expect(decodeConversationSnapshot(expected)).toEqual(expected);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(expected));
      await expect(readConversation("session-1", { fetch: fetchMock })).resolves.toEqual({
        ok: true,
        snapshot: expected,
      });
    },
  );

  it.each([
    { label: "unknown state", turn: { ...snapshot.turns[0], state: "cancelled" } },
    { label: "non-string state", turn: { ...snapshot.turns[0], state: null } },
    { label: "non-object turn", turn: null },
    { label: "missing fields", turn: { id: "turn-1", state: "failed" } },
    {
      label: "unexpected field",
      turn: { ...snapshot.turns[0], state: "failed", privateState: true },
    },
    {
      label: "malformed assistant",
      turn: { ...snapshot.turns[0], state: "aborted", assistant: null },
    },
    {
      label: "malformed tools",
      turn: { ...snapshot.turns[0], state: "failed", tools: {} },
    },
    {
      label: "malformed tool",
      turn: { ...snapshot.turns[0], state: "aborted", tools: [{ id: "tool-1" }] },
    },
  ])("rejects $label through decoding and reading", async ({ turn }) => {
    const malformed = { ...snapshot, turns: [turn] };
    expect(decodeConversationSnapshot(malformed)).toBeUndefined();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(malformed));
    await expect(readConversation("session-1", { fetch: fetchMock })).resolves.toEqual({
      ok: false,
      failure: {
        kind: "malformed-response",
        message: "Scotty returned an unreadable conversation snapshot.",
      },
    });
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

    const ambiguousHttpFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          id: "session-1",
          status: "ambiguous",
          reason: "codex_message_admission_unknown",
          retryable: false,
        },
        { status: 502 },
      ),
    );
    await expect(
      steerConversation("session-1", "Classify the unknown delivery", {
        fetch: ambiguousHttpFetch,
      }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "ambiguous",
        message: "Delivery could not be confirmed. Check the conversation before sending again.",
      },
    });
  });

  it("submits a fenced interrupt and preserves an unconfirmed outcome", async () => {
    const acceptedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          id: "session-1",
          status: "accepted",
          turnId: "turn-1",
          sessionRevision: 2,
        },
        { status: 202 },
      ),
    );
    await expect(
      interruptConversation("session-1", "turn-1", 2, { fetch: acceptedFetch }),
    ).resolves.toEqual({ ok: true, status: "accepted" });
    expect(acceptedFetch).toHaveBeenCalledWith(
      "/api/sessions/session-1/interrupt",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ turnId: "turn-1", sessionRevision: 2 }),
      }),
    );

    const ambiguousFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          id: "session-1",
          status: "ambiguous",
          reason: "codex_interrupt_unknown",
          retryable: false,
        },
        { status: 502 },
      ),
    );
    await expect(
      interruptConversation("session-1", "turn-1", 2, { fetch: ambiguousFetch }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "ambiguous",
        message:
          "The stop request could not be confirmed. Inspect the latest conversation before retrying.",
      },
    });

    const lostFetch = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("socket closed"));
    await expect(
      interruptConversation("session-1", "turn-1", 2, { fetch: lostFetch }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "ambiguous",
        message:
          "The stop request could not be confirmed. Inspect the latest conversation before retrying.",
      },
    });

    const unreadableSuccessFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "session-1", status: "accepted" }));
    await expect(
      interruptConversation("session-1", "turn-1", 2, { fetch: unreadableSuccessFetch }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "ambiguous",
        message:
          "The stop request could not be confirmed. Inspect the latest conversation before retrying.",
      },
    });
  });

  it.each(["message", "steer"] as const)(
    "accepts a Codex %s admission only for the requested session",
    async (mode) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json({
          id: "session-1",
          status: "accepted",
          mode,
          turnId: "turn-2",
          sessionRevision: 2,
        }),
      );
      await expect(
        steerConversation("session-1", "Continue the investigation", { fetch: fetchMock }),
      ).resolves.toEqual({ ok: true, status: "accepted" });
      const wrongSession = vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json({
          id: "other-session",
          status: "accepted",
          mode,
          turnId: "turn-2",
          sessionRevision: 2,
        }),
      );
      await expect(
        steerConversation("session-1", "Continue the investigation", { fetch: wrongSession }),
      ).resolves.toEqual({
        ok: false,
        failure: {
          kind: "malformed-response",
          message: "Scotty returned an unreadable delivery result.",
        },
      });
    },
  );
});

describe("queued follow-up public intent", () => {
  it("advertises Codex queue capability and preserves blocked delivery state", () => {
    expect(
      decodeConversationSnapshot({ ...snapshot, followUpAvailable: true, followUpBlocked: true }),
    ).toMatchObject({ followUpAvailable: true, followUpBlocked: true });
    expect(decodeConversationSnapshot({ ...snapshot, followUpAvailable: "yes" })).toBeUndefined();
  });
  it("sends explicit follow-up intent with the same client ID on retry", async () => {
    const requests = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce(
        Response.json({ id: "session-1", status: "accepted", mode: "followUp" }, { status: 202 }),
      );
    const options = {
      fetch: requests,
      deliverAs: "followUp",
      clientUserMessageId: "stable-client-id",
    } as const;
    expect((await steerConversation("session-1", "Later", options)).ok).toBe(false);
    expect((await steerConversation("session-1", "Later", options)).ok).toBe(true);
    expect(requests).toHaveBeenNthCalledWith(
      1,
      "/api/sessions/session-1/steer",
      expect.objectContaining({
        headers: expect.objectContaining({ "idempotency-key": "stable-client-id" }),
        body: JSON.stringify({ message: "Later", deliverAs: "followUp" }),
      }),
    );
    expect(requests).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/session-1/steer",
      expect.objectContaining({
        headers: expect.objectContaining({ "idempotency-key": "stable-client-id" }),
        body: JSON.stringify({ message: "Later", deliverAs: "followUp" }),
      }),
    );
  });
});
