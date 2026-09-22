import { describe, expect, it } from "vitest";
import type { SessionMutationResult } from "../data/session-lifecycle";
import type { SessionLifecycle, SessionReadResult } from "../data/session-reader";
import { sleepingRetained, warmIdle } from "../fixtures/sessions";
import {
  hasReachedLifecycleTarget,
  isLifecycleMessageResolved,
  resolveLifecycleActionMessage,
} from "./session-lifecycle-reconciliation";

const failedMutation: SessionMutationResult = {
  ok: false,
  failure: { kind: "http", status: 500, message: "control plane timed out" },
  classification: "other",
};

const successfulCheckpoint: SessionMutationResult = {
  ok: true,
  value: { action: "checkpoint", id: warmIdle.id, status: "warm" },
};

const conflictedMutation: SessionMutationResult = {
  ok: false,
  failure: { kind: "http", status: 409, message: "session is changing" },
  classification: "conflict",
};

const authoritative = (lifecycle: SessionLifecycle, source = warmIdle): SessionReadResult => ({
  ok: true,
  session: {
    ...source,
    authority: { kind: "stable", lifecycle, failure: null },
    source: "authority",
  },
});

describe("session lifecycle action reconciliation", () => {
  it("accepts authoritative sleeping after a failed sleep response", () => {
    expect(
      resolveLifecycleActionMessage(
        "sleep",
        warmIdle.id,
        "warm",
        failedMutation,
        authoritative("sleeping", sleepingRetained),
        true,
      ),
    ).toBeNull();
  });

  it("clears a stale sleep error only after the authoritative target is reached", () => {
    expect(hasReachedLifecycleTarget("sleep", "warm", "warm")).toBe(false);
    expect(hasReachedLifecycleTarget("sleep", "warm", "failed")).toBe(false);
    expect(hasReachedLifecycleTarget("sleep", "warm", "sleeping")).toBe(true);
  });

  it("clears a stale reconciliation message after the same credible target transition", () => {
    const message = resolveLifecycleActionMessage(
      "sleep",
      warmIdle.id,
      "warm",
      conflictedMutation,
      authoritative("warm"),
      true,
    );

    expect(message).toMatchObject({ action: "sleep", kind: "reconciliation" });
    if (message === null) throw new Error("Expected a reconciliation message");
    expect(isLifecycleMessageResolved(message, "actor", "fresh", "sleeping")).toBe(true);
    expect(isLifecycleMessageResolved(message, "projection", "fresh", "sleeping")).toBe(false);
    expect(isLifecycleMessageResolved(message, "actor", "stale", "sleeping")).toBe(false);
  });

  it("does not treat an unchanged warm lifecycle as proof of a checkpoint", () => {
    const message = resolveLifecycleActionMessage(
      "checkpoint",
      warmIdle.id,
      "warm",
      failedMutation,
      authoritative("warm"),
      true,
    );

    expect(message).toMatchObject({ action: "checkpoint", kind: "error", startedFrom: "warm" });
  });

  it("keeps a successful checkpoint with authoritative warm state silent", () => {
    expect(
      resolveLifecycleActionMessage(
        "checkpoint",
        warmIdle.id,
        "warm",
        successfulCheckpoint,
        authoritative("warm"),
        true,
      ),
    ).toBeNull();
    expect(
      resolveLifecycleActionMessage(
        "checkpoint",
        warmIdle.id,
        "warm",
        successfulCheckpoint,
        authoritative("warm"),
        false,
      ),
    ).toMatchObject({ kind: "error" });
  });

  it("does not suppress a failed resume that started warm or a stable actor failure", () => {
    expect(hasReachedLifecycleTarget("resume", "warm", "warm")).toBe(false);
    expect(hasReachedLifecycleTarget("resume", "sleeping", "failed")).toBe(false);
    expect(
      resolveLifecycleActionMessage(
        "resume",
        warmIdle.id,
        "warm",
        failedMutation,
        authoritative("warm"),
        true,
      ),
    ).toMatchObject({ kind: "error" });
  });
});
