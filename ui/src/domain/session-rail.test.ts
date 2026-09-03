import { describe, expect, it } from "vitest";
import { sleepingRetained } from "../fixtures/sessions";
import { buildFixtureSessionRail } from "./session-rail";

describe("buildFixtureSessionRail", () => {
  it("keeps the complete rail while selecting one session and places Archived last", () => {
    const rail = buildFixtureSessionRail(sleepingRetained);
    const active = rail.repositories.flatMap((repository) => repository.sessions);
    const all = [...active, ...rail.archivedSessions];

    expect(all.length).toBeGreaterThan(40);
    expect(all.filter((row) => row.selected).map((row) => row.session.id)).toEqual([
      sleepingRetained.id,
    ]);
    expect(rail.archivedSessions.length).toBeGreaterThan(0);
    expect(
      all.some(
        (row) =>
          row.presentation.authority.kind === "stable" &&
          row.presentation.authority.lifecycle === "gone",
      ),
    ).toBe(false);
  });
});
