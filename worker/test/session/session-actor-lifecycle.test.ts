import { runtimeCliPin } from "../runtime-cli/fixtures";
import { scottyBaseAgentInstructions } from "../../../protocol/agents/agent-instructions";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Option, Predicate, Result, Schema } from "effect";
import { vi } from "vitest";
import { TestClock } from "effect/testing";
import {
  defaultCloudSettings,
  type CloudSettingsSnapshot,
} from "../../../protocol/settings/cloud-settings";
import type { SessionAuthority } from "../../src/session-actor/authority";
import { actorAlarmId } from "../../src/session-actor/alarm";
import type { LifecycleJournalEvent } from "../../src/session-actor/journal";
import type { EvidenceState } from "../../src/evidence/contracts";
import {
  HATCH_PRIVATE_CLAIMED_HEADER,
  HATCH_PRIVATE_REQUEST_HEADER,
  hatchOrigin,
  type HatchRouteAuthorization,
  type HatchState,
} from "../../src/hatch/contracts";
import { HatchStore, hatchStoreLayer } from "../../src/hatch/store";
import { sha256Hex } from "../../src/shared/digest";
import { ScottyError } from "../../src/session/contracts";
import {
  absoluteAlarmDate,
  matchesPersistedAlarmSecond,
} from "../../src/session/absolute-alarm-time";
import { AgentTurnActivity } from "../../src/session/agent-activity";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
  type HarnessOptions,
  type SessionHarness,
} from "../support/session-harness";

const fetchAuthorizedHatchRequest = async (
  harness: SessionHarness,
  route: HatchRouteAuthorization,
): Promise<Response> => {
  const cookieSecret = "a".repeat(64);
  const cookieDigest = await sha256Hex(cookieSecret);
  const hostRoute = {
    sessionId: route.sessionId,
    port: route.port,
    routeNonce: route.routeNonce,
  } as const;
  const active = await harness.sandbox.getScottyHatchRoute(hostRoute);
  assert.isDefined(active);
  const issued = await harness.sandbox.issueScottyHatchPermit(
    hostRoute,
    "111111111111",
    cookieDigest,
  );
  assert.isDefined(issued);
  const permit = await harness.sandbox.admitScottyHatchRequest({
    sessionId: route.sessionId,
    port: route.port,
    routeNonce: route.routeNonce,
    cookieSecret,
  });
  assert.isDefined(permit);
  assert.isTrue(await harness.sandbox.adjustScottyHatchRequest(permit.requestId, 0));
  return harness.sandbox.fetch(
    new Request(`${hatchOrigin(route, "preview.example.test")}/`, {
      headers: {
        "x-sandbox-preview-proxy": "1",
        "x-sandbox-preview-port": String(route.port),
        "x-sandbox-preview-sandbox-id": route.sessionId,
        "x-sandbox-preview-token": route.routeNonce,
        [HATCH_PRIVATE_REQUEST_HEADER]: permit.requestId,
      },
    }),
  );
};

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

type AbsoluteCallback =
  | "sessionActorDeadline"
  | "sessionActorHardCap"
  | "sessionActorHardCapDrain"
  | "sessionActorCheckpointMidpoint"
  | "expireEvidenceJob"
  | "expireRetainedEvidence";
const decodeEvidenceDeadline = Schema.decodeUnknownSync(
  Schema.Struct({ nonce: Schema.String, deadlineAt: Schema.String }),
);
const decodeAbsoluteAlarmPayload = Schema.decodeUnknownSync(
  Schema.Struct({
    deadlineAt: Schema.String,
    drainAt: Schema.optionalKey(Schema.String),
    midpointAt: Schema.optionalKey(Schema.String),
  }),
);
const decodeOptionalAlarmKind = Schema.decodeUnknownSync(
  Schema.Struct({ kind: Schema.optionalKey(Schema.String) }),
);

// Container stores Date schedules as floor(seconds), fires due rows, then deletes the fired row.
const fireContainerAlarm = async (
  harness: SessionHarness,
  callback: AbsoluteCallback,
  atMillis: number,
): Promise<void> => {
  const row = harness.schedules.findLast((schedule) => schedule.callback === callback);
  assert.isDefined(row);
  assert.instanceOf(row.when, Date);
  assert.isAtMost(Math.floor(row.when.getTime() / 1_000) * 1_000, atMillis);
  try {
    if (callback === "sessionActorDeadline")
      await harness.sandbox.sessionActorDeadline(row.payload);
    else if (callback === "sessionActorHardCap")
      await harness.sandbox.sessionActorHardCap(row.payload);
    else if (callback === "sessionActorHardCapDrain")
      await harness.sandbox.sessionActorHardCapDrain(row.payload);
    else if (callback === "sessionActorCheckpointMidpoint")
      await harness.sandbox.sessionActorCheckpointMidpoint(row.payload);
    else if (callback === "expireEvidenceJob")
      await harness.sandbox.expireEvidenceJob(decodeEvidenceDeadline(row.payload));
    else await harness.sandbox.expireRetainedEvidence(row.payload);
  } finally {
    const index = harness.schedules.indexOf(row);
    if (index >= 0) harness.schedules.splice(index, 1);
  }
};

const makeLegacyDeadlineRow = (harness: SessionHarness): string => {
  const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
  assert.ok(authority !== undefined && Predicate.isTagged(authority.state, "Transitioning"));
  const transition = authority.state.transition;
  harness.schedules.push({
    when: new Date(transition.deadlineAt),
    callback: "sessionActorDeadline",
    payload: {
      alarmId: actorAlarmId(
        "deadline",
        transition.nonce,
        transition.attempt,
        transition.deadlineAt,
      ),
      revision: authority.revision,
      transitionNonce: transition.nonce,
      attempt: transition.attempt,
      expectedPhase: transition.phase,
      expectedDeadlineAt: transition.deadlineAt,
      correlationId: crypto.randomUUID(),
    },
  });
  return transition.deadlineAt;
};

const makeLegacyAbsoluteRow = (harness: SessionHarness, callback: AbsoluteCallback) => {
  const index = harness.schedules.findIndex((schedule) => schedule.callback === callback);
  assert.isAtLeast(index, 0);
  const row = harness.schedules[index];
  assert.isDefined(row);
  const payload = decodeAbsoluteAlarmPayload(row.payload);
  const deadline =
    callback === "sessionActorHardCapDrain"
      ? payload.drainAt
      : callback === "sessionActorCheckpointMidpoint"
        ? payload.midpointAt
        : payload.deadlineAt;
  assert.isDefined(deadline);
  harness.schedules.splice(index, 1, { ...row, when: new Date(deadline) });
  return deadline;
};

const makeHatchHealthContainerFetch =
  (nextHealthStatus: () => number): NonNullable<HarnessOptions["containerFetch"]> =>
  async (request, port) => {
    const pathname = new URL(request.url).pathname;
    if (port === 43_117) {
      if (pathname === "/health")
        return Response.json({ status: "ready", epoch: `pi-${SESSION_ID}` });
      if (pathname === "/snapshot") return Response.json({ epoch: `pi-${SESSION_ID}` });
      return Response.json({ status: pathname === "/quiesce" ? "quiesced" : "ready" });
    }
    const status = nextHealthStatus();
    return new Response(status >= 200 && status <= 399 ? "healthy" : "unhealthy", { status });
  };

