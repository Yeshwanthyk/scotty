import { describe, expect, it, vi } from "vitest";
import {
  decodeProviders,
  decodeRunners,
  decodeStatsSnapshot,
  issuePairing,
  readCurrentPrincipal,
  readDevices,
  readProviders,
  readRunners,
  readStats,
  type AdminRequestOptions,
} from "./admin";

type Fetch = NonNullable<AdminRequestOptions["fetch"]>;

const timestamp = "2026-09-03T12:00:00.000Z";

const stats = {
  trackingSince: timestamp,
  overall: { workspacesCreated: 4, projects: 1, warmNow: 2, sleepingNow: 1 },
  projects: [
    {
      repository: "scotty-dev/scotty",
      workspacesCreated: 4,
      warmNow: 2,
      sleepingNow: 1,
      lastCreated: timestamp,
    },
  ],
};

const providers = [
  { name: "cloudflare", status: "configured" },
  { name: "runner", status: "available" },
] as const;

const runners = [
  {
    name: "desk-runner",
    desired: "accepting",
    connection: "connected",
    lastSeenAt: timestamp,
    assignedSessions: 2,
  },
] as const;

describe("admin response boundaries", () => {
  it("accepts the canonical stats, provider, and runner shapes", () => {
    expect(decodeStatsSnapshot(stats)).toEqual(stats);
    expect(decodeProviders(providers)).toEqual(providers);
    expect(decodeRunners(runners)).toEqual(runners);
  });

  it("rejects malformed and excess response data", () => {
    expect(
      decodeStatsSnapshot({
        ...stats,
        overall: { ...stats.overall, warmNow: -1 },
      }),
    ).toBeUndefined();
    expect(decodeProviders([{ ...providers[0], secret: "must not cross" }])).toBeUndefined();
    expect(decodeRunners([{ ...runners[0], assignedSessions: 1.5 }])).toBeUndefined();
  });

  it("reads stats, providers, runners, and the current principal from canonical endpoints", async () => {
    const responses = new Map<string, unknown>([
      ["/api/stats", stats],
      ["/api/providers", providers],
      ["/api/runners", runners],
      [
        "/api/auth/me",
        {
          kind: "client",
          scopes: ["sessions:read", "access:write"],
          client: { id: "owner-device", role: "owner" },
        },
      ],
    ]);
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const body = responses.get(String(input));
      return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
    });

    await expect(readStats({ fetch: fetchMock })).resolves.toEqual({ ok: true, value: stats });
    await expect(readProviders({ fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: providers,
    });
    await expect(readRunners({ fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: runners,
    });
    await expect(readCurrentPrincipal({ fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: { role: "owner" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(
        expect.objectContaining({
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
      );
    }
  });

  it("combines registered devices and the current ownership transfer", async () => {
    const client = {
      id: "owner-device",
      label: "This browser",
      scopes: ["sessions:read", "access:write"],
      role: "owner",
      createdAt: timestamp,
      expiresAt: "2026-10-03T12:00:00.000Z",
      lastSeenAt: timestamp,
      userAgent: "Scotty test",
      current: true,
    };
    const transfer = {
      id: "transfer-1",
      sourceOwnerClientId: "owner-device",
      targetClientId: "phone-device",
      createdAt: timestamp,
      expiresAt: "2026-09-03T12:05:00.000Z",
    };
    const fetchMock = vi.fn<Fetch>(async (input) =>
      Response.json(String(input).endsWith("/clients") ? [client] : transfer),
    );

    await expect(readDevices({ fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: {
        clients: [
          {
            id: client.id,
            label: client.label,
            role: client.role,
            createdAt: client.createdAt,
            expiresAt: client.expiresAt,
            lastSeenAt: client.lastSeenAt,
            current: true,
          },
        ],
        transfer,
      },
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/clients",
      "/api/auth/owner-transfers/current",
    ]);
  });

  it("returns a typed malformed failure instead of accepting a successful invalid body", async () => {
    const fetchMock = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(Response.json({ ...stats, unexpected: true }));

    await expect(readStats({ fetch: fetchMock })).resolves.toEqual({
      ok: false,
      failure: {
        kind: "malformed-response",
        message: "Scotty returned an unexpected response.",
      },
    });
  });

  it("issues a pairing with the canonical mutation contract", async () => {
    const pairing = {
      id: "pairing-1",
      url: "https://scotty.example.test/pair#token=redacted",
      expiresAt: "2026-09-03T12:05:00.000Z",
      qr: { size: 2, rows: ["10", "01"] },
    };
    const fetchMock = vi.fn<Fetch>().mockResolvedValueOnce(Response.json(pairing));

    await expect(issuePairing("Phone", { fetch: fetchMock })).resolves.toEqual({
      ok: true,
      value: pairing,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/pairings",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ label: "Phone" }),
      }),
    );
  });
});
