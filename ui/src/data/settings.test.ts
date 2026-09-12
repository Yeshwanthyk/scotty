import { describe, expect, it, vi } from "vitest";
import {
  addRepository,
  decodeCloudSettings,
  decodeCloudSettingsSnapshot,
  readCloudSettings,
  removeRepository,
  updateCloudSettings,
} from "./settings";

const settings = {
  agent: "pi" as const,
  pi: { agent: "pi" as const, modelProvider: "openai", model: "gpt-5.4", effort: "high" as const },
  codex: { agent: "codex" as const, model: "gpt-5.6-sol", effort: "high" as const },
  environment: { APP_ENV: "staging" },
};

const snapshot = { revision: 4, activeDigest: null, settings };
const repository = {
  repo: "acme/project",
  defaultBranch: "main",
  addedAt: "2026-09-03T12:00:00.000Z",
  lastUsedAt: "2026-09-03T12:00:00.000Z",
};

describe("cloud settings response boundaries", () => {
  it("decodes canonical settings and rejects excess or protected data", () => {
    expect(decodeCloudSettings(settings)).toEqual(settings);
    expect(decodeCloudSettings({ ...settings, secret: "must not cross" })).toBeUndefined();
    expect(decodeCloudSettings({ ...settings, environment: { PATH: "/tmp" } })).toBeUndefined();
    expect(decodeCloudSettingsSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeCloudSettingsSnapshot({ ...snapshot, revision: -1 })).toBeUndefined();
  });

  it("uses the settings and repository mutation contracts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/settings" && init?.method === "PUT") return Response.json(snapshot);
      if (path === "/api/settings") return Response.json(snapshot);
      if (path === "/api/repos" && init?.method === "POST") return Response.json(repository);
      return Response.json({ repo: repository.repo, removed: true });
    });

    await expect(readCloudSettings({ fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: snapshot,
    });
    await expect(
      updateCloudSettings({ expectedRevision: 4, settings }, { fetch: fetchMock }),
    ).resolves.toEqual({ ok: true, value: snapshot });
    await expect(addRepository(repository.repo, { fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: repository,
    });
    await expect(removeRepository(repository.repo, { fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: { repo: repository.repo, removed: true },
    });

    const [, updateInit] = fetchMock.mock.calls[1] ?? [];
    expect(updateInit?.method).toBe("PUT");
    expect(updateInit?.headers).toEqual(
      expect.objectContaining({
        "content-type": "application/json",
        "idempotency-key": expect.any(String),
      }),
    );
    expect(JSON.parse(String(updateInit?.body))).toEqual(
      expect.objectContaining({ expectedRevision: 4, settings }),
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/repos/acme/project");
  });
});
