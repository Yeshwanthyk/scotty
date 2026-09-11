import { describe, expect, it } from "vitest";
import type { SessionRailSession } from "./SessionRow";
import { matchesSessionQuery, moveSessionIndex } from "./SessionSwitcher";

const session: SessionRailSession = {
  id: "session-1",
  display: {
    title: "Repair OAuth rotation",
    repository: "yeshwanthyk/scotty",
    branch: "kyendamuri/oauth-fix",
  },
};

describe("session switcher", () => {
  it.each(["repair", "scotty", "oauth-fix"])("matches %s across session identity", (query) => {
    expect(matchesSessionQuery(session, query)).toBe(true);
  });

  it("does not search presentation status or session ids", () => {
    expect(matchesSessionQuery(session, "session-1")).toBe(false);
    expect(matchesSessionQuery(session, "ready")).toBe(false);
  });

  it("wraps arrow navigation and leaves an empty result stable", () => {
    expect(moveSessionIndex(2, 3, 1)).toBe(0);
    expect(moveSessionIndex(0, 3, -1)).toBe(2);
    expect(moveSessionIndex(0, 0, 1)).toBe(0);
  });
});
