import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Option, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { SessionAuthority } from "../../src/session-actor/authority";
import type { EvidenceState } from "../../src/evidence/contracts";
import type { HatchState } from "../../src/hatch/contracts";
import { ScottyError } from "../../src/session/contracts";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
} from "../support/session-harness";

const decodeDrainFence = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: Schema.String,
    generation: Schema.String,
    deadlineAt: Schema.String,
    drainAt: Schema.String,
  }),
  { onExcessProperty: "error" },
);

const deferred = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("Sandbox actor checkpoint, sleep, and resume", () => {
  it("arms the strict final payload before the derived drain and stops create when drain arming fails", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const hardCaps = harness.schedules.filter((schedule) =>
      schedule.callback.startsWith("sessionActorHardCap"),
    );
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(authority);
    const drainPayload = decodeDrainFence(hardCaps[1]?.payload);
    assert.isTrue(Option.isSome(drainPayload));
    if (Option.isNone(drainPayload)) return;
    assert.lengthOf(hardCaps, 2);
    assert.strictEqual(hardCaps[0]?.callback, "sessionActorHardCap");
    assert.deepStrictEqual(hardCaps[0]?.payload, {
      sessionId: SESSION_ID,
      generation: authority.hardCap.generation,
      deadlineAt: authority.hardCap.deadlineAt,
    });
    assert.strictEqual(hardCaps[1]?.callback, "sessionActorHardCapDrain");
    const finalWhen = hardCaps[0]?.when;
    assert.instanceOf(finalWhen, Date);
    if (!(finalWhen instanceof Date)) return;
    assert.strictEqual(
      drainPayload.value.drainAt,
      new Date(finalWhen.getTime() - 5 * 60_000).toISOString(),
    );
    assert.isBelow(
      harness.events.indexOf("schedule:sessionActorHardCap"),
      harness.events.indexOf("schedule:sessionActorHardCapDrain"),
    );
    assert.isBelow(
      harness.events.indexOf("schedule:sessionActorHardCapDrain"),
      harness.events.indexOf(`storage:put:${sessionHarnessKeys.actorAuthority}`),
    );

    const failed = await createSessionHarness({ failureStage: "hardCapDrainSchedule" });
    await expect(
      failed.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    ).rejects.toBeDefined();
    assert.strictEqual(failed.read(sessionHarnessKeys.actorAuthority), undefined);
    assert.deepStrictEqual(
      failed.schedules
        .filter((schedule) => schedule.callback.startsWith("sessionActorHardCap"))
        .map((schedule) => schedule.callback),
      ["sessionActorHardCap"],
    );
  });

  it.effect("drains Warm to Sleeping only at its matching derived fence", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const drain = harness.schedules.find(
        (schedule) => schedule.callback === "sessionActorHardCapDrain",
      );
      assert.isDefined(drain);
      const drainPayload = decodeDrainFence(drain.payload);
      assert.isTrue(Option.isSome(drainPayload));
      if (Option.isNone(drainPayload)) return;

      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      let authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        authority !== undefined &&
          Predicate.isTagged(authority.state, "Stable") &&
          Predicate.isTagged(authority.state.stable, "Warm"),
      );

      const stale = { ...drainPayload.value, drainAt: "2026-09-03T00:00:01.000Z" };
      yield* clock.setTime(Date.parse(drainPayload.value.drainAt));
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(stale));
      authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        authority !== undefined &&
          Predicate.isTagged(authority.state, "Stable") &&
          Predicate.isTagged(authority.state.stable, "Warm"),
      );

      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        authority !== undefined &&
          Predicate.isTagged(authority.state, "Stable") &&
          Predicate.isTagged(authority.state.stable, "Sleeping"),
      );
      assert.strictEqual(authority.state.stable.backup.confirmedAt !== null, true);
      assert.strictEqual(authority.state.stable.wakeSource.backupId, "backup-1");
      const eventsAfterSleep = harness.events.length;
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      assert.strictEqual(harness.events.length, eventsAfterSleep);
    }),
  );

  it.effect("retries contended drain work only while a retry fits before final fallback", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          evidenceEnabled: true,
          piSessionRunning: true,
          rawPiContainerRunning: true,
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      yield* Effect.promise(() =>
        harness.sandbox.acceptScottyEvidenceJob({
          port: 4_173,
          viewport: { width: 1_280, height: 720 },
          capture: { screenshots: "after-each-step", video: false },
          steps: [
            {
              name: "Keep the lease contended",
              action: { kind: "goto", path: "/" },
              expect: [{ kind: "urlPath", expected: "/" }],
            },
          ],
        }),
      );
      const drain = harness.schedules.find(
        (schedule) => schedule.callback === "sessionActorHardCapDrain",
      );
      const final = harness.schedules.find(
        (schedule) => schedule.callback === "sessionActorHardCap",
      );
      assert.isDefined(drain);
      assert.isDefined(final);
      const drainPayload = decodeDrainFence(drain.payload);
      assert.isTrue(Option.isSome(drainPayload));
      if (Option.isNone(drainPayload)) return;

      yield* clock.setTime(Date.parse(drainPayload.value.drainAt));
      const retriesBefore = harness.schedules.filter(
        (schedule) => schedule.callback === "sessionActorHardCapDrain",
      ).length;
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const retriesAfter = harness.schedules.filter(
        (schedule) => schedule.callback === "sessionActorHardCapDrain",
      );
      assert.lengthOf(retriesAfter, retriesBefore + 1);
      assert.strictEqual(retriesAfter.at(-1)?.when, 5);

      yield* clock.setTime(Date.parse(drainPayload.value.deadlineAt) - 4_000);
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      assert.lengthOf(
        harness.schedules.filter((schedule) => schedule.callback === "sessionActorHardCapDrain"),
        retriesBefore + 1,
      );

      yield* clock.setTime(Date.parse(drainPayload.value.deadlineAt));
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCap(final.payload));
      const failed = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        failed !== undefined &&
          Predicate.isTagged(failed.state, "Stable") &&
          Predicate.isTagged(failed.state.stable, "Failed"),
      );
      assert.strictEqual(failed.state.stable.code, "hard_cap_elapsed");
    }),
  );
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

    const checkpointed = await harness.sandbox.checkpointScottySession();
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
      await harness.sandbox
        .getScottySession()
        .then((view) =>
          view.session.authority.kind === "stable"
            ? view.session.authority.lifecycle
            : "transitioning",
        ),
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
      await harness.sandbox
        .getScottySession()
        .then((view) =>
          view.session.authority.kind === "stable"
            ? view.session.authority.lifecycle
            : "transitioning",
        ),
      "warm",
    );
    assert.ok(harness.events.includes("host:createBackup"));
    assert.ok(harness.events.includes("host:stop"));
    assert.ok(harness.events.includes("host:restoreBackup"));
  });

  it("rearms reconciliation on lifecycle request retry after ambiguous deadline scheduling", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const before = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(before);
    harness.injectFailure("actorAlarmScheduleOnce");

    const first = await harness.sandbox.checkpointScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(first instanceof ScottyError);
    assert.strictEqual(first.code, "upstream");
    const committed = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(committed !== undefined && Predicate.isTagged(committed.state, "Transitioning"));
    assert.strictEqual(committed.state.transition.mode, "executing");
    assert.strictEqual(committed.revision, before.revision + 1);
    const backupCalls = harness.events.filter((event) => event === "host:createBackup").length;

    const retry = await harness.sandbox.checkpointScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(retry instanceof ScottyError);
    assert.strictEqual(retry.code, "upstream");
    const recovering = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(recovering !== undefined && Predicate.isTagged(recovering.state, "Transitioning"));
    assert.strictEqual(recovering.state.transition.mode, "reconciling");
    assert.strictEqual(recovering.revision, committed.revision + 1);
    const recoveryAlarm = harness.schedules
      .filter((schedule) => schedule.callback === "sessionActorDeadline")
      .at(-1);
    assert.deepInclude(recoveryAlarm?.payload, {
      kind: "reconcile",
      revision: recovering.revision,
    });
    assert.strictEqual(
      harness.events.filter((event) => event === "host:createBackup").length,
      backupCalls,
    );
  });

  it("does not treat an overlapping lifecycle request as restart residue", async () => {
    const syncEntered = deferred<void>();
    const releaseSync = deferred<void>();
    let gateSync = true;
    const harness = await createSessionHarness({
      commandGate: (command) => {
        if (command !== "sync" || !gateSync) return undefined;
        gateSync = false;
        syncEntered.resolve();
        return releaseSync.promise;
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    const first = harness.sandbox.checkpointScottySession();
    await syncEntered.promise;
    const executing = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(executing !== undefined && Predicate.isTagged(executing.state, "Transitioning"));

    const overlap = await harness.sandbox.checkpointScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(overlap instanceof ScottyError);
    assert.strictEqual(overlap.code, "wrong_state");
    const afterOverlap = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      afterOverlap !== undefined && Predicate.isTagged(afterOverlap.state, "Transitioning"),
    );
    assert.strictEqual(afterOverlap.revision, executing.revision);
    assert.strictEqual(afterOverlap.state.transition.mode, "executing");

    releaseSync.resolve();
    const settled = await first;
    assert.strictEqual(settled.status, "warm");
  });

  it("does not recover a different lifecycle transition kind", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    harness.injectFailure("actorAlarmScheduleOnce");
    await harness.sandbox.checkpointScottySession().then(
      () => undefined,
      () => undefined,
    );
    const checkpoint = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(checkpoint !== undefined && Predicate.isTagged(checkpoint.state, "Transitioning"));

    const sleep = await harness.sandbox.sleepScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(sleep instanceof ScottyError);
    assert.strictEqual(sleep.code, "wrong_state");
    const retained = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.strictEqual(retained?.revision, checkpoint.revision);
    assert.ok(
      retained !== undefined &&
        Predicate.isTagged(retained.state, "Transitioning") &&
        Predicate.isTagged(retained.state.transition, "Checkpoint"),
    );
  });

  it("does not recover live WarmWork from an overlapping lifecycle request", async () => {
    const archiveEntered = deferred<void>();
    const releaseArchive = deferred<void>();
    const harness = await createSessionHarness({
      commandGate: (command) => {
        if (!command.startsWith("tar -cf ")) return undefined;
        archiveEntered.resolve();
        return releaseArchive.promise;
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    const archive = harness.sandbox.prepareDownArchive();
    await archiveEntered.promise;
    const warmWork = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      warmWork !== undefined &&
        Predicate.isTagged(warmWork.state, "Transitioning") &&
        Predicate.isTagged(warmWork.state.transition, "WarmWork"),
    );

    const checkpoint = await harness.sandbox.checkpointScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(checkpoint instanceof ScottyError);
    assert.strictEqual(checkpoint.code, "wrong_state");
    assert.strictEqual(
      harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority)?.revision,
      warmWork.revision,
    );
    releaseArchive.resolve();
    await archive;
  });

  it("closes Hatch for sleep and restores the exact service through Pi on resume", async () => {
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const service = {
      name: "docs",
      argv: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
      workingDirectory: `/workspace/${SESSION_ID}`,
      port: 4_173,
      healthPath: "/health?restored=1",
    } as const;
    const ensured = await harness.sandbox.ensureScottyHatch({ service });
    assert.strictEqual(ensured.status, "configured");
    const initial = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.isDefined(initial?.runtimeEpoch);

    await harness.sandbox.checkpointScottySession();
    const afterCheckpoint = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.strictEqual(afterCheckpoint?.observedStatus, "running");
    assert.strictEqual(afterCheckpoint?.exposure, "active");

    await harness.sandbox.sleepScottySession();
    const sleeping = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.strictEqual(sleeping?.desiredStatus, "open");
    assert.strictEqual(sleeping?.observedStatus, "sleeping");
    assert.strictEqual(sleeping?.exposure, "closed");
    assert.strictEqual(sleeping?.runtimeEpoch, undefined);
    assert.strictEqual(sleeping?.transitionNonce, undefined);
    assert.strictEqual(sleeping?.cleanup, undefined);
    assert.notInclude(harness.exposedPreviewPorts(), service.port);
    const restoreCountBeforeResume = harness.piHatchRestoreDescriptors.length;

    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    const running = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.isDefined(running);
    assert.strictEqual(running.desiredStatus, "open");
    assert.strictEqual(running.observedStatus, "running");
    assert.strictEqual(running.exposure, "active");
    assert.isDefined(running.publicReadyAt);
    assert.isDefined(running.runtimeEpoch);
    assert.notStrictEqual(running.runtimeEpoch, initial?.runtimeEpoch);
    assert.strictEqual(harness.piHatchRestoreDescriptors.length, restoreCountBeforeResume + 1);
    const consumed = harness.piHatchRestoreDescriptors.at(-1);
    assert.isDefined(consumed);
    assert.deepStrictEqual(consumed, {
      hatchId: running.hatchId,
      generation: running.generation,
      operationNonce: consumed.operationNonce,
      runtimeEpoch: running.runtimeEpoch,
      service,
    });
    const route = await harness.sandbox.getScottyHatchOpenRoute();
    assert.deepInclude(route, {
      hatchId: running.hatchId,
      generation: running.generation,
      runtimeEpoch: running.runtimeEpoch,
    });
    assert.include(harness.exposedPreviewPorts(), service.port);
    const publicStatus = await harness.sandbox.getScottyHatchStatus();
    assert.strictEqual(publicStatus.status, "configured");
    if (publicStatus.status !== "configured") return;
    assert.strictEqual(publicStatus.observedStatus, "running");
    assert.strictEqual(publicStatus.exposure, "active");
  });

  it("does not reconcile lifecycle success after Hatch restore cleanup failed", async () => {
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.ensureScottyHatch({
      service: {
        name: "docs",
        argv: ["npm", "run", "dev"],
        workingDirectory: `/workspace/${SESSION_ID}`,
        port: 4_173,
        healthPath: "/health",
      },
    });
    harness.injectFailure("hatchHealth");

    await expect(harness.sandbox.checkpointScottySession()).rejects.toBeDefined();
    const failedHatch = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.strictEqual(failedHatch?.desiredStatus, "open");
    assert.strictEqual(failedHatch?.observedStatus, "failed");
    assert.strictEqual(failedHatch?.exposure, "closed");
    harness.clearFailure("hatchHealth");
    const retry = harness.schedules
      .filter((schedule) => schedule.callback === "sessionActorDeadline")
      .at(-1);
    assert.isDefined(retry);

    await harness.sandbox.sessionActorDeadline(retry.payload);

    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Failed"),
    );
    assert.strictEqual(authority.state.stable.code, "reconciliation_outcome_unknown");
    assert.strictEqual(
      harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary?.observedStatus,
      "failed",
    );
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
      "sessionActorHardCapDrain",
      "sessionActorHardCap",
      "sessionActorDeadline",
    ]);
    assert.deepStrictEqual(await harness.sandbox.vaporizeScottySession(), result);
  });

  it("vaporizes after preempting active Evidence work", async () => {
    const harness = await createSessionHarness({
      evidenceEnabled: true,
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.acceptScottyEvidenceJob({
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

    assert.deepStrictEqual(await harness.sandbox.vaporizeScottySession(), {
      id: SESSION_ID,
      status: "gone",
    });
    assert.strictEqual(harness.read(sessionHarnessKeys.evidence), undefined);
    assert.strictEqual(harness.readRecord(), undefined);
  });

  it("vaporizes an actor-owned session with unreadable legacy Evidence", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    harness.memory.values.set(sessionHarnessKeys.evidence, { version: 2 });

    assert.deepStrictEqual(await harness.sandbox.vaporizeScottySession(), {
      id: SESSION_ID,
      status: "gone",
    });
    assert.strictEqual(harness.read(sessionHarnessKeys.evidence), undefined);
    assert.strictEqual(harness.readRecord(), undefined);
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

  it("preserves a sleeping session and its backup at the matching hard cap", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.sleepScottySession();
    const sleeping = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(sleeping);
    assert.ok(
      Predicate.isTagged(sleeping.state, "Stable") &&
        Predicate.isTagged(sleeping.state.stable, "Sleeping"),
    );
    const expired = {
      ...sleeping,
      hardCap: { ...sleeping.hardCap, deadlineAt: "2020-01-01T00:00:00.000Z" },
    } satisfies SessionAuthority;
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, expired);
    const start = harness.events.length;

    await harness.sandbox.sessionActorHardCap({
      sessionId: SESSION_ID,
      generation: expired.hardCap.generation,
      deadlineAt: expired.hardCap.deadlineAt,
    });

    assert.deepStrictEqual(
      harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority),
      expired,
    );
    const events = harness.events.slice(start);
    assert.notInclude(events, "host:destroy");
    assert.notInclude(events, "projection:failed");
    assert.strictEqual(
      events.filter((event) => event.startsWith("projection:")).at(-1),
      "projection:sleeping",
    );

    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    assert.include(harness.events, "host:restoreBackup");
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
