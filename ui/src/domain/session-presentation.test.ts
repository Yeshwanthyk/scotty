import { describe, expect, it } from "vitest";
import {
  failedRecoverable,
  failedTerminal,
  FIXTURE_NOW,
  manySessions,
  projectionStale,
  runtimeMissing,
  sleepingRetained,
  transitionResume,
  transitionSleep,
  transitionVaporize,
  warmIdle,
} from "../fixtures/sessions";
import {
  classifySessionFailure,
  presentSession,
  reconcileRailSession,
} from "./session-presentation";

describe("presentSession", () => {
  it("preserves transitioning authority without synthesizing a stable lifecycle", () => {
    const sleeping = presentSession(transitionSleep, {
      now: FIXTURE_NOW,
      source: "actor",
    });
    expect(sleeping.authority).toEqual({ kind: "transitioning", origin: "warm" });
    expect(sleeping.railLabel).toBe("Going to sleep");
    expect(sleeping.operation).toMatchObject({
      action: "sleep",
      mode: "reconciling",
      phase: "Syncing",
    });
    expect(sleeping.availableActions).toEqual([]);
    expect(sleeping.composerEnabled).toBe(false);

    const waking = presentSession(transitionResume, {
      now: FIXTURE_NOW,
      source: "actor",
    });
    expect(waking.authority).toEqual({ kind: "transitioning", origin: "sleeping" });
    expect(waking.railLabel).toBe("Waking");
  });

  it("offers only actions admitted by stable authority", () => {
    expect(
      presentSession(warmIdle, { now: FIXTURE_NOW, source: "actor" }).availableActions,
    ).toEqual(["checkpoint", "sleep", "work", "vaporize"]);
    expect(
      presentSession(sleepingRetained, { now: FIXTURE_NOW, source: "actor" }).availableActions,
    ).toEqual(["resume", "vaporize"]);
    expect(
      presentSession(failedRecoverable, { now: FIXTURE_NOW, source: "actor" }).availableActions,
    ).toEqual(["resume", "vaporize"]);
    expect(
      presentSession(failedTerminal, { now: FIXTURE_NOW, source: "actor" }).availableActions,
    ).toEqual(["vaporize"]);
  });

  it("does not expose a composer when warm authority lacks runtime readiness", () => {
    const result = presentSession(runtimeMissing, {
      now: FIXTURE_NOW,
      source: "actor",
      runtimeAvailability: "unavailable",
    });
    expect(result.authority).toEqual({ kind: "stable", lifecycle: "warm" });
    expect(result.conversation).toBe("unavailable");
    expect(result.composerEnabled).toBe(false);
    expect(result.shellTitle).toBe("Connecting to session");
  });

  it("keeps vaporize visible until actor-confirmed terminality", () => {
    const result = presentSession(transitionVaporize, {
      now: FIXTURE_NOW,
      source: "actor",
    });
    expect(result.railLabel).toBe("Vaporizing");
    expect(result.destructiveProgress).toBe(true);
    expect(result.availableActions).toEqual([]);
  });

  it("lets the selected actor read repair a stale rail projection", () => {
    const reconciled = reconcileRailSession(projectionStale.projected, projectionStale.actor);
    const result = presentSession(reconciled, {
      now: FIXTURE_NOW,
      source: "actor",
    });
    expect(result.authority).toEqual({ kind: "stable", lifecycle: "sleeping" });
    expect(result.railLabel).toBe("Sleeping");
  });

  it("maps failure codes to user-facing recovery copy", () => {
    const recoverable = presentSession(failedRecoverable, {
      now: FIXTURE_NOW,
      source: "actor",
    });
    const terminal = presentSession(failedTerminal, { now: FIXTURE_NOW, source: "actor" });
    expect(recoverable.failureMessage).toContain("confirmed backup");
    expect(terminal.failureMessage).toBe("This session has no confirmed backup to restore.");
  });

  it("presents every sessions-route fixture without legacy shape access", () => {
    const presentations = manySessions.map((session) =>
      presentSession(session, { now: FIXTURE_NOW, source: "projection" }),
    );
    expect(presentations).toHaveLength(60);
    expect(presentations.every((presentation) => presentation.railLabel.length > 0)).toBe(true);
  });
});

describe("classifySessionFailure", () => {
  it.each([
    [{ kind: "http", status: 409, code: "conflict" }, "conflict"],
    [{ kind: "http", status: 409, code: "wrong_state" }, "wrong-state"],
    [{ kind: "http", status: 409, reason: "session_not_warm" }, "non-warm"],
    [{ kind: "malformed-response" }, "malformed"],
    [{ kind: "http", status: 500, code: "internal" }, "other"],
  ] as const)("classifies %o as %s", (failure, expected) => {
    expect(classifySessionFailure(failure)).toBe(expected);
  });
});
