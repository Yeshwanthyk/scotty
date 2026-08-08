import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Predicate } from "effect";
import { TestClock } from "effect/testing";
import { sha256Hex } from "../src/digest";
import {
  HATCH_MAX_INGRESS_BYTES,
  HATCH_PRIVATE_CLAIMED_HEADER,
  HATCH_PRIVATE_REQUEST_HEADER,
  type HatchStateV1,
} from "../src/hatch-contracts";
import {
  createSessionHarness,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const service = {
  name: "docs",
  argv: ["npm", "run", "dev"] as const,
  workingDirectory: `/workspace/${SESSION_ID}`,
  port: 4_173,
  healthPath: "/health",
};

const createHarness = Effect.fnUntraced(function* (stopCallsOnStop = false) {
  yield* TestClock.setTime(NOW);
  const clock = yield* Clock.Clock;
  const harness = yield* Effect.promise(() =>
    createSessionHarness({
      clock,
      previewBase: "preview.example.test",
      rawPiContainerRunning: true,
      stopCallsOnStop,
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          hardCapAt: "2026-08-08T13:00:00.000Z",
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    }),
  );
  yield* Effect.promise(() => harness.startRuntime());
  return harness;
});

const hatchState = (
  harness: Awaited<ReturnType<typeof createSessionHarness>>,
): HatchStateV1 | undefined => harness.read<HatchStateV1>(sessionHarnessKeys.hatch);

describe("authoritative Hatch session lifecycle", () => {
  it.effect(
    "binds one primary Hatch to the current runtime epoch and persists only permit digests",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const opened = yield* Effect.promise(() =>
          harness.sandbox.ensureScottyHatch({ version: 1, service }),
        );
        assert.ok(opened.status === "configured");
        assert.strictEqual(opened.observedStatus, "running");
        assert.strictEqual(opened.exposure, "active");
        const current = hatchState(harness)?.primary;
        assert.ok(current);
        assert.strictEqual(current.runtimeEpoch, harness.read(sessionHarnessKeys.runtimeEpoch));
        assert.lengthOf(current.permits, 0);
        assert.lengthOf(current.requests, 0);

        const route = yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute());
        assert.ok(route);
        const cookieSecret = "c".repeat(64);
        const digest = yield* Effect.promise(() => sha256Hex(cookieSecret));
        const permit = yield* Effect.promise(() =>
          harness.sandbox.issueScottyHatchPermit(
            {
              sessionId: route.sessionId,
              port: route.port,
              routeNonce: route.routeNonce,
            },
            "111111111111",
            digest,
          ),
        );
        assert.ok(permit);
        const stored = hatchState(harness);
        assert.include(JSON.stringify(stored), digest);
        assert.notInclude(JSON.stringify(stored), cookieSecret);

        const admission = yield* Effect.promise(() =>
          harness.sandbox.admitScottyHatchRequest({
            sessionId: route.sessionId,
            port: route.port,
            routeNonce: route.routeNonce,
            cookieSecret,
            ingressBytes: 12,
          }),
        );
        assert.ok(admission);
        assert.isTrue(
          yield* Effect.promise(() =>
            harness.sandbox.adjustScottyHatchRequest(admission.requestId, 3),
          ),
        );
        yield* Effect.promise(() => harness.sandbox.cancelScottyHatchRequest(admission.requestId));
        assert.lengthOf(hatchState(harness)?.primary?.requests ?? [], 0);
        assert.strictEqual(hatchState(harness)?.primary?.permits[0]?.ingressBytes, 3);

        const reserved = [];
        for (let index = 0; index < 6; index += 1) {
          reserved.push(
            yield* Effect.promise(() =>
              harness.sandbox.admitScottyHatchRequest({
                sessionId: route.sessionId,
                port: route.port,
                routeNonce: route.routeNonce,
                cookieSecret,
                ingressBytes: HATCH_MAX_INGRESS_BYTES,
              }),
            ),
          );
        }
        assert.lengthOf(reserved.filter(Predicate.isNotUndefined), 5);
        assert.strictEqual(reserved[5], undefined);
        assert.lengthOf(hatchState(harness)?.primary?.requests ?? [], 5);
        yield* TestClock.adjust("31 seconds");
        const reclaimed = yield* Effect.promise(() =>
          harness.sandbox.admitScottyHatchRequest({
            sessionId: route.sessionId,
            port: route.port,
            routeNonce: route.routeNonce,
            cookieSecret,
            ingressBytes: HATCH_MAX_INGRESS_BYTES,
          }),
        );
        assert.ok(reclaimed);
        assert.lengthOf(hatchState(harness)?.primary?.requests ?? [], 1);
        yield* Effect.promise(() => harness.sandbox.cancelScottyHatchRequest(reclaimed.requestId));
        for (const candidate of reserved) {
          if (candidate !== undefined)
            yield* Effect.promise(() =>
              harness.sandbox.cancelScottyHatchRequest(candidate.requestId),
            );
        }
      }),
  );

  it.effect("claims and settles bounded HTTP through the owning Sandbox DO", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const clock = yield* Clock.Clock;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          previewBase: "preview.example.test",
          rawPiContainerRunning: true,
          hatchRequestForwarder: async () => new Response("hello"),
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
          },
        }),
      );
      yield* Effect.promise(() => harness.startRuntime());
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ version: 1, service }));
      const route = yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute());
      assert.ok(route);
      const cookieSecret = "d".repeat(64);
      const digest = yield* Effect.promise(() => sha256Hex(cookieSecret));
      assert.ok(
        yield* Effect.promise(() =>
          harness.sandbox.issueScottyHatchPermit(
            { sessionId: route.sessionId, port: route.port, routeNonce: route.routeNonce },
            "111111111111",
            digest,
          ),
        ),
      );
      const admitted = yield* Effect.promise(() =>
        harness.sandbox.admitScottyHatchRequest({
          sessionId: route.sessionId,
          port: route.port,
          routeNonce: route.routeNonce,
          cookieSecret,
          ingressBytes: 0,
        }),
      );
      assert.ok(admitted);
      assert.isTrue(
        yield* Effect.promise(() =>
          harness.sandbox.adjustScottyHatchRequest(admitted.requestId, 0),
        ),
      );
      const response = yield* Effect.promise(() =>
        harness.sandbox.fetch(
          new Request("https://preview.example.test/", {
            headers: {
              [HATCH_PRIVATE_REQUEST_HEADER]: admitted.requestId,
              "x-sandbox-preview-port": String(route.port),
              "x-sandbox-preview-proxy": "1",
              "x-sandbox-preview-sandbox-id": route.sessionId,
              "x-sandbox-preview-token": route.routeNonce,
            },
          }),
        ),
      );
      assert.strictEqual(response.headers.get(HATCH_PRIVATE_CLAIMED_HEADER), admitted.requestId);
      assert.strictEqual(yield* Effect.promise(() => response.text()), "hello");
      assert.lengthOf(hatchState(harness)?.primary?.requests ?? [], 0);
      assert.strictEqual(hatchState(harness)?.primary?.permits[0]?.responseBytes, 5);
    }),
  );

  it.effect("keeps evidence preview from reusing an active Hatch port", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const clock = yield* Clock.Clock;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          evidenceEnabled: true,
          previewBase: "preview.example.test",
          rawPiContainerRunning: true,
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
          },
        }),
      );
      yield* Effect.promise(() => harness.startRuntime());
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ version: 1, service }));
      const rejected = yield* Effect.promise(() =>
        harness.sandbox
          .acceptScottyEvidenceJob({
            version: 1,
            port: service.port,
            steps: [
              {
                name: "load",
                action: { kind: "goto", path: "/" },
                expect: [{ kind: "urlPath", expected: "/" }],
              },
            ],
          })
          .then(
            () => false,
            () => true,
          ),
      );
      assert.isTrue(rejected);
      assert.strictEqual(
        harness.events.filter((event) => event === "host:preview:expose:4173").length,
        1,
      );
      assert.strictEqual(hatchState(harness)?.primary?.exposure, "active");
    }),
  );

  it.effect("retains and completes close cleanup after unexpose fails", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ version: 1, service }));
      harness.injectFailure("previewUnexpose");
      const rejected = yield* Effect.promise(() =>
        harness.sandbox.closeScottyHatch().then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(rejected);
      const pending = hatchState(harness)?.primary;
      assert.strictEqual(pending?.desiredStatus, "closed");
      assert.strictEqual(pending?.exposure, "unexpose_pending");
      assert.lengthOf(pending?.permits ?? [], 0);
      const retry = harness.schedules.findLast(
        (schedule) => schedule.callback === "retryHatchCleanup",
      );
      assert.ok(retry);

      harness.clearFailure("previewUnexpose");
      yield* Effect.promise(() => harness.sandbox.retryHatchCleanup(retry.payload));
      const closed = hatchState(harness)?.primary;
      assert.strictEqual(closed?.observedStatus, "stopped");
      assert.strictEqual(closed?.exposure, "closed");
      assert.strictEqual(closed?.cleanup, undefined);
    }),
  );

  it.effect("rejects a stale exposure completion after the runtime epoch changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const clock = yield* Clock.Clock;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          previewBase: "preview.example.test",
          rawPiContainerRunning: true,
          rotateEpochAfterPreviewExpose: true,
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
          },
        }),
      );
      yield* Effect.promise(() => harness.startRuntime());
      const failed = yield* Effect.promise(() =>
        harness.sandbox.ensureScottyHatch({ version: 1, service }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      assert.ok(failed);
      const state = hatchState(harness)?.primary;
      assert.ok(state);
      assert.strictEqual(state.exposure, "closed");
      assert.notStrictEqual(state.observedStatus, "running");
      assert.lengthOf(state.permits, 0);
      assert.ok(harness.events.includes("host:preview:unexpose:4173"));
      assert.strictEqual(
        yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute()),
        undefined,
      );
    }),
  );

  it.effect("revokes the exact-host route on runtime stop and fences the next epoch", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ version: 1, service }));
      const first = hatchState(harness)?.primary;
      assert.ok(first);

      yield* Effect.promise(() => harness.stopRuntime());
      const sleeping = hatchState(harness)?.primary;
      assert.ok(sleeping);
      assert.strictEqual(sleeping.observedStatus, "sleeping");
      assert.strictEqual(sleeping.exposure, "closed");
      assert.strictEqual(sleeping.runtimeEpoch, undefined);
      assert.lengthOf(sleeping.permits, 0);
      assert.strictEqual(
        yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute()),
        undefined,
      );

      yield* Effect.promise(() => harness.startRuntime());
      assert.notStrictEqual(harness.read(sessionHarnessKeys.runtimeEpoch), first.runtimeEpoch);
      assert.strictEqual(
        yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute()),
        undefined,
      );
    }),
  );

  it.effect("reconciles stale exposure before publishing a replacement runtime epoch", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ version: 1, service }));
      const firstEpoch = harness.read(sessionHarnessKeys.runtimeEpoch);

      yield* Effect.promise(() => harness.startRuntime());

      assert.ok(harness.events.includes("host:preview:unexpose:4173"));
      assert.notStrictEqual(harness.read(sessionHarnessKeys.runtimeEpoch), firstEpoch);
      assert.strictEqual(hatchState(harness)?.primary?.observedStatus, "sleeping");
      assert.strictEqual(hatchState(harness)?.primary?.runtimeEpoch, undefined);
      assert.strictEqual(
        yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute()),
        undefined,
      );
    }),
  );

  it.effect("revokes Hatch before hard-cap checkpoint work", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness(true);
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ version: 1, service }));

      yield* Effect.promise(() =>
        harness.sandbox.enforceHardCap({ hardCapAt: "2026-08-08T13:00:00.000Z" }),
      );

      const unexpose = harness.events.indexOf("host:preview:unexpose:4173");
      const backup = harness.events.indexOf("host:createBackup");
      assert.ok(unexpose >= 0);
      assert.ok(backup > unexpose);
      assert.strictEqual(hatchState(harness)?.primary?.exposure, "closed");
      assert.lengthOf(hatchState(harness)?.primary?.permits ?? [], 0);
    }),
  );

  it.effect("unexposes before vaporize destroys the runtime and removes Hatch authority", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ version: 1, service }));

      yield* Effect.promise(() => harness.sandbox.vaporizeScottySession());

      const unexpose = harness.events.lastIndexOf("host:preview:unexpose:4173");
      const destroy = harness.events.indexOf("host:destroy");
      assert.ok(unexpose >= 0);
      assert.ok(destroy > unexpose);
      assert.strictEqual(hatchState(harness), undefined);
      assert.strictEqual(harness.readRecord()?.status, "gone");
    }),
  );
});
