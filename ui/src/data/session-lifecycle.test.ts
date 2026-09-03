import { describe, expect, it, vi } from "vitest";
import { decodeSessionMutationSuccess, mutateSessionLifecycle } from "./session-lifecycle";

describe("session lifecycle boundary", () => {
  it.each([
    ["checkpoint", "POST", "/api/sessions/session-1/checkpoint", "warm"],
    ["sleep", "POST", "/api/sessions/session-1/sleep", "sleeping"],
    ["resume", "POST", "/api/sessions/session-1/resume", "warm"],
    ["vaporize", "DELETE", "/api/sessions/session-1", "gone"],
  ] as const)("calls the canonical %s endpoint once", async (action, method, path, status) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "session-1", status }));

    await expect(
      mutateSessionLifecycle("session-1", action, { fetch: fetchMock }),
    ).resolves.toEqual({
      ok: true,
      value: { action, id: "session-1", status },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ method, credentials: "same-origin" }),
    );
  });

  it("rejects a 2xx body that cannot prove the requested action's result", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "session-1", status: "warm", error: "not a contract" }),
      );
    await expect(
      mutateSessionLifecycle("session-1", "sleep", { fetch: fetchMock }),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: "malformed-response" },
      classification: "malformed",
    });
    expect(
      decodeSessionMutationSuccess({ id: "other", status: "warm" }, "session-1", "resume"),
    ).toBe(undefined);
  });

  it("classifies typed 409 responses for reconciliation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "conflict", message: "Session is already changing" } },
          { status: 409 },
        ),
      );
    await expect(
      mutateSessionLifecycle("session-1", "checkpoint", { fetch: fetchMock }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "http",
        status: 409,
        code: "conflict",
        message: "Session is already changing",
      },
      classification: "conflict",
    });
  });

  it("returns an actionable network failure without fabricating success", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline"));
    await expect(
      mutateSessionLifecycle("session-1", "resume", { fetch: fetchMock }),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: "network" },
      classification: "other",
    });
  });
});
