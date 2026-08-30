import { assert, describe, it } from "vitest";
import { displayDate, statsResponse } from "../../../public/stats/view.js";

const stats = {
  trackingSince: "2026-07-28T10:00:00.000Z",
  overall: { workspacesCreated: 2, projects: 1, warmNow: 1, sleepingNow: 1 },
  projects: [
    {
      repository: "owner/project",
      workspacesCreated: 2,
      warmNow: 1,
      sleepingNow: 1,
      lastCreated: "2026-07-29T10:00:00.000Z",
    },
  ],
};

describe("stats view", () => {
  it("accepts the bounded API shape and strips unrelated fields", () => {
    assert.deepStrictEqual(
      statsResponse({
        ...stats,
        secret: "must not survive",
        projects: [{ ...stats.projects[0], title: "must not survive" }],
      }),
      stats,
    );
  });

  it("accepts an honest empty history", () => {
    assert.deepStrictEqual(
      statsResponse({
        trackingSince: null,
        overall: { workspacesCreated: 0, projects: 0, warmNow: 0, sleepingNow: 0 },
        projects: [],
      }),
      {
        trackingSince: null,
        overall: { workspacesCreated: 0, projects: 0, warmNow: 0, sleepingNow: 0 },
        projects: [],
      },
    );
  });

  it("rejects malformed counts, dates, repositories, and project arrays", () => {
    assert.isUndefined(
      statsResponse({
        ...stats,
        overall: { ...stats.overall, workspacesCreated: -1 },
      }),
    );
    assert.isUndefined(statsResponse({ ...stats, trackingSince: "not-a-date" }));
    assert.isUndefined(
      statsResponse({
        ...stats,
        projects: [{ ...stats.projects[0], repository: "not-a-repository" }],
      }),
    );
    assert.isUndefined(statsResponse({ ...stats, projects: {} }));
  });

  it("formats retained creation dates in stable UTC calendar form", () => {
    assert.strictEqual(displayDate("2026-07-29T23:30:00.000-11:00"), "Jul 30, 2026");
    assert.isUndefined(displayDate("not-a-date"));
  });
});
