import { describe, expect, it, vi } from "vitest";
import {
  decideConsoleEligibility,
  fixtureSessionForId,
  readAuthoritativeSession,
  refetchSessionAfterConsoleConflict,
  SESSION_WIRE_VERSION,
} from "./session-reader";

const wireSession = (id: string, lifecycle: "warm" | "sleeping" = "warm") => ({
  version: SESSION_WIRE_VERSION,
  session: {
    identity: { id },
    authority: { kind: "stable", lifecycle, failure: null },
    runtime: {
      provider: "cloudflare",
      readiness: lifecycle === "warm" ? "unchecked" : "not-applicable",
    },
    capabilities:
      lifecycle === "warm"
        ? { checkpoint: true, sleep: true, resume: false, work: true, vaporize: true }
        : { checkpoint: false, sleep: false, resume: true, work: false, vaporize: true },
    display: {
      title: "Boundary test",
      repository: "personal/scotty",
      branch: "feat/boundary-test",
      defaultBranch: "main",
    },
    times: { capRemainingSeconds: 4_200 },
  },
});

describe("readAuthoritativeSession", () => {
  it("decodes the strict versioned UI response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(wireSession("abc-123")));
    const result = await readAuthoritativeSession("abc-123", { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/abc-123",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toMatchObject({
      ok: true,
      session: {
        id: "abc-123",
        authority: { kind: "stable", lifecycle: "warm" },
        runtime: { readiness: "unchecked" },
        source: "authority",
      },
    });
  });

  it("rejects legacy, excess, and wrong-session responses", async () => {
    const responses = [
      { id: "abc-123", status: "warm" },
      { ...wireSession("abc-123"), permit: "must-not-cross" },
      wireSession("another-session"),
    ];
    for (const response of responses) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(response));
      await expect(
        readAuthoritativeSession("abc-123", { fetch: fetchMock }),
      ).resolves.toMatchObject({
        ok: false,
        classification: "malformed",
      });
    }
  });

  it("accepts null branch identity for a Gone tombstone", async () => {
    const response = wireSession("gone-123");
    const tombstone = {
      ...response,
      session: {
        ...response.session,
        authority: { kind: "stable", lifecycle: "gone", failure: null },
        runtime: { provider: "cloudflare", readiness: "not-applicable" },
        capabilities: {
          checkpoint: false,
          sleep: false,
          resume: false,
          work: false,
          vaporize: false,
        },
        display: { ...response.session.display, branch: null, defaultBranch: null },
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(tombstone));
    const result = await readAuthoritativeSession("gone-123", { fetch: fetchMock });
    expect(result).toMatchObject({ ok: true, session: { display: { branch: null } } });
  });

  it("accepts the public transition shape and rejects actor-internal origin", async () => {
    const response = wireSession("resume-123");
    const transition = {
      ...response,
      session: {
        ...response.session,
        authority: {
          kind: "transitioning",
          action: "resume",
          phase: "BackupRestoring",
          mode: "executing",
          startedAt: "2026-09-03T15:48:00.000Z",
        },
        runtime: { provider: "cloudflare", readiness: "not-applicable" },
        capabilities: {
          checkpoint: false,
          sleep: false,
          resume: false,
          work: false,
          vaporize: false,
        },
      },
    };
    const accepted = await readAuthoritativeSession("resume-123", {
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(transition)),
    });
    expect(accepted).toMatchObject({
      ok: true,
      session: { authority: { kind: "transitioning", action: "resume" } },
    });

    const rejected = await readAuthoritativeSession("resume-123", {
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json({
          ...transition,
          session: {
            ...transition.session,
            authority: { ...transition.session.authority, origin: "sleeping" },
          },
        }),
      ),
    });
    expect(rejected).toMatchObject({ ok: false, classification: "malformed" });
  });

  it("rejects semantically impossible authority, runtime, and capability combinations", async () => {
    const warm = wireSession("abc-123");
    const impossible = [
      {
        ...warm,
        session: {
          ...warm.session,
          runtime: { provider: "cloudflare", readiness: "not-applicable" },
        },
      },
      {
        ...warm,
        session: {
          ...warm.session,
          authority: { kind: "stable", lifecycle: "failed", failure: null },
        },
      },
      {
        ...warm,
        session: {
          ...warm.session,
          authority: {
            kind: "transitioning",
            action: "resume",
            phase: "BackupRestoring",
            mode: "executing",
            startedAt: "2026-09-03T15:48:00.000Z",
          },
        },
      },
      {
        ...warm,
        session: {
          ...warm.session,
          display: { ...warm.session.display, branch: null },
        },
      },
    ];
    for (const response of impossible) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(response));
      await expect(
        readAuthoritativeSession("abc-123", { fetch: fetchMock }),
      ).resolves.toMatchObject({
        ok: false,
        classification: "malformed",
      });
    }
  });

  it("uses known demo fixtures without a network request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await readAuthoritativeSession("warm-demo-01", {
      fetch: fetchMock,
      fixtureFallback: true,
    });
    expect(result).toMatchObject({ ok: true, session: { source: "fixture" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches the canonical authority after a typed console 409", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(wireSession("sleep-123", "sleeping")));
    const result = await refetchSessionAfterConsoleConflict(
      "sleep-123",
      Response.json(
        { status: "unavailable", reason: "session_operation_active", retryable: false },
        { status: 409 },
      ),
      { fetch: fetchMock },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      session: { authority: { kind: "stable", lifecycle: "sleeping" } },
    });
  });
});

describe("decideConsoleEligibility", () => {
  it("admits only stable warm authority", () => {
    const warm = fixtureSessionForId("warm-demo-01");
    const sleeping = fixtureSessionForId("sleep-demo-01");
    const transitioning = fixtureSessionForId("resume-demo-01");
    expect(warm && decideConsoleEligibility(warm)).toEqual({ eligible: true });
    expect(sleeping && decideConsoleEligibility(sleeping)).toEqual({
      eligible: false,
      reason: "not-warm",
    });
    expect(transitioning && decideConsoleEligibility(transitioning)).toEqual({
      eligible: false,
      reason: "lifecycle-operation",
    });
  });
});
