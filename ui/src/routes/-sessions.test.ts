import { describe, expect, it, vi } from "vitest";
import { readSessionList } from "../data/session-list-reader";
import { beginSessionListRead } from "./sessions";

describe("sessions route loading", () => {
  it("starts the session list read without holding back the route", async () => {
    let resolve: ((result: Awaited<ReturnType<typeof readSessionList>>) => void) | undefined;
    const pending = new Promise<Awaited<ReturnType<typeof readSessionList>>>((done) => {
      resolve = done;
    });
    const read: typeof readSessionList = vi.fn(() => pending);
    const controller = new AbortController();

    const data = beginSessionListRead(controller.signal, read);

    expect(data.sessionList).toBe(pending);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));

    resolve?.({ ok: true, projections: [] });
    await expect(data.sessionList).resolves.toEqual({ ok: true, projections: [] });
  });
});
