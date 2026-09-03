import { describe, expect, it, vi } from "vitest";
import {
  buildCreateSessionPayload,
  createSession,
  decodeCreateSessionResponse,
} from "./session-creator";

const origin = "https://scotty.example.test";
const success = {
  id: "session-1",
  title: "Ship the UI",
  url: `${origin}/s/session-1`,
  branch: "scotty/session-1",
  provider: "cloudflare",
  status: "warm",
} as const;

describe("create session boundary", () => {
  it("builds the accepted payload and omits the optional cap by default", () => {
    expect(
      buildCreateSessionPayload({
        title: "  Ship the UI  ",
        repository: " owner/project ",
        prompt: "  Add the form\r\nand test it.  ",
      }),
    ).toEqual({
      ok: true,
      payload: {
        title: "Ship the UI",
        repo: "owner/project",
        prompt: "Add the form\nand test it.",
        provider: "cloudflare",
      },
    });
    expect(
      buildCreateSessionPayload({
        title: "Ship the UI",
        repository: "owner/project",
        prompt: "Add the form.",
        hardCapSeconds: "3600",
      }),
    ).toMatchObject({ ok: true, payload: { hardCapSeconds: 3600 } });
  });

  it("reports field validation before a request is made", () => {
    expect(
      buildCreateSessionPayload({ title: "", repository: "owner/project", prompt: "work" }),
    ).toEqual({ ok: false, field: "title", message: "Enter a session title." });
    expect(
      buildCreateSessionPayload({ title: "Title", repository: "owner", prompt: "work" }),
    ).toMatchObject({ ok: false, field: "repository" });
    expect(
      buildCreateSessionPayload({
        title: "Title",
        repository: "owner/project",
        prompt: "work",
        hardCapSeconds: "30",
      }),
    ).toMatchObject({ ok: false, field: "hardCapSeconds" });
  });

  it("posts once with one idempotency key and decodes the strict success", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(success));
    const payload = {
      title: "Ship the UI",
      repo: "owner/project",
      prompt: "Add the form.",
      provider: "cloudflare" as const,
      hardCapSeconds: 3_600,
    };
    await expect(
      createSession(payload, {
        fetch: fetchMock,
        idempotencyKey: "create-attempt-001",
        origin,
      }),
    ).resolves.toEqual({
      ok: true,
      session: { ...success, path: "/s/session-1" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": "create-attempt-001",
        },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual(payload);
  });

  it("rejects redirects, excess fields, and mismatched response ids", () => {
    expect(decodeCreateSessionResponse(success, origin)).toMatchObject({
      id: "session-1",
      path: "/s/session-1",
    });
    expect(
      decodeCreateSessionResponse({ ...success, url: `${origin}/s/session-1?next=else` }, origin),
    ).toBeUndefined();
    expect(
      decodeCreateSessionResponse({ ...success, url: "https://evil.example/s/session-1" }, origin),
    ).toBeUndefined();
    expect(decodeCreateSessionResponse({ ...success, id: "other-1" }, origin)).toBeUndefined();
    expect(
      decodeCreateSessionResponse({ ...success, private: "must not cross" }, origin),
    ).toBeUndefined();
  });

  it("preserves typed HTTP failures and does not fabricate success", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "bad_request",
            message: "repo must be in owner/name form",
            hint: "Use owner/project",
          },
        },
        { status: 400 },
      ),
    );
    await expect(
      createSession(
        { title: "Title", repo: "bad", prompt: "work", provider: "cloudflare" },
        { fetch: fetchMock, idempotencyKey: "create-attempt-002", origin },
      ),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "http",
        status: 400,
        code: "bad_request",
        message: "repo must be in owner/name form",
        hint: "Use owner/project",
      },
    });

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...success, url: `${origin}/s/session-1?unsafe=1` }));
    await expect(
      createSession(
        { title: "Title", repo: "owner/project", prompt: "work", provider: "cloudflare" },
        { fetch: malformed, idempotencyKey: "create-attempt-003", origin },
      ),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: "malformed-response",
        message: "Scotty returned an unexpected session response.",
      },
    });
  });
});
