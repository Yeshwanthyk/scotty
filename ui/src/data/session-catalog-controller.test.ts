import { describe, expect, it, vi } from "vitest";
import { warmIdle } from "../fixtures/sessions";
import { createSessionCatalogController } from "./session-catalog-controller";
import type { SessionListReadResult } from "./session-list-reader";
import type { SessionModel, SessionReadResult } from "./session-reader";

const projection = (session: SessionModel) => ({
  projectedAt: "2026-09-03T16:00:00.000Z",
  session: { ...session, source: "projection" as const },
});

const actor = (session: SessionModel): SessionReadResult => ({
  ok: true,
  session: { ...session, source: "authority" },
});

describe("session catalog controller", () => {
  it("keeps a verified create visible while the list projection lags", async () => {
    const created = { ...warmIdle, id: "new-session", source: "authority" as const };
    const existing = Array.from({ length: 5 }, (_, index) => ({
      ...warmIdle,
      id: `existing-${index}`,
    }));
    const controller = createSessionCatalogController({
      readList: vi.fn(
        async (): Promise<SessionListReadResult> => ({
          ok: true,
          projections: existing.map(projection),
        }),
      ),
      readActor: vi.fn(async () => actor(created)),
    });
    controller.publishActor(created);

    await controller.refresh();

    expect(controller.getSnapshot().status).toBe("ready");
    expect(controller.getSnapshot().sessions[0]).toMatchObject({
      id: "new-session",
      source: "authority",
    });
    expect(
      controller
        .getSnapshot()
        .sessions.slice(0, 5)
        .map(({ id }) => id),
    ).toContain("new-session");
  });

  it("retains successful rows and reports degraded state after a transient list failure", async () => {
    const readList = vi
      .fn<() => Promise<SessionListReadResult>>()
      .mockResolvedValueOnce({ ok: true, projections: [projection(warmIdle)] })
      .mockResolvedValueOnce({ ok: false, failure: { kind: "network" } });
    const controller = createSessionCatalogController({
      readList,
      readActor: vi.fn(async () => actor(warmIdle)),
    });
    await controller.refresh();

    await controller.refresh();

    expect(controller.getSnapshot()).toMatchObject({
      status: "degraded",
      sessions: [{ id: warmIdle.id }],
    });
  });

  it("does not let an older list request overwrite a newer refresh", async () => {
    let finishFirst: ((value: SessionListReadResult) => void) | undefined;
    const first = new Promise<SessionListReadResult>((resolve) => {
      finishFirst = resolve;
    });
    const newer = { ...warmIdle, id: "newer" };
    const readList = vi
      .fn<(signal: AbortSignal) => Promise<SessionListReadResult>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ok: true, projections: [projection(newer)] });
    const controller = createSessionCatalogController({
      readList,
      readActor: vi.fn(async () => actor(warmIdle)),
    });
    const staleRefresh = controller.refresh();

    await controller.refresh();
    finishFirst?.({ ok: true, projections: [projection(warmIdle)] });
    await staleRefresh;

    expect(controller.getSnapshot().sessions.map(({ id }) => id)).toEqual(["newer"]);
  });

  it("revalidates a correction until capabilities and actor state catch up", async () => {
    const corrected = {
      ...warmIdle,
      capabilities: { ...warmIdle.capabilities, work: false },
      source: "authority" as const,
    };
    const readActor = vi.fn(async () => actor(corrected));
    const controller = createSessionCatalogController({
      readList: vi.fn(
        async (): Promise<SessionListReadResult> => ({
          ok: true,
          projections: [projection(warmIdle)],
        }),
      ),
      readActor,
    });
    controller.publishActor(corrected);

    await controller.refresh();

    expect(readActor).toHaveBeenCalledWith(warmIdle.id, expect.any(AbortSignal));
    expect(controller.getSnapshot().verifiedActors.get(warmIdle.id)).toMatchObject({
      capabilities: { work: false },
    });
  });

  it("keeps the latest verified actor after its projection catches up", async () => {
    const sleeping = {
      ...warmIdle,
      authority: { kind: "stable", lifecycle: "sleeping", failure: null } as const,
      runtime: { ...warmIdle.runtime, readiness: "not-applicable" as const },
      capabilities: {
        create: false,
        checkpoint: false,
        sleep: false,
        resume: true,
        work: false,
        vaporize: true,
      },
      source: "authority" as const,
    };
    const controller = createSessionCatalogController({
      readList: vi.fn(
        async (): Promise<SessionListReadResult> => ({
          ok: true,
          projections: [projection(sleeping)],
        }),
      ),
      readActor: vi.fn(async () => actor(sleeping)),
    });
    controller.publishActor(sleeping);

    await controller.refresh();

    expect(controller.getSnapshot().verifiedActors.get(warmIdle.id)).toMatchObject({
      authority: { lifecycle: "sleeping" },
    });
  });

  it("suppresses a confirmed missing actor until the stale projection disappears", async () => {
    const readList = vi
      .fn<() => Promise<SessionListReadResult>>()
      .mockResolvedValueOnce({ ok: true, projections: [projection(warmIdle)] })
      .mockResolvedValueOnce({ ok: true, projections: [projection(warmIdle)] })
      .mockResolvedValueOnce({ ok: true, projections: [] });
    const controller = createSessionCatalogController({
      readList,
      readActor: vi.fn(
        async (): Promise<SessionReadResult> => ({
          ok: false,
          failure: { kind: "http", status: 404, message: "Missing" },
          classification: "other",
        }),
      ),
    });
    controller.publishActor({
      ...warmIdle,
      authority: { kind: "stable", lifecycle: "sleeping", failure: null },
      source: "authority",
    });

    await controller.refresh();
    await controller.refresh();
    await controller.refresh();

    expect(controller.getSnapshot().sessions).toEqual([]);
    expect(controller.getSnapshot().verifiedActors.has(warmIdle.id)).toBe(false);
  });

  it("discards an actor read that finishes after a newer verified publish", async () => {
    let finishRead: ((value: SessionReadResult) => void) | undefined;
    const pending = new Promise<SessionReadResult>((resolve) => {
      finishRead = resolve;
    });
    const sleeping = {
      ...warmIdle,
      authority: { kind: "stable", lifecycle: "sleeping", failure: null } as const,
      source: "authority" as const,
    };
    const controller = createSessionCatalogController({
      readList: vi.fn(async (): Promise<SessionListReadResult> => ({ ok: true, projections: [] })),
      readActor: vi.fn(() => pending),
    });
    controller.publishActor({ ...warmIdle, source: "authority" });
    const staleRead = controller.refreshActor(warmIdle.id);

    controller.publishActor(sleeping);
    finishRead?.(actor(warmIdle));
    await staleRead;

    expect(controller.getSnapshot().verifiedActors.get(warmIdle.id)).toMatchObject({
      authority: { lifecycle: "sleeping" },
    });
  });

  it("does not let a stale route seed replace a newer verified actor", () => {
    const sleeping = {
      ...warmIdle,
      authority: { kind: "stable", lifecycle: "sleeping", failure: null } as const,
      source: "authority" as const,
    };
    const controller = createSessionCatalogController({
      readList: vi.fn(async (): Promise<SessionListReadResult> => ({ ok: true, projections: [] })),
      readActor: vi.fn(async () => actor(sleeping)),
    });
    controller.publishActor(sleeping);

    const seeded = controller.seedActor({ ...warmIdle, source: "authority" });

    expect(seeded).toBe(false);
    expect(controller.getSnapshot().verifiedActors.get(warmIdle.id)).toMatchObject({
      authority: { lifecycle: "sleeping" },
    });
  });

  it("does not let a late actor read repopulate cache after authorization is lost", async () => {
    let finishRead: ((value: SessionReadResult) => void) | undefined;
    const pending = new Promise<SessionReadResult>((resolve) => {
      finishRead = resolve;
    });
    const controller = createSessionCatalogController({
      readList: vi.fn(
        async (): Promise<SessionListReadResult> => ({
          ok: false,
          failure: { kind: "http", status: 401, message: "Signed out" },
        }),
      ),
      readActor: vi.fn(() => pending),
    });
    const actorRead = controller.refreshActor(warmIdle.id);

    await controller.refresh();
    finishRead?.(actor(warmIdle));
    await actorRead;

    expect(controller.getSnapshot()).toMatchObject({ status: "degraded", sessions: [] });
    expect(controller.getSnapshot().verifiedActors.size).toBe(0);
  });

  it("can resume actor reads after effect cleanup and setup replay", async () => {
    const controller = createSessionCatalogController({
      readList: vi.fn(async (): Promise<SessionListReadResult> => ({ ok: true, projections: [] })),
      readActor: vi.fn(async () => actor(warmIdle)),
    });
    controller.destroy();
    await controller.refresh();
    await controller.refreshActor(warmIdle.id);
    expect(controller.getSnapshot().verifiedActors.has(warmIdle.id)).toBe(true);
  });

  it("removes an actor confirmed gone after its correction already caught up", async () => {
    const controller = createSessionCatalogController({
      readList: vi.fn(
        async (): Promise<SessionListReadResult> => ({
          ok: true,
          projections: [projection(warmIdle)],
        }),
      ),
      readActor: vi.fn(
        async (): Promise<SessionReadResult> => ({
          ok: false,
          failure: { kind: "http", status: 404, message: "Missing" },
          classification: "other",
        }),
      ),
    });
    controller.publishActor(warmIdle);
    await controller.refresh();
    await controller.refreshActor(warmIdle.id);
    await controller.refresh();
    expect(controller.getSnapshot().sessions).toEqual([]);
    expect(controller.getSnapshot().verifiedActors.size).toBe(0);
  });

  it("fences a pending list when an actor read loses authorization", async () => {
    let finishList: ((value: SessionListReadResult) => void) | undefined;
    const pending = new Promise<SessionListReadResult>((resolve) => {
      finishList = resolve;
    });
    const controller = createSessionCatalogController({
      readList: vi.fn(() => pending),
      readActor: vi.fn(
        async (): Promise<SessionReadResult> => ({
          ok: false,
          failure: { kind: "http", status: 403, message: "Forbidden" },
          classification: "other",
        }),
      ),
    });
    controller.publishActor(warmIdle);
    const listRead = controller.refresh();
    await controller.refreshActor(warmIdle.id);
    finishList?.({ ok: true, projections: [projection(warmIdle)] });
    await listRead;
    expect(controller.getSnapshot()).toMatchObject({ status: "degraded", sessions: [] });
    expect(controller.getSnapshot().verifiedActors.size).toBe(0);
  });
});
