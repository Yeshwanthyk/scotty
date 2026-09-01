import { assert, describe, it } from "@effect/vitest";
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
    assert.includeMembers(harness.deletedSchedules, [
      "sessionActorHardCap",
      "sessionActorDeadline",
    ]);
    assert.deepStrictEqual(await harness.sandbox.vaporizeScottySession(), result);
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
    const events = harness.events.slice(start);
    const committed = events.indexOf(`storage:put:${sessionHarnessKeys.actorAuthority}`);
    const destroyed = events.indexOf("host:destroy");
    assert.ok(committed >= 0);
    assert.ok(destroyed > committed);
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
  });
});
