import { assert, describe, it } from "vitest";
import { evictableSessions } from "../public/terminal-session-cache.js";

describe("terminal session cache", () => {
  it("keeps the current session and sessions with pending commands", () => {
    const entries = new Map([
      ["old", { touchedAt: 1 }],
      ["pending", { touchedAt: 2 }],
      ["current", { touchedAt: 3 }],
      ["new", { touchedAt: 4 }],
    ]);

    const candidates = evictableSessions(
      entries.entries(),
      "current",
      (sessionId) => sessionId === "pending",
    );

    assert.deepStrictEqual(
      candidates.map(([sessionId]) => sessionId),
      ["old", "new"],
    );
  });
});
