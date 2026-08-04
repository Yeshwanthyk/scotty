import { assert, describe, it } from "vitest";
import { evictableSessions, hasBlockingCommands } from "../public/terminal-session-cache.js";

describe("terminal session cache", () => {
  it("pins only commands that have not reached a terminal outcome", () => {
    assert.isTrue(hasBlockingCommands([{ state: "queued" }]));
    assert.isTrue(hasBlockingCommands([{ state: "sending" }]));
    assert.isTrue(hasBlockingCommands([{ state: "paused" }]));
    assert.isFalse(hasBlockingCommands([{ state: "accepted" }]));
    assert.isFalse(hasBlockingCommands([{ state: "rejected" }]));
    assert.isFalse(hasBlockingCommands([{ state: "stale" }]));
    assert.isFalse(hasBlockingCommands([{ state: "ambiguous" }]));
  });

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
