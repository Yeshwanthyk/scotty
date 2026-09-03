import { assert, describe, expect, it } from "@effect/vitest";
import { Predicate } from "effect";
import type { SessionAuthority } from "../../src/session-actor/authority";
import type { EvidenceState } from "../../src/evidence/contracts";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
} from "../support/session-harness";

describe("Sandbox actor checkpoint, sleep, and resume", () => {
  it("uses and rotates a durable local incarnation when Cloudflare placement is absent", async () => {
    const harness = await createSessionHarness({
      containerPlacementId: null,
      localE2E: true,
    });
    await harness.startRuntime();
    const first = harness.read<{ readonly version: 1; readonly id: string }>(
      sessionHarnessKeys.localContainerIncarnation,
    )?.id;
    assert.isDefined(first);
    assert.match(first, /^local:[0-9a-f-]{36}$/u);

    await harness.stopRuntime();
    assert.strictEqual(harness.read(sessionHarnessKeys.localContainerIncarnation), undefined);
    await harness.startRuntime();
    const second = harness.read<{ readonly version: 1; readonly id: string }>(
      sessionHarnessKeys.localContainerIncarnation,
    )?.id;
    assert.isDefined(second);
    assert.match(second, /^local:[0-9a-f-]{36}$/u);
    assert.notStrictEqual(second, first);

    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    assert.strictEqual(created.status, "warm");
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Warm"),
    );
    assert.strictEqual(authority.state.stable.readiness.runtime.containerIncarnation, second);
  });

  it("runs Hatch and Beam-down under WarmWork actor authority", async () => {
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      evidenceEnabled: true,
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    const hatch = await harness.sandbox.ensureScottyHatch({
      service: {
        name: "docs",
        argv: ["npm", "run", "dev"],
        workingDirectory: `/workspace/${SESSION_ID}`,
        port: 4_173,
        healthPath: "/health",
      },
    });
    assert.strictEqual(hatch.status, "configured");
    if (hatch.status !== "configured") return;
    assert.strictEqual(hatch.observedStatus, "running");

    const archive = await harness.sandbox.prepareDownArchive();
    assert.strictEqual(archive.manifest.id, SESSION_ID);
    assert.strictEqual(archive.manifest.repo, CREATE_INPUT.repo);
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Warm"),
    );
  });

  it("runs Evidence admission and finalization under WarmWork authority", async () => {
    const harness = await createSessionHarness({
      evidenceEnabled: true,
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    const active = await harness.sandbox.acceptScottyEvidenceJob({
      port: 4_173,
      viewport: { width: 1_280, height: 720 },
      capture: { screenshots: "after-each-step", video: false },
      steps: [
        {
          name: "Open the app",
          action: { kind: "goto", path: "/" },
          expect: [{ kind: "urlPath", expected: "/" }],
        },
      ],
    });
    const running = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      running !== undefined &&
        Predicate.isTagged(running.state, "Transitioning") &&
        Predicate.isTagged(running.state.transition, "WarmWork"),
    );
    assert.strictEqual(
      harness.read<EvidenceState>(sessionHarnessKeys.evidence)?.activeJob?.operationNonce,
      active.operationNonce,
    );

    await harness.sandbox.finalizeScottyEvidenceJob(active.operationNonce, "interrupted");
    const settled = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      settled !== undefined &&
        Predicate.isTagged(settled.state, "Stable") &&
        Predicate.isTagged(settled.state.stable, "Warm"),
    );
    assert.strictEqual(
      harness.read<EvidenceState>(sessionHarnessKeys.evidence)?.activeJob,
      undefined,
    );
  });

  it("runs the complete backup lifecycle through actor authority", async () => {
    const harness = await createSessionHarness();
    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    assert.strictEqual(created.status, "warm");

    const checkpointed = await harness.sandbox.snapshotScottySession();
    assert.strictEqual(checkpointed.status, "warm");
    const afterCheckpoint = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(afterCheckpoint);
    assert.ok(
      Predicate.isTagged(afterCheckpoint.state, "Stable") &&
        Predicate.isTagged(afterCheckpoint.state.stable, "Warm"),
    );
    assert.strictEqual(afterCheckpoint.state.stable.backups.currentBackupId, "backup-1");

    const sleeping = await harness.sandbox.sleepScottySession();
    assert.strictEqual(sleeping.status, "sleeping");
    const afterSleep = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(afterSleep);
    assert.ok(
      Predicate.isTagged(afterSleep.state, "Stable") &&
        Predicate.isTagged(afterSleep.state.stable, "Sleeping"),
    );
    assert.strictEqual(afterSleep.state.stable.wakeSource.backupId, "backup-1");

    const projectionEventsBeforeRead = harness.events.filter((event) =>
      event.startsWith("projection:"),
    ).length;
    assert.strictEqual(
      await harness.sandbox.getScottySession().then((view) => view.status),
      "sleeping",
    );
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("projection:")).length,
      projectionEventsBeforeRead + 1,
    );
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("projection:")).at(-1),
      "projection:sleeping",
    );

    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    const afterResume = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(afterResume);
    assert.ok(
      Predicate.isTagged(afterResume.state, "Stable") &&
        Predicate.isTagged(afterResume.state.stable, "Warm"),
    );
    assert.match(afterResume.state.stable.readiness.runtime.runtimeGeneration, /^resume-/u);
    assert.strictEqual(
      await harness.sandbox.getScottySession().then((view) => view.status),
      "warm",
    );
    assert.ok(harness.events.includes("host:createBackup"));
    assert.ok(harness.events.includes("host:stop"));
    assert.ok(harness.events.includes("host:restoreBackup"));
  });

  it("vaporizes through actor authority and removes every owned projection", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.sleepScottySession();

    const result = await harness.sandbox.vaporizeScottySession();

    assert.deepStrictEqual(result, { id: SESSION_ID, status: "gone" });
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(authority);
    assert.ok(
      Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Gone"),
    );
    assert.strictEqual(harness.read(sessionHarnessKeys.actorMetadata), undefined);
    assert.strictEqual(harness.readRecord(), undefined);
    assert.ok(harness.events.includes("host:destroy"));
    assert.ok(harness.events.includes("host:deleteBackup"));
    assert.includeMembers(harness.deletedSchedules, [
      "sessionActorHardCap",
      "sessionActorDeadline",
    ]);
    assert.deepStrictEqual(await harness.sandbox.vaporizeScottySession(), result);
  });

  it("retains the hard-cap driver until Gone commits after final absence", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const hardCap = harness.schedules.find(
      (schedule) => schedule.callback === "sessionActorHardCap",
    );
    assert.isDefined(hardCap);

    harness.injectFailure("actorCommitAfterAbsence");
    harness.injectFailure("actorAlarmSchedule");
    await expect(harness.sandbox.vaporizeScottySession()).rejects.toBeDefined();

    const retained = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      retained !== undefined &&
        Predicate.isTagged(retained.state, "Transitioning") &&
        Predicate.isTagged(retained.state.transition, "Vaporize"),
    );
    assert.notInclude(harness.deletedSchedules, "sessionActorHardCap");

    if (!Predicate.isTagged(retained.state, "Transitioning")) return;
    const elapsedDeadline = retained.state.transition.startedAt;
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, {
      ...retained,
      hardCap: { ...retained.hardCap, deadlineAt: elapsedDeadline },
      state: {
        ...retained.state,
        transition: { ...retained.state.transition, deadlineAt: elapsedDeadline },
      },
    });
    const elapsedHardCap = {
      sessionId: SESSION_ID,
      generation: retained.hardCap.generation,
      deadlineAt: elapsedDeadline,
    };
    harness.clearFailure();
    harness.injectFailure("vaporizeDestroy");
    harness.injectFailure("hardCapScheduleOnce");
    const schedulesBeforeRetry = harness.schedules.filter(
      (schedule) => schedule.callback === "sessionActorHardCap",
    ).length;
    await harness.sandbox.sessionActorHardCap(elapsedHardCap);
    assert.isAbove(
      harness.schedules.filter((schedule) => schedule.callback === "sessionActorHardCap").length,
      schedulesBeforeRetry,
    );
    assert.isAtLeast(
      harness.events.filter((event) => event === "schedule:sessionActorHardCap").length,
      3,
    );
    harness.clearFailure("vaporizeDestroy");
    let gone = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    for (let retry = 0; retry < 32; retry += 1) {
      await harness.sandbox.sessionActorHardCap(elapsedHardCap);
      gone = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      if (
        gone !== undefined &&
        Predicate.isTagged(gone.state, "Stable") &&
        Predicate.isTagged(gone.state.stable, "Gone")
      )
        break;
    }
    assert.ok(
      gone !== undefined &&
        Predicate.isTagged(gone.state, "Stable") &&
        Predicate.isTagged(gone.state.stable, "Gone"),
      JSON.stringify(gone),
    );
    assert.include(harness.deletedSchedules, "sessionActorHardCap");
  });

  it("commits hard-cap failure before destroying the runtime and ignores stale fences", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const warm = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(warm);

    await harness.sandbox.sessionActorHardCap({
      sessionId: SESSION_ID,
      generation: "stale-hard-cap",
      deadlineAt: warm.hardCap.deadlineAt,
    });
    assert.notInclude(harness.events, "host:destroy");

    const expired = {
      ...warm,
      hardCap: {
        ...warm.hardCap,
        deadlineAt: "2020-01-01T00:00:00.000Z",
      },
    };
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, expired);
    const start = harness.events.length;
    await harness.sandbox.sessionActorHardCap({
      sessionId: SESSION_ID,
      generation: expired.hardCap.generation,
      deadlineAt: expired.hardCap.deadlineAt,
    });

    const failed = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      failed !== undefined &&
        Predicate.isTagged(failed.state, "Stable") &&
        Predicate.isTagged(failed.state.stable, "Failed"),
    );
    assert.strictEqual(failed.state.stable.code, "hard_cap_elapsed");
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("projection:")).at(-1),
      "projection:failed",
    );
    const events = harness.events.slice(start);
    const committed = events.indexOf(`storage:put:${sessionHarnessKeys.actorAuthority}`);
    const destroyed = events.indexOf("host:destroy");
    assert.ok(committed >= 0);
    assert.ok(destroyed > committed);
  });

  it("destroys an already-failed runtime when its matching hard cap arrives", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const current = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(current);
    assert.ok(
      Predicate.isTagged(current.state, "Stable") &&
        Predicate.isTagged(current.state.stable, "Warm"),
    );
    const expired = {
      ...current,
      hardCap: { ...current.hardCap, deadlineAt: "2020-01-01T00:00:00.000Z" },
      state: {
        _tag: "Stable" as const,
        stable: {
          _tag: "Failed" as const,
          code: "transition_deadline_elapsed",
          actionable: current.state.stable.backups.prepared?.confirmedAt != null,
          origin: "Warm" as const,
          lastStable: "Warm" as const,
          backup: current.state.stable.backups.prepared,
          ownedBackupIds: current.state.stable.backups.ownedBackupIds,
          wakeSource:
            current.state.stable.backups.prepared?.confirmedAt == null
              ? null
              : {
                  backupId: current.state.stable.backups.prepared.backupId,
                  confirmedAt: current.state.stable.backups.prepared.confirmedAt,
                },
        },
      },
    } satisfies SessionAuthority;
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, expired);

    await harness.sandbox.sessionActorHardCap({
      sessionId: SESSION_ID,
      generation: expired.hardCap.generation,
      deadlineAt: expired.hardCap.deadlineAt,
    });

    assert.ok(harness.events.includes("host:destroy"));
    const retained = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      retained !== undefined &&
        Predicate.isTagged(retained.state, "Stable") &&
        Predicate.isTagged(retained.state.stable, "Failed"),
    );
    assert.strictEqual(retained.state.stable.code, "transition_deadline_elapsed");
  });

  it("uses the hard-cap callback as a fallback driver for Vaporize reconciliation", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const current = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(current);
    assert.ok(
      Predicate.isTagged(current.state, "Stable") &&
        Predicate.isTagged(current.state.stable, "Warm"),
    );
    const deadlineAt = "2020-01-01T00:00:00.000Z";
    const vaporizing: SessionAuthority = {
      ...current,
      hardCap: { ...current.hardCap, deadlineAt },
      state: {
        _tag: "Transitioning",
        transition: {
          _tag: "Vaporize",
          nonce: crypto.randomUUID(),
          origin: "Warm",
          attempt: crypto.randomUUID(),
          startedAt: deadlineAt,
          lastProgressAt: deadlineAt,
          deadlineAt,
          mode: "reconciling",
          phase: "Admitted",
          proof: {
            revokedAt: null,
            ownedBackupIds: current.state.stable.backups.ownedBackupIds,
            cleanup: { absent: [], lastObservedAt: deadlineAt },
          },
        },
      },
    };
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, vaporizing);

    await harness.sandbox.sessionActorHardCap({
      sessionId: SESSION_ID,
      generation: vaporizing.hardCap.generation,
      deadlineAt,
    });

    const settled = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      settled !== undefined &&
        Predicate.isTagged(settled.state, "Stable") &&
        Predicate.isTagged(settled.state.stable, "Gone"),
    );
  });

  it("feeds runtime-stop callbacks into the actor without synchronous re-entry", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    await harness.stopRuntime();
    await harness.drainBackground();

    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Failed"),
    );
    assert.strictEqual(authority.state.stable.code, "runtime_stopped");
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("projection:")).at(-1),
      "projection:failed",
    );
  });

  it("routes activity expiry through actor checkpoint and sleep", async () => {
    const harness = await createSessionHarness({ stopCallsOnStop: true });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    await harness.sandbox.onActivityExpired();
    await harness.drainBackground();

    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Sleeping"),
    );
    assert.strictEqual(authority.state.stable.wakeSource.backupId, "backup-1");
    assert.include(harness.events, "host:stop");
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("projection:")).at(-1),
      "projection:sleeping",
    );
  });
});