describe("absolute Container alarms", () => {
  it("recognizes retention successors persisted before and after second rounding changed", () => {
    const expiresAt = "2026-09-03T00:00:00.999Z";
    const legacySecond = Math.floor(Date.parse(expiresAt) / 1_000);
    assert.isTrue(matchesPersistedAlarmSecond(legacySecond, expiresAt));
    assert.isTrue(matchesPersistedAlarmSecond(legacySecond + 1, expiresAt));
    assert.isFalse(matchesPersistedAlarmSecond(legacySecond + 2, expiresAt));
  });
  it("rounds fractional instants up and preserves exact seconds", () => {
    assert.strictEqual(
      absoluteAlarmDate("2026-09-03T00:00:00.001Z").toISOString(),
      "2026-09-03T00:00:01.000Z",
    );
    assert.strictEqual(
      absoluteAlarmDate("2026-09-03T00:00:00.999Z").toISOString(),
      "2026-09-03T00:00:01.000Z",
    );
    assert.strictEqual(
      absoluteAlarmDate("2026-09-03T00:00:01.000Z").toISOString(),
      "2026-09-03T00:00:01.000Z",
    );
  });

  it.effect("rearms an early legacy deadline fence and settles the transition on time", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.999Z"));
      const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      harness.injectFailure("actorAlarmScheduleOnce");
      const failed = yield* Effect.promise(() =>
        harness.sandbox.checkpointScottySession().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      assert.instanceOf(failed, ScottyError);
      const deadlineAt = makeLegacyDeadlineRow(harness);
      const floor = Math.floor(Date.parse(deadlineAt) / 1_000) * 1_000;
      yield* clock.setTime(floor);
      yield* Effect.promise(() => fireContainerAlarm(harness, "sessionActorDeadline", floor));
      const transitioning = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        transitioning !== undefined && Predicate.isTagged(transitioning.state, "Transitioning"),
      );
      const rearmed = harness.schedules.findLast((row) => row.callback === "sessionActorDeadline");
      assert.instanceOf(rearmed?.when, Date);
      assert.strictEqual(rearmed.when.getTime(), absoluteAlarmDate(deadlineAt).getTime());
      assert.strictEqual(decodeOptionalAlarmKind(rearmed.payload).kind, undefined);

      const firedAt = rearmed.when.getTime();
      yield* clock.setTime(firedAt);
      yield* Effect.promise(() => fireContainerAlarm(harness, "sessionActorDeadline", firedAt));
      const settled = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        settled !== undefined &&
          Predicate.isTagged(settled.state, "Stable") &&
          Predicate.isTagged(settled.state.stable, "Failed"),
      );
      assert.strictEqual(settled.state.stable.code, "transition_deadline_elapsed");
    }),
  );

  for (const earlyBy of [999, 1]) {
    it.effect(`rearms a final hard cap fired ${earlyBy} ms early`, () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(
          Date.parse(`2026-09-03T00:00:00.${String(1_000 - earlyBy).padStart(3, "0")}Z`),
        );
        const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
        yield* Effect.promise(() =>
          harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
        );
        const deadlineAt = makeLegacyAbsoluteRow(harness, "sessionActorHardCap");
        const floor = Math.floor(Date.parse(deadlineAt) / 1_000) * 1_000;
        yield* clock.setTime(floor);
        yield* Effect.promise(() => fireContainerAlarm(harness, "sessionActorHardCap", floor));
        const rearmed = harness.schedules.findLast((row) => row.callback === "sessionActorHardCap");
        assert.instanceOf(rearmed?.when, Date);
        assert.strictEqual(rearmed.when.getTime(), absoluteAlarmDate(deadlineAt).getTime());
        const firedAt = rearmed.when.getTime();
        yield* clock.setTime(firedAt);
        yield* Effect.promise(() => fireContainerAlarm(harness, "sessionActorHardCap", firedAt));
        const settled = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
        assert.ok(
          settled !== undefined &&
            Predicate.isTagged(settled.state, "Stable") &&
            Predicate.isTagged(settled.state.stable, "Failed"),
        );
        assert.strictEqual(settled.state.stable.code, "hard_cap_elapsed");
      }),
    );
  }

  const earlyCallbacks: ReadonlyArray<AbsoluteCallback> = [
    "sessionActorHardCapDrain",
    "sessionActorCheckpointMidpoint",
  ];
  for (const callback of earlyCallbacks) {
    it.effect(`rearms an early ${callback} alarm`, () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(Date.parse("2026-09-03T00:00:00.999Z"));
        const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
        yield* Effect.promise(() =>
          harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
        );
        const target = makeLegacyAbsoluteRow(harness, callback);
        const floor = Math.floor(Date.parse(target) / 1_000) * 1_000;
        yield* clock.setTime(floor);
        yield* Effect.promise(() => fireContainerAlarm(harness, callback, floor));
        const rearmed = harness.schedules.findLast((row) => row.callback === callback);
        assert.instanceOf(rearmed?.when, Date);
        assert.strictEqual(rearmed.when.getTime(), absoluteAlarmDate(target).getTime());
      }),
    );
  }

  it.effect("rearms an early Evidence job expiry", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.999Z"));
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          evidenceEnabled: true,
          rawPiContainerRunning: true,
          piSessionRunning: true,
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const active = yield* Effect.promise(() =>
        harness.sandbox.acceptScottyEvidenceJob({
          port: 4_173,
          viewport: { width: 1_280, height: 720 },
          capture: { screenshots: "after-each-step", video: false },
          steps: [
            {
              name: "Open",
              action: { kind: "goto", path: "/" },
              expect: [{ kind: "urlPath", expected: "/" }],
            },
          ],
        }),
      );
      const index = harness.schedules.findIndex((row) => row.callback === "expireEvidenceJob");
      assert.isAtLeast(index, 0);
      const row = harness.schedules[index];
      assert.isDefined(row);
      const payload = decodeEvidenceDeadline(row.payload);
      harness.schedules.splice(index, 1, { ...row, when: new Date(payload.deadlineAt) });
      const floor = Math.floor(Date.parse(payload.deadlineAt) / 1_000) * 1_000;
      yield* clock.setTime(floor);
      yield* Effect.promise(() => fireContainerAlarm(harness, "expireEvidenceJob", floor));
      assert.strictEqual(
        harness.read<EvidenceState>(sessionHarnessKeys.evidence)?.activeJob?.operationNonce,
        active.operationNonce,
      );
      const rearmed = harness.schedules.findLast(
        (schedule) => schedule.callback === "expireEvidenceJob",
      );
      assert.instanceOf(rearmed?.when, Date);
      assert.strictEqual(rearmed.when.getTime(), absoluteAlarmDate(payload.deadlineAt).getTime());
    }),
  );

  it.effect("rearms an early retained Evidence expiry", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      const expiresAt = "2026-09-03T00:00:00.999Z";
      const floor = Math.floor(Date.parse(expiresAt) / 1_000) * 1_000;
      yield* clock.setTime(floor);
      const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
      harness.schedules.push({
        when: new Date(expiresAt),
        callback: "expireRetainedEvidence",
        payload: { expiresAt },
      });
      yield* Effect.promise(() => fireContainerAlarm(harness, "expireRetainedEvidence", floor));
      const rearmed = harness.schedules.findLast(
        (schedule) => schedule.callback === "expireRetainedEvidence",
      );
      assert.instanceOf(rearmed?.when, Date);
      assert.strictEqual(rearmed.when.getTime(), absoluteAlarmDate(expiresAt).getTime());
      assert.deepStrictEqual(rearmed.payload, { expiresAt });
    }),
  );

  it.effect("retries a transient deadline rearm failure", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.999Z"));
      const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      harness.injectFailure("actorAlarmScheduleOnce");
      yield* Effect.promise(() =>
        harness.sandbox.checkpointScottySession().then(
          () => undefined,
          () => undefined,
        ),
      );
      const target = makeLegacyDeadlineRow(harness);
      const floor = Math.floor(Date.parse(target) / 1_000) * 1_000;
      harness.injectFailure("actorAlarmScheduleOnce");
      yield* clock.setTime(floor);
      const firing = fireContainerAlarm(harness, "sessionActorDeadline", floor);
      yield* Effect.yieldNow;
      yield* clock.adjust("1 second");
      yield* Effect.promise(() => firing);
      assert.isTrue(
        harness.schedules.some(
          (row) =>
            row.callback === "sessionActorDeadline" &&
            row.when instanceof Date &&
            row.when.getTime() === absoluteAlarmDate(target).getTime(),
        ),
      );
    }),
  );

  const overdueRequests: ReadonlyArray<"session" | "diagnostics" | "lifecycle"> = [
    "session",
    "diagnostics",
    "lifecycle",
  ];
  for (const request of overdueRequests) {
    it.effect(`schedules one overdue transition alarm on repeated ${request} requests`, () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(Date.parse("2026-09-03T00:00:00.999Z"));
        const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
        yield* Effect.promise(() =>
          harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
        );
        harness.injectFailure("actorAlarmScheduleOnce");
        yield* Effect.promise(() =>
          harness.sandbox.checkpointScottySession().then(
            () => undefined,
            () => undefined,
          ),
        );
        const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
        assert.ok(authority !== undefined && Predicate.isTagged(authority.state, "Transitioning"));
        harness.schedules.unshift({
          when: new Date(Date.parse(authority.state.transition.deadlineAt)),
          callback: "sessionActorDeadline",
          payload: {
            kind: "deadline",
            alarmId: actorAlarmId(
              "deadline",
              authority.state.transition.nonce,
              authority.state.transition.attempt,
              authority.state.transition.deadlineAt,
            ),
            revision: authority.revision - 1,
            transitionNonce: authority.state.transition.nonce,
            attempt: authority.state.transition.attempt,
            expectedPhase: authority.state.transition.phase,
            expectedDeadlineAt: authority.state.transition.deadlineAt,
            correlationId: "stale-fence",
          },
        });
        const deadlineCount = harness.schedules.filter(
          (schedule) => schedule.callback === "sessionActorDeadline",
        ).length;
        yield* clock.setTime(Date.parse(authority.state.transition.deadlineAt) + 1);
        const requestSession = () =>
          request === "session"
            ? harness.sandbox.getScottySession().then(() => undefined)
            : request === "diagnostics"
              ? harness.sandbox.getScottyActorDiagnostics().then(() => undefined)
              : harness.sandbox.sleepScottySession().then(
                  () => undefined,
                  () => undefined,
                );
        yield* Effect.promise(requestSession);
        yield* Effect.promise(requestSession);
        const pending = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
        assert.ok(pending !== undefined && Predicate.isTagged(pending.state, "Transitioning"));
        const deadlines = harness.schedules.filter(
          (schedule) => schedule.callback === "sessionActorDeadline",
        );
        assert.lengthOf(deadlines, deadlineCount + 1);
        const due = deadlines.at(-1);
        assert.isDefined(due);
        const dueAt = due.when;
        assert.instanceOf(dueAt, Date);
        yield* clock.setTime(dueAt.getTime());
        yield* Effect.promise(() =>
          fireContainerAlarm(harness, "sessionActorDeadline", dueAt.getTime()),
        );
        const settled = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
        assert.ok(
          settled !== undefined &&
            Predicate.isTagged(settled.state, "Stable") &&
            Predicate.isTagged(settled.state.stable, "Failed"),
        );
        assert.strictEqual(settled.state.stable.code, "transition_deadline_elapsed");
      }),
    );
  }

  it.effect("returns pending for an overdue same-kind POST until the alarm runs", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      harness.injectFailure("actorAlarmScheduleOnce");
      yield* Effect.promise(() =>
        harness.sandbox.checkpointScottySession().then(
          () => undefined,
          () => undefined,
        ),
      );
      const before = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(before !== undefined && Predicate.isTagged(before.state, "Transitioning"));
      yield* clock.setTime(Date.parse(before.state.transition.deadlineAt) + 1);
      const result = yield* Effect.promise(() => harness.sandbox.checkpointScottySession());
      assert.isTrue("pending" in result && result.pending);
      const after = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.strictEqual(after?.revision, before.revision);
    }),
  );

  it.effect("leaves a pending transition alone while its nonce is mutating", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.999Z"));
      const restoreGate = deferred<void>();
      let blockRestore = false;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          restoreBackupGate: () => (blockRestore ? restoreGate.promise : undefined),
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      yield* Effect.promise(() => harness.sandbox.sleepScottySession());
      blockRestore = true;
      const resuming = harness.sandbox.resumeScottySession().then(
        () => undefined,
        () => undefined,
      );
      while (harness.events.filter((event) => event === "host:restoreBackup").length < 2)
        yield* Effect.yieldNow;
      const active = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(active !== undefined && Predicate.isTagged(active.state, "Transitioning"));
      yield* clock.setTime(Date.parse(active.state.transition.deadlineAt) - 30_001);
      yield* Effect.promise(() => harness.sandbox.getScottySession());
      const afterRead = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(afterRead !== undefined && Predicate.isTagged(afterRead.state, "Transitioning"));
      assert.strictEqual(afterRead.state.transition.nonce, active.state.transition.nonce);
      assert.strictEqual(afterRead.revision, active.revision);
      restoreGate.resolve();
      yield* Effect.promise(() => resuming);
    }),
  );
});

