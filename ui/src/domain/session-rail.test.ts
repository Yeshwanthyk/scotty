import { describe, expect, it } from "vitest";
import { projectionStale, warmIdle } from "../fixtures/sessions";
import { buildSessionRail } from "./session-rail";

describe("buildFixtureSessionRail", () => {
  it("lets the selected actor replace a matching projection and determine placement", () => {
    const rail = buildSessionRail([{ ...projectionStale.projected, source: "projection" }], {
      selectedActor: { ...projectionStale.actor, source: "authority" },
    });
    expect(rail.repositories).toEqual([]);
    expect(rail.archivedSessions).toHaveLength(1);
    expect(rail.archivedSessions[0]).toMatchObject({
      actorCorrected: true,
      selected: true,
      session: { id: projectionStale.actor.id, authority: { lifecycle: "sleeping" } },
    });
  });

  it("keeps an actor-selected session visible when its list projection is missing", () => {
    const actor = { ...warmIdle, source: "authority" } as const;
    const rail = buildSessionRail([], { selectedActor: actor });
    expect(rail.repositories.flatMap(({ sessions }) => sessions)).toEqual([
      expect.objectContaining({
        selected: true,
        session: expect.objectContaining({ id: actor.id }),
      }),
    ]);
  });
});
