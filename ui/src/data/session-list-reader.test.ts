import { describe, expect, it, vi } from "vitest";
import { decodeSessionListResponse, readSessionList } from "./session-list-reader";

const listItem = (id: string) => ({
  identity: { id },
  selection: { agent: "codex", model: "gpt-5.6-sol", effort: "medium" },
  authority: { kind: "stable", lifecycle: "warm", failure: null },
  runtime: { provider: "cloudflare", readiness: "unchecked" },
  capabilities: { checkpoint: true, sleep: true, resume: false, work: true, vaporize: true },
  display: {
    title: `Session ${id}`,
    repository: "personal/scotty",
    branch: `feat/${id}`,
    defaultBranch: "main",
  },
  times: { capRemainingSeconds: 3_600 },
  projection: { projectedAt: "2026-09-03T16:00:00.000Z" },
});

describe("session list boundary", () => {
  it("strictly decodes the versioned list and marks rows as projections", () => {
    expect(decodeSessionListResponse({ version: 1, sessions: [listItem("session-1")] })).toEqual([
      expect.objectContaining({
        projectedAt: "2026-09-03T16:00:00.000Z",
        session: expect.objectContaining({
          id: "session-1",
          selection: { agent: "codex", model: "gpt-5.6-sol", effort: "medium" },
          source: "projection",
        }),
      }),
    ]);
  });

  it("rejects excess fields, duplicate identities, invalid timestamps, and old transition shape", () => {
    const transition = {
      ...listItem("transition-1"),
      authority: {
        kind: "transitioning",
        action: "resume",
        phase: "BackupRestoring",
        mode: "executing",
        startedAt: "2026-09-03T15:59:00.000Z",
      },
      runtime: { provider: "cloudflare", readiness: "not-applicable" },
      capabilities: {
        checkpoint: false,
        sleep: false,
        resume: false,
        work: false,
        vaporize: false,
      },
    };
    expect(decodeSessionListResponse({ version: 1, sessions: [transition] })).toHaveLength(1);
    expect(
      decodeSessionListResponse({
        version: 1,
        sessions: [{ ...transition, authority: { ...transition.authority, origin: "sleeping" } }],
      }),
    ).toBeUndefined();
    expect(
      decodeSessionListResponse({ version: 1, sessions: [{ ...listItem("a"), private: true }] }),
    ).toBeUndefined();
    expect(
      decodeSessionListResponse({ version: 1, sessions: [listItem("a"), listItem("a")] }),
    ).toBeUndefined();
    expect(
      decodeSessionListResponse({
        version: 1,
        sessions: [{ ...listItem("a"), projection: { projectedAt: "not-a-date" } }],
      }),
    ).toBeUndefined();
  });
  it("bypasses browser HTTP caches", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: 1, sessions: [] }));

    await readSessionList({ fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});