describe("Sandbox actor checkpoint, sleep, and resume", () => {
  it.effect("stops retrying a failed drain successor after the bounded window", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          agentTurnActivity: AgentTurnActivity.of({ isTurnActive: () => Effect.succeed(true) }),
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const drain = harness.schedules.find(
        (schedule) => schedule.callback === "sessionActorHardCapDrain",
      );
      assert.isDefined(drain);
      const fence = decodeDrainFence(drain.payload);
      assert.isTrue(Option.isSome(fence));
      if (Option.isNone(fence)) return;
      yield* clock.setTime(Date.parse(fence.value.drainAt));
      harness.injectFailure("hardCapDrainSchedule");
      const errors: string[] = [];
      const logger = vi
        .spyOn(console, "log")
        .mockImplementation((...messages: ReadonlyArray<unknown>) => {
          errors.push(messages.map(String).join(" "));
        });
      const firing = harness.sandbox.sessionActorHardCapDrain(drain.payload);
      yield* clock.adjust("65 seconds");
      yield* Effect.promise(() => firing).pipe(
        Effect.ensuring(Effect.sync(() => logger.mockRestore())),
      );
      assert.isTrue(
        errors.some((message) =>
          message.includes("Failed to schedule sessionActorHardCapDrain within 60 seconds"),
        ),
      );
      assert.isAbove(
        harness.events.filter((event) => event === "schedule:sessionActorHardCapDrain").length,
        2,
      );
    }),
  );
  it.effect("rearms a lost final hard cap once on repeated Warm reads", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.isDefined(authority);
      for (let index = harness.schedules.length - 1; index >= 0; index -= 1)
        if (harness.schedules[index]?.callback === "sessionActorHardCap")
          harness.schedules.splice(index, 1);
      yield* clock.setTime(Date.parse(authority.hardCap.deadlineAt) + 1);
      yield* Effect.promise(() => harness.sandbox.getScottySession());
      yield* Effect.promise(() => harness.sandbox.getScottySession());
      assert.lengthOf(
        harness.schedules.filter((schedule) => schedule.callback === "sessionActorHardCap"),
        1,
      );
    }),
  );

  it.effect("waits for an active agent turn and sleeps when the agent is idle", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      let active = true;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          agentTurnActivity: AgentTurnActivity.of({
            isTurnActive: () => Effect.succeed(active),
          }),
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const drain = harness.schedules.find(
        (schedule) => schedule.callback === "sessionActorHardCapDrain",
      );
      assert.isDefined(drain);
      const fence = decodeDrainFence(drain.payload);
      assert.isTrue(Option.isSome(fence));
      if (Option.isNone(fence)) return;
      yield* clock.setTime(Date.parse(fence.value.drainAt));
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const waiting = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        waiting !== undefined &&
          Predicate.isTagged(waiting.state, "Stable") &&
          Predicate.isTagged(waiting.state.stable, "Warm"),
      );
      assert.strictEqual(harness.events.filter((event) => event === "host:createBackup").length, 0);
      assert.strictEqual(
        harness.schedules
          .filter((schedule) => schedule.callback === "sessionActorHardCapDrain")
          .at(-1)?.when,
        5,
      );

      active = false;
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const sleeping = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        sleeping !== undefined &&
          Predicate.isTagged(sleeping.state, "Stable") &&
          Predicate.isTagged(sleeping.state.stable, "Sleeping"),
      );
      assert.strictEqual(harness.events.filter((event) => event === "host:createBackup").length, 1);
    }),
  );

  it.effect("sleeps at forceAt even while the agent turn is active", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          agentTurnActivity: AgentTurnActivity.of({ isTurnActive: () => Effect.succeed(true) }),
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const drain = harness.schedules.find(
        (schedule) => schedule.callback === "sessionActorHardCapDrain",
      );
      assert.isDefined(drain);
      const fence = decodeDrainFence(drain.payload);
      assert.isTrue(Option.isSome(fence));
      if (Option.isNone(fence)) return;
      yield* clock.setTime(Date.parse(fence.value.drainAt));
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const waiting = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        waiting !== undefined &&
          Predicate.isTagged(waiting.state, "Stable") &&
          Predicate.isTagged(waiting.state.stable, "Warm"),
      );
      assert.strictEqual(
        harness.schedules
          .filter((schedule) => schedule.callback === "sessionActorHardCapDrain")
          .at(-1)?.when,
        5,
      );
      const forceAt =
        Date.parse(fence.value.deadlineAt) -
        Math.min(
          5 * 60_000,
          (Date.parse(fence.value.deadlineAt) - Date.parse(fence.value.drainAt)) / 2,
        );
      yield* clock.setTime(forceAt);
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const sleeping = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        sleeping !== undefined &&
          Predicate.isTagged(sleeping.state, "Stable") &&
          Predicate.isTagged(sleeping.state.stable, "Sleeping"),
      );
    }),
  );

  it("reconciles Sleep when workspace writers survive and leaves Checkpoint untouched", async () => {
    const harness = await createSessionHarness({
      commandStdout: (command) =>
        command.includes("scotty_workspace_writer_sweep")
          ? '{"found":1,"killed":0,"survivors":1}\n'
          : undefined,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.checkpointScottySession();
    assert.isFalse(
      harness.commands.some((command) => command.includes("scotty_workspace_writer_sweep")),
    );

    await harness.sandbox.sleepScottySession().then(
      () => undefined,
      () => undefined,
    );
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Transitioning") &&
        Predicate.isTagged(authority.state.transition, "Sleep"),
    );
    assert.strictEqual(authority.state.transition.mode, "reconciling");
    assert.isTrue(
      harness.commands.some((command) => command.includes("scotty_workspace_writer_sweep")),
    );
  });

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
      new Date(Date.parse(authority.hardCap.deadlineAt) - 10 * 60_000).toISOString(),
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

  it.effect("reconciles its orphaned Sleep on drain retries without repeating provider work", () =>
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

      yield* clock.setTime(Date.parse(drainPayload.value.drainAt));
      harness.injectFailure("actorAlarmScheduleOnce");
      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const orphaned = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        orphaned !== undefined &&
          Predicate.isTagged(orphaned.state, "Transitioning") &&
          Predicate.isTagged(orphaned.state.transition, "Sleep"),
      );
      assert.strictEqual(harness.events.filter((event) => event === "host:createBackup").length, 0);

      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const reconciling = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        reconciling !== undefined &&
          Predicate.isTagged(reconciling.state, "Transitioning") &&
          Predicate.isTagged(reconciling.state.transition, "Sleep") &&
          reconciling.state.transition.mode === "reconciling",
      );

      yield* Effect.promise(() => harness.sandbox.sessionActorHardCapDrain(drain.payload));
      const settled = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        settled !== undefined &&
          Predicate.isTagged(settled.state, "Stable") &&
          Predicate.isTagged(settled.state.stable, "Failed"),
      );
      assert.strictEqual(settled.state.stable.code, "reconciliation_outcome_unknown");
      assert.strictEqual(harness.events.filter((event) => event === "host:createBackup").length, 0);
      assert.strictEqual(harness.events.filter((event) => event === "host:stop").length, 0);
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

  it.effect("allows bounded backup work for Sleep and Resume without extending Checkpoint", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      const startedAt = Date.parse("2026-09-03T00:00:00.000Z");
      yield* clock.setTime(startedAt);
      const harness = yield* Effect.promise(() => createSessionHarness({ clock }));
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const deadline = () => {
        const when = harness.schedules
          .filter((schedule) => schedule.callback === "sessionActorDeadline")
          .at(-1)?.when;
        assert.instanceOf(when, Date);
        return when.toISOString();
      };

      yield* Effect.promise(() => harness.sandbox.checkpointScottySession());
      assert.strictEqual(deadline(), new Date(startedAt + 5 * 60_000).toISOString());

      yield* Effect.promise(() => harness.sandbox.sleepScottySession());
      assert.strictEqual(deadline(), new Date(startedAt + 10 * 60_000).toISOString());

      yield* Effect.promise(() => harness.sandbox.resumeScottySession());
      assert.strictEqual(deadline(), new Date(startedAt + 10 * 60_000).toISOString());

      const shortCap = yield* Effect.promise(() => createSessionHarness({ clock }));
      yield* Effect.promise(() =>
        shortCap.sandbox.createScottySession(
          { ...CREATE_INPUT, hardCapSeconds: 360 },
          SESSION_ID,
          CREATE_IDEMPOTENCY,
        ),
      );
      yield* Effect.promise(() => shortCap.sandbox.sleepScottySession());
      const shortSleepDeadline = shortCap.schedules
        .filter((schedule) => schedule.callback === "sessionActorDeadline")
        .at(-1)?.when;
      assert.instanceOf(shortSleepDeadline, Date);
      assert.strictEqual(
        shortSleepDeadline.toISOString(),
        new Date(startedAt + 360_000).toISOString(),
      );
      yield* Effect.promise(() => shortCap.sandbox.resumeScottySession());
      const shortResumeDeadline = shortCap.schedules
        .filter((schedule) => schedule.callback === "sessionActorDeadline")
        .at(-1)?.when;
      assert.instanceOf(shortResumeDeadline, Date);
      assert.strictEqual(
        shortResumeDeadline.toISOString(),
        new Date(startedAt + 360_000).toISOString(),
      );
    }),
  );

  it.effect("keeps a confirmed backup owned while a restore exceeds five minutes", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const releaseRestore = deferred<void>();
      let blockRestore = false;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          restoreBackupGate: () => (blockRestore ? releaseRestore.promise : undefined),
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      yield* Effect.promise(() => harness.sandbox.sleepScottySession());
      blockRestore = true;
      const resume = harness.sandbox.resumeScottySession();
      while (harness.events.filter((event) => event === "host:restoreBackup").length < 2)
        yield* Effect.yieldNow;

      yield* clock.adjust(5 * 60_000 + 1_000);
      const inProgress = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        inProgress !== undefined &&
          Predicate.isTagged(inProgress.state, "Transitioning") &&
          Predicate.isTagged(inProgress.state.transition, "Resume"),
      );
      assert.strictEqual(inProgress.state.transition.phase, "WatchdogArmed");
      assert.strictEqual(inProgress.state.transition.proof.backup.backupId, "backup-1");
      const alarm = harness.schedules
        .filter((schedule) => schedule.callback === "sessionActorDeadline")
        .at(-1);
      assert.isDefined(alarm);
      yield* Effect.promise(() => harness.sandbox.sessionActorDeadline(alarm.payload));
      releaseRestore.resolve();
      const resumed = yield* Effect.promise(() => resume);
      assert.strictEqual(resumed.status, "warm");
      assert.strictEqual(
        harness.events.filter((event) => event === "host:restoreBackup").length,
        2,
      );
    }),
  );

  it.effect("moves Sleep Syncing to reconciling when backup creation times out", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const releaseBackup = deferred<void>();
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          createBackupGate: () => releaseBackup.promise,
          restoreBackupGate: () => releaseBackup.promise,
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const sleep = harness.sandbox.sleepScottySession().then(
        () => undefined,
        () => undefined,
      );
      while (!harness.events.includes("host:createBackup")) yield* Effect.yieldNow;
      const syncing = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(syncing !== undefined && Predicate.isTagged(syncing.state, "Transitioning"));
      assert.ok(Predicate.isTagged(syncing.state.transition, "Sleep"));
      assert.strictEqual(syncing.state.transition.phase, "Syncing");
      assert.include(
        syncing.state.transition.proof.backup.ownedBackupIds,
        syncing.state.transition.attempt,
      );
      const remaining =
        Date.parse(syncing.state.transition.deadlineAt) - (yield* clock.currentTimeMillis);
      const timeout = Math.max(5_000, remaining - 30_000);
      yield* clock.adjust(timeout);
      const reconciling = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        reconciling !== undefined && Predicate.isTagged(reconciling.state, "Transitioning"),
      );
      assert.ok(Predicate.isTagged(reconciling.state.transition, "Sleep"));
      assert.strictEqual(reconciling.state.transition.phase, "Syncing");
      assert.strictEqual(reconciling.state.transition.mode, "reconciling");
      assert.include(
        reconciling.state.transition.proof.backup.ownedBackupIds,
        reconciling.state.transition.attempt,
      );
      releaseBackup.resolve();
      yield* Effect.promise(() => sleep);
    }),
  );

  it("restores the session's pinned environment after cloud settings change", async () => {
    let cloudSettings: CloudSettingsSnapshot = {
      revision: 3,
      activeDigest: null,
      settings: { ...defaultCloudSettings, environment: { APP_MODE: "pinned" } },
    };
    const harness = await createSessionHarness({ readCloudSettings: () => cloudSettings });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.sleepScottySession();
    cloudSettings = {
      revision: 4,
      activeDigest: null,
      settings: { ...defaultCloudSettings, environment: { APP_MODE: "new-default" } },
    };
    const readsBeforeResume = harness.sandboxConfigStatusCallCount();
    const updatesBeforeResume = harness.environmentUpdates.length;

    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), readsBeforeResume);
    assert.ok(harness.environmentUpdates.length > updatesBeforeResume);
    assert.deepStrictEqual(harness.environmentUpdates.at(-1), { APP_MODE: "pinned" });
    assert.deepStrictEqual(
      harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority)?.session.configuration,
      {
        runtimeCli: runtimeCliPin,
        revision: 3,
        bundleDigest: null,
        agentInstructions: scottyBaseAgentInstructions,
        environment: { APP_MODE: "pinned" },
      },
    );
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

    const retry = await harness.sandbox.checkpointScottySession();

    assert.isTrue("pending" in retry && retry.pending);
    assert.strictEqual(retry.operation?.kind, "snapshot");
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

  it("returns pending for a reconciling Sleep with its alarm armed", async () => {
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    harness.injectFailure("actorAlarmScheduleOnce");
    const first = await harness.sandbox.sleepScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.instanceOf(first, ScottyError);
    const retry = await harness.sandbox.sleepScottySession();
    assert.isTrue("pending" in retry && retry.pending);
    assert.strictEqual(retry.operation?.kind, "sleep");
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(authority !== undefined && Predicate.isTagged(authority.state, "Transitioning"));
    assert.strictEqual(retry.operation?.deadlineAt, authority.state.transition.deadlineAt);
    assert.isTrue(
      harness.schedules.some((schedule) => schedule.callback === "sessionActorDeadline"),
    );
  });

  it("returns a recovered Checkpoint without dispatching a second checkpoint", async () => {
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    let gateProbe = false;
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
      hatchPublicProbe: async () => {
        if (gateProbe) {
          probeEntered.resolve();
          await releaseProbe.promise;
        }
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow, noarchive",
            "x-scotty-hatch-readiness": "ready",
          },
        });
      },
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
    gateProbe = true;
    const original = harness.sandbox.checkpointScottySession();
    await probeEntered.promise;
    const restarted = await createSessionHarness({
      sharedMemory: harness.memory,
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await restarted.sandbox.checkpointScottySession().then(
      () => undefined,
      () => undefined,
    );

    const checkpointed = await restarted.sandbox.checkpointScottySession();
    const recoveredHatch = harness.read<HatchState>(sessionHarnessKeys.hatch);
    const unexposeCallsBeforeLateCompletion = harness.events.filter(
      (event) => event === "host:preview:unexpose:4173",
    ).length;
    releaseProbe.resolve();
    await original.then(
      () => undefined,
      () => undefined,
    );

    assert.strictEqual(checkpointed.status, "warm");
    assert.strictEqual(
      [...harness.events, ...restarted.events].filter((event) => event === "host:createBackup")
        .length,
      1,
    );
    assert.deepStrictEqual(harness.read<HatchState>(sessionHarnessKeys.hatch), recoveredHatch);
    assert.strictEqual(
      harness.events.filter((event) => event === "host:preview:unexpose:4173").length,
      unexposeCallsBeforeLateCompletion,
    );
  });

  it("cleans a late Hatch restore after authority settles Failed and retries unknown unexpose", async () => {
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    let gateProbe = false;
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
      hatchPublicProbe: async () => {
        if (gateProbe) {
          probeEntered.resolve();
          await releaseProbe.promise;
        }
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow, noarchive",
            "x-scotty-hatch-readiness": "ready",
          },
        });
      },
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
    gateProbe = true;
    const original = harness.sandbox.checkpointScottySession();
    await probeEntered.promise;
    const restarted = await createSessionHarness({
      sharedMemory: harness.memory,
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await restarted.sandbox.checkpointScottySession().then(
      () => undefined,
      () => undefined,
    );
    const reconciling = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(reconciling !== undefined && Predicate.isTagged(reconciling.state, "Transitioning"));
    assert.strictEqual(reconciling.state.transition.mode, "reconciling");
    const restoringState = harness.read<HatchState>(sessionHarnessKeys.hatch);
    assert.isDefined(restoringState);
    const restoring = restoringState.primary;
    assert.isDefined(restoring);
    assert.ok(Predicate.isTagged(reconciling.state.transition, "Checkpoint"));
    const failed: SessionAuthority = {
      ...reconciling,
      revision: reconciling.revision + 1,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Failed",
          code: "transition_deadline_elapsed",
          actionable: false,
          origin: reconciling.state.transition.origin,
          lastStable: "Warm",
          backup: null,
          ownedBackupIds: reconciling.state.transition.proof.backup.ownedBackupIds,
          wakeSource: null,
        },
      },
    };
    const journalTail = harness.read<LifecycleJournalEvent>(sessionHarnessKeys.actorJournalTail);
    assert.isDefined(journalTail);
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, failed);
    harness.memory.values.set(sessionHarnessKeys.actorRevision, failed.revision);
    harness.memory.values.set(sessionHarnessKeys.actorJournalSequence, failed.revision);
    harness.memory.values.set(sessionHarnessKeys.actorJournalTail, {
      ...journalTail,
      sequence: failed.revision,
      revision: failed.revision,
      eventType: "hard_cap_elapsed",
      resultCode: "transition_deadline_elapsed",
    });
    harness.injectFailure("previewUnexpose");

    releaseProbe.resolve();
    const originalFailure = await original.then(
      () => undefined,
      (error: unknown) => error,
    );

    const hatchState = harness.read<HatchState>(sessionHarnessKeys.hatch);
    assert.isDefined(hatchState);
    const hatch = hatchState.primary;
    assert.isDefined(hatch);
    assert.notStrictEqual(hatch.observedStatus, "running");
    assert.notStrictEqual(hatch.exposure, "active");
    assert.strictEqual(hatch.hatchId, restoring.hatchId);
    assert.strictEqual(hatch.generation, restoring.generation + 1);
    assert.strictEqual(hatch.runtimeEpoch, undefined);
    assert.strictEqual(hatch.cleanup?.operationNonce, reconciling.state.transition.nonce);
    assert.strictEqual(hatch.cleanup?.generation, restoring.generation + 1);
    assert.include(harness.events, "host:preview:unexpose:4173");
    assert.ok(harness.schedules.some((schedule) => schedule.callback === "retryHatchCleanup"));
    assert.instanceOf(originalFailure, ScottyError);
    assert.strictEqual(originalFailure.code, "upstream");

    const cleanupRetry = harness.schedules.find(
      (schedule) => schedule.callback === "retryHatchCleanup",
    );
    assert.isDefined(cleanupRetry);
    harness.clearFailure("previewUnexpose");
    await harness.sandbox.retryHatchCleanup(cleanupRetry.payload);
    const cleanedState = harness.read<HatchState>(sessionHarnessKeys.hatch);
    assert.isDefined(cleanedState);
    assert.strictEqual(cleanedState.primary?.observedStatus, "failed");
    assert.strictEqual(cleanedState.primary?.exposure, "closed");
    assert.strictEqual(cleanedState.primary?.cleanup, undefined);
  });

  it("returns a recovered Sleep without dispatching a second sleep", async () => {
    let injected = false;
    let harness: Awaited<ReturnType<typeof createSessionHarness>>;
    harness = await createSessionHarness({
      commandGate: (command) => {
        if (command === "sync" && !injected) {
          injected = true;
          harness.memory.injectFailure("transaction", {
            countdown: 11,
            error: new Error("injected sleep observation commit failure"),
            times: 1,
          });
        }
        return undefined;
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.sleepScottySession().then(
      () => undefined,
      () => undefined,
    );
    const reconciling = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(reconciling !== undefined && Predicate.isTagged(reconciling.state, "Transitioning"));
    assert.strictEqual(reconciling.state.transition.phase, "StopRequested");
    const sleeping = await harness.sandbox.sleepScottySession();

    assert.strictEqual(sleeping.status, "sleeping");
    assert.strictEqual(harness.events.filter((event) => event === "host:createBackup").length, 1);
    assert.strictEqual(harness.events.filter((event) => event === "host:stop").length, 1);
  });

  it("returns a recovered Resume without restoring or rearming the hard cap twice", async () => {
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    let gateProbe = false;
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
      hatchPublicProbe: async () => {
        if (gateProbe) {
          probeEntered.resolve();
          await releaseProbe.promise;
        }
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow, noarchive",
            "x-scotty-hatch-readiness": "ready",
          },
        });
      },
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
    await harness.sandbox.sleepScottySession();
    const restoreCallsBeforeResume = harness.events.filter(
      (event) => event === "host:restoreBackup",
    ).length;
    const hardCapSchedulesBeforeResume = harness.schedules.filter((schedule) =>
      schedule.callback.startsWith("sessionActorHardCap"),
    ).length;
    gateProbe = true;
    const original = harness.sandbox.resumeScottySession();
    await probeEntered.promise;
    const restarted = await createSessionHarness({
      sharedMemory: harness.memory,
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
    });
    await restarted.sandbox.resumeScottySession().then(
      () => undefined,
      () => undefined,
    );
    const hardCapSchedulesAfterFirstResume = harness.schedules.filter((schedule) =>
      schedule.callback.startsWith("sessionActorHardCap"),
    ).length;
    const resumed = await restarted.sandbox.resumeScottySession();
    releaseProbe.resolve();
    await original.then(
      () => undefined,
      () => undefined,
    );

    assert.strictEqual(resumed.status, "warm");
    assert.strictEqual(
      [...harness.events, ...restarted.events].filter((event) => event === "host:restoreBackup")
        .length,
      restoreCallsBeforeResume + 1,
    );
    assert.strictEqual(hardCapSchedulesAfterFirstResume, hardCapSchedulesBeforeResume + 2);
    assert.strictEqual(
      harness.schedules.filter((schedule) => schedule.callback.startsWith("sessionActorHardCap"))
        .length,
      hardCapSchedulesAfterFirstResume,
    );
    assert.lengthOf(
      restarted.schedules.filter((schedule) => schedule.callback.startsWith("sessionActorHardCap")),
      0,
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

    const overlap = await harness.sandbox.checkpointScottySession();
    assert.isTrue("pending" in overlap && overlap.pending);
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

  it("uses the completed controller authority when another lifecycle starts before the response", async () => {
    let race = false;
    let replacementStarted = false;
    let harness: SessionHarness;
    harness = await createSessionHarness({
      onSessionProjectionPut: async () => {
        if (!race) return;
        const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
        if (
          authority === undefined ||
          !Predicate.isTagged(authority.state, "Stable") ||
          !Predicate.isTagged(authority.state.stable, "Warm") ||
          authority.state.stable.backups.currentBackupId === null
        )
          return;
        race = false;
        replacementStarted = true;
        await harness.sandbox.sleepScottySession();
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    race = true;
    const completed = await harness.sandbox.checkpointScottySession();
    assert.isTrue(replacementStarted);
    assert.strictEqual(completed.status, "warm");
    assert.isFalse("pending" in completed);
    const after = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(after !== undefined && Predicate.isTagged(after.state, "Stable"));
    assert.isTrue(Predicate.isTagged(after.state.stable, "Sleeping"));
  });

  it("does not resume an alarm while the same transition nonce is mutating", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let gate = false;
    const harness = await createSessionHarness({
      createBackupGate: () => {
        if (!gate) return undefined;
        entered.resolve();
        return release.promise;
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    gate = true;
    const first = harness.sandbox.checkpointScottySession();
    await entered.promise;
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(authority !== undefined && Predicate.isTagged(authority.state, "Transitioning"));
    const transition = authority.state.transition;
    const overdue = "2020-01-01T00:00:00.000Z";
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, {
      ...authority,
      state: {
        ...authority.state,
        transition: { ...transition, deadlineAt: overdue },
      },
    });
    await harness.sandbox.sessionActorDeadline({
      kind: "deadline",
      alarmId: actorAlarmId("deadline", transition.nonce, transition.attempt, overdue),
      revision: authority.revision,
      transitionNonce: transition.nonce,
      attempt: transition.attempt,
      expectedPhase: transition.phase,
      expectedDeadlineAt: overdue,
      correlationId: "overlap-alarm",
    });
    assert.strictEqual(
      harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority)?.revision,
      authority.revision,
    );
    harness.memory.values.set(sessionHarnessKeys.actorAuthority, authority);
    release.resolve();
    assert.strictEqual((await first).status, "warm");
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

  it("does not report a stale Checkpoint recovery after Vaporize settles Gone", async () => {
    let recoveryHookCalls = 0;
    let replacement: { readonly id: string; readonly status: "gone" } | undefined;
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    harness.injectFailure("actorAlarmScheduleOnce");
    await harness.sandbox.checkpointScottySession().then(
      () => undefined,
      () => undefined,
    );
    const checkpoint = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      checkpoint !== undefined &&
        Predicate.isTagged(checkpoint.state, "Transitioning") &&
        Predicate.isTagged(checkpoint.state.transition, "Checkpoint"),
    );
    const checkpointNonce = checkpoint.state.transition.nonce;
    const backupCalls = harness.events.filter((event) => event === "host:createBackup").length;
    let restarted: Awaited<ReturnType<typeof createSessionHarness>>;
    restarted = await createSessionHarness({
      sharedMemory: harness.memory,
      actorRequestRecoveryBeforeResume: async () => {
        recoveryHookCalls += 1;
        replacement = await restarted.sandbox.vaporizeScottySession();
      },
    });
    const beforeRetry = restarted.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      beforeRetry !== undefined &&
        Predicate.isTagged(beforeRetry.state, "Transitioning") &&
        Predicate.isTagged(beforeRetry.state.transition, "Checkpoint"),
    );

    const retry = await restarted.sandbox.checkpointScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.strictEqual(recoveryHookCalls, 1);
    assert.deepStrictEqual(replacement, { id: SESSION_ID, status: "gone" });
    assert.instanceOf(retry, ScottyError);
    assert.strictEqual(retry.code, "wrong_state");
    assert.strictEqual(
      [...harness.events, ...restarted.events].filter((event) => event === "host:createBackup")
        .length,
      backupCalls,
    );
    const gone = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      gone !== undefined &&
        Predicate.isTagged(gone.state, "Stable") &&
        Predicate.isTagged(gone.state.stable, "Gone"),
    );
    const journal = harness.read<LifecycleJournalEvent>(sessionHarnessKeys.actorJournalTail);
    assert.deepInclude(journal, {
      eventType: "completed",
      transitionKind: "Vaporize",
    });
    assert.notStrictEqual(journal?.transitionNonce, checkpointNonce);
  });

  it("does not report Checkpoint recovered when Vaporize replaces its resumed transition", async () => {
    let recoveryHookCalls = 0;
    let replacement: { readonly id: string; readonly status: "gone" } | undefined;
    const harness = await createSessionHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    harness.injectFailure("actorAlarmScheduleOnce");
    await harness.sandbox.checkpointScottySession().then(
      () => undefined,
      () => undefined,
    );
    const checkpoint = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      checkpoint !== undefined &&
        Predicate.isTagged(checkpoint.state, "Transitioning") &&
        Predicate.isTagged(checkpoint.state.transition, "Checkpoint"),
    );
    const checkpointNonce = checkpoint.state.transition.nonce;
    const backupCalls = harness.events.filter((event) => event === "host:createBackup").length;
    let restarted: Awaited<ReturnType<typeof createSessionHarness>>;
    restarted = await createSessionHarness({
      sharedMemory: harness.memory,
      actorRequestRecoveryAfterResume: async () => {
        recoveryHookCalls += 1;
        const resumed = restarted.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
        assert.ok(
          resumed !== undefined &&
            Predicate.isTagged(resumed.state, "Transitioning") &&
            Predicate.isTagged(resumed.state.transition, "Checkpoint"),
        );
        assert.strictEqual(resumed.state.transition.mode, "reconciling");
        replacement = await restarted.sandbox.vaporizeScottySession();
      },
    });

    const retry = await restarted.sandbox.checkpointScottySession().then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.strictEqual(recoveryHookCalls, 1);
    assert.deepStrictEqual(replacement, { id: SESSION_ID, status: "gone" });
    assert.instanceOf(retry, ScottyError);
    assert.strictEqual(retry.code, "wrong_state");
    assert.strictEqual(
      [...harness.events, ...restarted.events].filter((event) => event === "host:createBackup")
        .length,
      backupCalls,
    );
    const gone = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      gone !== undefined &&
        Predicate.isTagged(gone.state, "Stable") &&
        Predicate.isTagged(gone.state.stable, "Gone"),
    );
    const journal = harness.read<LifecycleJournalEvent>(sessionHarnessKeys.actorJournalTail);
    assert.deepInclude(journal, {
      eventType: "completed",
      transitionKind: "Vaporize",
    });
    assert.notStrictEqual(journal?.transitionNonce, checkpointNonce);
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

  it("streams repeated 16 MiB and 32 MiB Hatch assets without cumulative denial", async () => {
    const assetSizes = [16, 32, 16, 32].map((mebibytes) => mebibytes * 1_024 * 1_024);
    const responseSizes = [...assetSizes, 32 * 1_024 * 1_024 + 1];
    let responseIndex = 0;
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
      hatchRequestForwarder: async () => {
        let remaining = responseSizes[responseIndex++] ?? 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (remaining === 0) {
                controller.close();
                return;
              }
              const bytes = Math.min(remaining, 1 * 1_024 * 1_024);
              remaining -= bytes;
              controller.enqueue(new Uint8Array(bytes));
            },
          }),
        );
      },
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
    const route = await harness.sandbox.getScottyHatchOpenRoute();
    assert.isDefined(route);

    for (const expectedBytes of assetSizes) {
      const response = await fetchAuthorizedHatchRequest(harness, route);
      assert.strictEqual(response.status, 200);
      assert.strictEqual((await response.arrayBuffer()).byteLength, expectedBytes);
    }
    const oversized = await fetchAuthorizedHatchRequest(harness, route);
    await expect(oversized.arrayBuffer()).rejects.toMatchObject({ name: "QuotaExceededError" });

    const hatch = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.strictEqual(hatch?.requests.length, 0);
    assert.deepInclude(hatch?.permits[0], { ingressBytes: 0, responseBytes: 0 });
  });

  it("cancels an active Hatch response stream when sleep revokes its route", async () => {
    let upstreamCanceled = false;
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
      hatchRequestForwarder: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              upstreamCanceled = true;
            },
          }),
        ),
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
    const route = await harness.sandbox.getScottyHatchOpenRoute();
    assert.isDefined(route);
    const response = await fetchAuthorizedHatchRequest(harness, route);
    assert.match(response.headers.get(HATCH_PRIVATE_CLAIMED_HEADER) ?? "", /^[0-9a-f]{32}$/u);
    const reader = response.body?.getReader();
    assert.isDefined(reader);
    assert.deepStrictEqual(await reader.read(), { done: false, value: new Uint8Array([1]) });
    const pendingRead = reader.read().then(
      (value) => value,
      (error: unknown) => error,
    );

    await harness.sandbox.sleepScottySession();

    assert.isTrue(upstreamCanceled);
    assert.instanceOf(await pendingRead, DOMException);
    assert.strictEqual(
      harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary?.requests.length,
      0,
    );
    assert.isUndefined(
      await harness.sandbox.getScottyHatchRoute({
        sessionId: route.sessionId,
        port: route.port,
        routeNonce: route.routeNonce,
      }),
    );
  });

  it("reclaims a retained prior Hatch restore before retrying Resume", async () => {
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
    await harness.sandbox.sleepScottySession();
    const state = harness.read<HatchState>(sessionHarnessKeys.hatch);
    assert.isDefined(state?.primary);
    harness.memory.values.set(sessionHarnessKeys.hatch, {
      primary: {
        ...state.primary,
        generation: state.primary.generation + 1,
        observedStatus: "starting",
        exposure: "unexpose_pending",
        runtimeEpoch: "prior-resume-runtime",
        transitionNonce: "prior-resume-nonce",
      },
    } satisfies HatchState);

    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    const hatch = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.isDefined(hatch);
    assert.strictEqual(hatch.observedStatus, "running");
    assert.strictEqual(hatch.exposure, "active");
    assert.isUndefined(hatch.transitionNonce);
    assert.notStrictEqual(hatch.runtimeEpoch, "prior-resume-runtime");
    assert.include(harness.events, "host:preview:unexpose:4173");
  });

  it.effect("rejects a stale runtime-start cleanup before its pending fast path", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          previewBase: "preview.example.test",
          rawPiContainerRunning: true,
          piSessionRunning: true,
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      yield* Effect.promise(() =>
        harness.sandbox.ensureScottyHatch({
          service: {
            name: "docs",
            argv: ["npm", "run", "dev"],
            workingDirectory: `/workspace/${SESSION_ID}`,
            port: 4_173,
            healthPath: "/health",
          },
        }),
      );
      yield* Effect.promise(() => harness.sandbox.sleepScottySession());
      const state = harness.read<HatchState>(sessionHarnessKeys.hatch);
      const record = harness.readRecord();
      assert.isDefined(state?.primary);
      assert.isDefined(record);
      const priorNonce = "prior-resume-nonce";
      const generation = state.primary.generation + 1;
      const pending: HatchState = {
        primary: {
          ...state.primary,
          generation,
          exposure: "unexpose_pending",
          transitionNonce: priorNonce,
          cleanup: {
            operationNonce: priorNonce,
            target: "sleeping",
            generation,
            requestedAt: record.createdAt,
          },
        },
      };
      let stored = pending;
      const layer = hatchStoreLayer({
        get: async () => stored,
        transaction: async (operation) =>
          operation({
            getHatch: async () => stored,
            getActorAuthority: async () => undefined,
            getRecord: async () => ({
              ...record,
              status: "booting",
              operation: {
                kind: "resume",
                nonce: "current-resume-nonce",
                startedAt: record.createdAt,
              },
            }),
            getRuntimeEpoch: async () => "current-resume-runtime",
            putHatch: async (state) => {
              stored = state;
            },
            deleteHatch: async () => undefined,
          }),
      });
      const result = yield* Effect.gen(function* () {
        const store = yield* HatchStore;
        return yield* Effect.result(
          store.beginCleanup(priorNonce, "sleeping", false, "runtime_start"),
        );
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        Option.map(Result.getFailure(result), (failure) => failure.reason),
        Option.some("lease_changed"),
      );
      assert.deepStrictEqual(stored, pending);
    }),
  );

  it("polls Hatch port health after Pi supervisor readiness during resume", async () => {
    let healthCalls = 0;
    const statuses = [200, 503, 200];
    const harness = await createSessionHarness({
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      piSessionRunning: true,
      containerFetch: makeHatchHealthContainerFetch(() => {
        healthCalls += 1;
        return statuses[healthCalls - 1] ?? 200;
      }),
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const service = {
      name: "docs",
      argv: ["npm", "run", "dev"],
      workingDirectory: `/workspace/${SESSION_ID}`,
      port: 4_173,
      healthPath: "/health",
      readyTimeoutSeconds: 60,
    } as const;
    const ensured = await harness.sandbox.ensureScottyHatch({ service });
    assert.strictEqual(ensured.status, "configured");

    await harness.sandbox.sleepScottySession();
    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    assert.strictEqual(healthCalls, 3);
    assert.strictEqual(harness.piHatchRestoreDescriptors.at(-1)?.service.readyTimeoutSeconds, 60);
    assert.include(harness.exposedPreviewPorts(), service.port);
    const hatch = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.strictEqual(hatch?.observedStatus, "running");
    assert.strictEqual(hatch?.exposure, "active");
  });

  it.effect("bounds permanent Hatch restore port health polling", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      const restoreHealthEntered = deferred<void>();
      let restoreStarted = false;
      let healthCalls = 0;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          previewBase: "preview.example.test",
          rawPiContainerRunning: true,
          piSessionRunning: true,
          containerFetch: makeHatchHealthContainerFetch(() => {
            healthCalls += 1;
            if (restoreStarted) restoreHealthEntered.resolve();
            return healthCalls === 1 ? 200 : 503;
          }),
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      const service = {
        name: "docs",
        argv: ["npm", "run", "dev"],
        workingDirectory: `/workspace/${SESSION_ID}`,
        port: 4_173,
        healthPath: "/health",
      } as const;
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      yield* Effect.promise(() => harness.sandbox.sleepScottySession());

      restoreStarted = true;
      const resume = harness.sandbox.resumeScottySession().then(
        (value) => value,
        (error: unknown) => error,
      );
      yield* Effect.promise(() => restoreHealthEntered.promise);
      yield* Effect.yieldNow;
      yield* clock.adjust("30 seconds");
      const result = yield* Effect.promise(() => resume);

      assert.isFalse(result instanceof ScottyError);
      assert.ok(typeof result === "object" && result !== null && "pending" in result);
      assert.strictEqual(result.pending, true);
      assert.isBelow(healthCalls, 200);
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
      const hatch = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
      assert.strictEqual(hatch?.observedStatus, "failed");
      assert.strictEqual(hatch?.exposure, "closed");
    }),
  );

  it("allows Hatch ensure and restore placement hydration while reconciliation fences a mismatch", async () => {
    const harness = await createSessionHarness({
      containerPlacementId: "placement-stale",
      containerPlacementIdAfterExpose: "placement-hydrated",
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
      healthPath: "/health",
    } as const;

    const ensured = await harness.sandbox.ensureScottyHatch({ service });
    assert.strictEqual(ensured.status, "configured");
    assert.strictEqual(
      harness.events.filter((event) => event === "host:preview:expose:4173").length,
      1,
    );

    await harness.sandbox.sleepScottySession();
    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    assert.strictEqual(
      harness.events.filter((event) => event === "host:preview:expose:4173").length,
      2,
    );
    const running = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.isDefined(running);
    assert.strictEqual(running?.observedStatus, "running");
    assert.strictEqual(running?.exposure, "active");

    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Warm"),
    );
    if (
      authority === undefined ||
      !Predicate.isTagged(authority.state, "Stable") ||
      !Predicate.isTagged(authority.state.stable, "Warm")
    )
      return;
    assert.strictEqual(
      authority.state.stable.readiness.runtime.containerIncarnation,
      "placement-stale",
    );
    assert.isUndefined(
      await harness.sandbox.getScottyHatchOpenRoute(),
      "reconciliation must reject the hydrated placement mismatch",
    );
  });

  it("re-exposes Hatch on the current runtime without reviving Evidence exposure", async () => {
    let activeHarness: SessionHarness | undefined;
    const forwardedHatchUrls: string[] = [];
    const harness = await createSessionHarness({
      evidenceEnabled: true,
      piSessionRunning: true,
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      hatchRequestForwarder: async (request) => {
        forwardedHatchUrls.push(request.url);
        const port = Number.parseInt(new URL(request.url).hostname.split("-")[0] ?? "", 10);
        return activeHarness?.exposedPreviewPorts().includes(port)
          ? new Response("hatch-app")
          : new Response("stale Hatch runtime", { status: 404 });
      },
    });
    activeHarness = harness;
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const service = {
      name: "docs",
      argv: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
      workingDirectory: `/workspace/${SESSION_ID}`,
      port: 4_173,
      healthPath: "/health",
    } as const;
    const ensured = await harness.sandbox.ensureScottyHatch({ service });
    assert.strictEqual(ensured.status, "configured");
    const activeEvidence = await harness.sandbox.acceptScottyEvidenceJob({
      port: 4_174,
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
    await harness.sandbox.exposeScottyEvidencePreview(activeEvidence.operationNonce);

    const initialRuntimeIdentity = harness.runtimeIdentity();
    const evidenceExposureCount = harness.events.filter(
      (event) => event === "host:preview:expose:4174",
    ).length;
    assert.include(harness.exposedPreviewPorts(), 4_173);
    assert.include(harness.exposedPreviewPorts(), 4_174);
    const route = await harness.sandbox.getScottyHatchOpenRoute();
    assert.isDefined(route);
    if (route === undefined) return;
    const beforeRestart = await fetchAuthorizedHatchRequest(harness, route);
    assert.strictEqual(beforeRestart.status, 200);
    assert.strictEqual(await beforeRestart.text(), "hatch-app");

    await harness.startRuntime();
    assert.notStrictEqual(harness.runtimeIdentity(), initialRuntimeIdentity);
    assert.deepStrictEqual(harness.exposedPreviewPorts(), []);

    const duringRestart = await fetchAuthorizedHatchRequest(harness, route);
    assert.strictEqual(duringRestart.status, 200);
    assert.strictEqual(await duringRestart.text(), "hatch-app");
    assert.deepStrictEqual(harness.exposedPreviewPorts(), [4_173]);
    assert.strictEqual(forwardedHatchUrls.length, 2);
    assert.deepStrictEqual(
      forwardedHatchUrls.map((url) => new URL(url).origin),
      [hatchOrigin(route, "preview.example.test"), hatchOrigin(route, "preview.example.test")],
    );

    await harness.drainBackground();
    assert.deepStrictEqual(harness.exposedPreviewPorts(), [4_173]);
    assert.include(harness.events, "host:preview:expose:4173");
    assert.strictEqual(
      harness.events.filter((event) => event === "host:preview:expose:4174").length,
      evidenceExposureCount,
    );
    const publicStatus = await harness.sandbox.getScottyHatchStatus();
    assert.strictEqual(publicStatus.status, "configured");
    if (publicStatus.status !== "configured") return;
    assert.strictEqual(publicStatus.observedStatus, "running");
    assert.strictEqual(publicStatus.exposure, "active");

    const hatch = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
    assert.isDefined(hatch);
    assert.strictEqual(hatch?.service.port, 4_173);
    assert.strictEqual(hatch?.observedStatus, "running");
    assert.strictEqual(hatch?.exposure, "active");
    await harness.sandbox.finalizeScottyEvidenceJob(activeEvidence.operationNonce, "interrupted");
    const exposureCountAfterRepair = harness.events.filter(
      (event) => event === "host:preview:expose:4173",
    ).length;
    const afterEvidence = await fetchAuthorizedHatchRequest(harness, route);
    assert.strictEqual(afterEvidence.status, 200);
    assert.strictEqual(await afterEvidence.text(), "hatch-app");
    assert.strictEqual(
      harness.events.filter((event) => event === "host:preview:expose:4173").length,
      exposureCountAfterRepair,
    );
  });

  it("keeps Hatch unavailable when the replacement runtime has no healthy service", async () => {
    const harness = await createSessionHarness({
      piSessionRunning: true,
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const ensured = await harness.sandbox.ensureScottyHatch({
      service: {
        name: "docs",
        argv: ["npm", "run", "dev"],
        workingDirectory: `/workspace/${SESSION_ID}`,
        port: 4_173,
        healthPath: "/health",
      },
    });
    assert.strictEqual(ensured.status, "configured");

    harness.injectFailure("hatchHealth");
    await harness.startRuntime();
    await harness.drainBackground();
    assert.deepStrictEqual(harness.exposedPreviewPorts(), []);

    assert.isUndefined(await harness.sandbox.getScottyHatchOpenRoute());
  });

  it("does not revive Hatch after the actor observes a replacement incarnation", async () => {
    const harness = await createSessionHarness({
      containerPlacementId: null,
      localE2E: true,
      piSessionRunning: true,
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
    });
    await harness.startRuntime();
    await harness.drainBackground();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const ensured = await harness.sandbox.ensureScottyHatch({
      service: {
        name: "docs",
        argv: ["npm", "run", "dev"],
        workingDirectory: `/workspace/${SESSION_ID}`,
        port: 4_173,
        healthPath: "/health",
      },
    });
    assert.strictEqual(ensured.status, "configured");
    assert.include(harness.exposedPreviewPorts(), 4_173);
    const before = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      before !== undefined &&
        Predicate.isTagged(before.state, "Stable") &&
        Predicate.isTagged(before.state.stable, "Warm"),
    );
    if (
      before === undefined ||
      !Predicate.isTagged(before.state, "Stable") ||
      !Predicate.isTagged(before.state.stable, "Warm")
    )
      return;
    const initialIncarnation = before.state.stable.readiness.runtime.containerIncarnation;

    await harness.startRuntime();
    await harness.drainBackground();

    const after = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      after !== undefined &&
        Predicate.isTagged(after.state, "Stable") &&
        Predicate.isTagged(after.state.stable, "Failed"),
    );
    if (
      after === undefined ||
      !Predicate.isTagged(after.state, "Stable") ||
      !Predicate.isTagged(after.state.stable, "Failed")
    )
      return;
    assert.strictEqual(after.state.stable.code, "runtime_replaced");
    assert.notStrictEqual(
      initialIncarnation,
      harness.read<{ readonly version: 1; readonly id: string }>(
        sessionHarnessKeys.localContainerIncarnation,
      )?.id,
    );
    assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
    assert.isUndefined(await harness.sandbox.getScottyHatchOpenRoute());
  });

  it.effect("does not reconcile lifecycle success after Hatch restore cleanup failed", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      const restoreHealthEntered = deferred<void>();
      let healthFails = false;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          previewBase: "preview.example.test",
          rawPiContainerRunning: true,
          piSessionRunning: true,
          containerFetch: makeHatchHealthContainerFetch(() => {
            if (healthFails) restoreHealthEntered.resolve();
            return healthFails ? 503 : 200;
          }),
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );
      yield* Effect.promise(() =>
        harness.sandbox.ensureScottyHatch({
          service: {
            name: "docs",
            argv: ["npm", "run", "dev"],
            workingDirectory: `/workspace/${SESSION_ID}`,
            port: 4_173,
            healthPath: "/health",
          },
        }),
      );
      healthFails = true;
      const checkpoint = harness.sandbox.checkpointScottySession().then(
        (value) => value,
        (error: unknown) => error,
      );
      yield* Effect.promise(() => restoreHealthEntered.promise);
      yield* Effect.yieldNow;
      yield* clock.adjust("30 seconds");
      const result = yield* Effect.promise(() => checkpoint);
      assert.isFalse(result instanceof ScottyError);
      assert.ok(typeof result === "object" && result !== null && "pending" in result);
      assert.strictEqual(result.pending, true);
      const failedHatch = harness.read<HatchState>(sessionHarnessKeys.hatch)?.primary;
      assert.strictEqual(failedHatch?.desiredStatus, "open");
      assert.strictEqual(failedHatch?.observedStatus, "failed");
      assert.strictEqual(failedHatch?.exposure, "closed");
      healthFails = false;
      const retry = harness.schedules
        .filter((schedule) => schedule.callback === "sessionActorDeadline")
        .at(-1);
      assert.isDefined(retry);

      yield* Effect.promise(() => harness.sandbox.sessionActorDeadline(retry.payload));

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
    }),
  );

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
