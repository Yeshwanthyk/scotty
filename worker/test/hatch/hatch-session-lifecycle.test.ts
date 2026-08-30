import { assert, describe, it } from "@effect/vitest";
import { vi } from "vitest";
import { Clock, Effect, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import { sha256Hex } from "../../src/shared/digest";
import {
  HATCH_MAX_CONCURRENT_SOCKETS,
  HATCH_MAX_INGRESS_BYTES,
  HATCH_MAX_WEBSOCKET_MESSAGE_BYTES,
  HATCH_PRIVATE_CLAIMED_HEADER,
  HATCH_PRIVATE_REQUEST_HEADER,
  HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER,
  HATCH_PRIVATE_WEBSOCKET_HEADER,
  HATCH_MAX_PERMIT_BYTES,
  HATCH_RESERVED_RESPONSE_BYTES,
  decodeHatchStateResult,
  type HatchState,
} from "../../src/hatch/contracts";
import { createSessionHarness, SESSION_ID, sessionHarnessKeys } from "../support/session-harness";
import { makeSessionRecord } from "../support";

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
      piSessionRunning: true,
      rawPiContainerRunning: true,
      stopCallsOnStop,
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          hardCapAt: "2026-08-08T13:00:00.000Z",
        }),
      },
    }),
  );
  yield* Effect.promise(() => harness.startRuntime());
  return harness;
});

const hatchState = (
  harness: Awaited<ReturnType<typeof createSessionHarness>>,
): HatchState | undefined => harness.read<HatchState>(sessionHarnessKeys.hatch);

const persistedHatchState = () => ({
  primary: {
    hatchId: "hatch-primary",
    sessionId: SESSION_ID,
    generation: 2,
    service,
    desiredStatus: "open" as const,
    observedStatus: "running" as const,
    runtimeEpoch: "epoch-current",
    exposure: "active" as const,
    routeNonce: "h0123456789abcd",
    permits: [
      {
        permitId: "permit-primary",
        browserClientId: "111111111111",
        cookieDigest: "a".repeat(64),
        createdAt: "2026-08-08T12:00:00.000Z",
        expiresAt: "2026-08-08T13:00:00.000Z",
        ingressBytes: 0,
        responseBytes: 0,
      },
    ],
    requests: [
      {
        requestId: "1".repeat(32),
        permitId: "permit-primary",
        generation: 2,
        runtimeEpoch: "epoch-current",
        reservedIngressBytes: 100,
        ingressBytes: 100,
        reservedResponseBytes: HATCH_RESERVED_RESPONSE_BYTES,
        status: "admitted" as const,
        admittedAt: "2026-08-08T12:00:00.000Z",
        expiresAt: "2026-08-08T12:00:30.000Z",
      },
    ],
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    lastHealthyAt: "2026-08-08T12:00:00.000Z",
  },
});

const assertInvalidPersistedHatch = (state: unknown): void => {
  assert.isTrue(Result.isFailure(decodeHatchStateResult(state)));
};

describe("persisted Hatch schema invariants", () => {
  it("rejects request ingress greater than its reservation", () => {
    const state = persistedHatchState();
    state.primary.requests[0].ingressBytes = state.primary.requests[0].reservedIngressBytes + 1;
    assertInvalidPersistedHatch(state);
  });

  it("rejects a request generation that differs from its Hatch", () => {
    const generationMismatch = persistedHatchState();
    generationMismatch.primary.requests[0].generation = 1;
    assertInvalidPersistedHatch(generationMismatch);
  });

  it("rejects a request runtime epoch that differs from its Hatch", () => {
    const runtimeEpochMismatch = persistedHatchState();
    runtimeEpochMismatch.primary.requests[0].runtimeEpoch = "epoch-stale";
    assertInvalidPersistedHatch(runtimeEpochMismatch);
  });

  it("rejects a request expiry beyond its permit expiry", () => {
    const state = persistedHatchState();
    state.primary.requests[0].expiresAt = "2026-08-08T13:00:01.000Z";
    assertInvalidPersistedHatch(state);
  });

  it("rejects aggregate outstanding reservations beyond the permit budget", () => {
    const state = persistedHatchState();
    state.primary.requests = Array.from({ length: 6 }, (_, index) => ({
      ...state.primary.requests[0],
      requestId: `${String(index + 1).padStart(2, "0")}${"a".repeat(30)}`,
      reservedIngressBytes: HATCH_MAX_INGRESS_BYTES,
      ingressBytes: HATCH_MAX_INGRESS_BYTES,
    }));
    assert.isAbove(
      state.primary.requests.reduce(
        (total, request) => total + request.reservedIngressBytes + request.reservedResponseBytes,
        0,
      ),
      HATCH_MAX_PERMIT_BYTES,
    );
    assertInvalidPersistedHatch(state);
  });
});

class HarnessWebSocket extends EventTarget {
  peer: HarnessWebSocket | undefined;
  accepted = false;
  closed: { readonly code: number; readonly reason: string } | undefined;

  accept(): void {
    this.accepted = true;
  }

  send(data: string | ArrayBuffer): void {
    if (this.closed !== undefined || this.peer?.closed !== undefined) return;
    this.peer?.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(code = 1_000, reason = ""): void {
    if (this.closed !== undefined) return;
    this.closed = { code, reason };
    const peer = this.peer;
    if (peer !== undefined && peer.closed === undefined) peer.closed = { code, reason };
    const event = new Event("close");
    Object.defineProperties(event, { code: { value: code }, reason: { value: reason } });
    this.dispatchEvent(event);
    peer?.dispatchEvent(event);
  }
}

class HarnessWebSocketPair {
  readonly 0: HarnessWebSocket;
  readonly 1: HarnessWebSocket;

  constructor() {
    this[0] = new HarnessWebSocket();
    this[1] = new HarnessWebSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

const installWebSocketRuntime = (): (() => void) => {
  const NativeResponse = globalThis.Response;
  const NativeWebSocketPair = Reflect.get(globalThis, "WebSocketPair");
  class UpgradeResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const status = init?.status;
      super(body, status === 101 ? { ...init, status: 200 } : init);
      if (status === 101) Object.defineProperty(this, "status", { value: 101 });
      Object.defineProperty(this, "webSocket", {
        configurable: true,
        value: init?.webSocket ?? null,
      });
    }
  }
  Object.defineProperty(globalThis, "Response", { configurable: true, value: UpgradeResponse });
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    value: HarnessWebSocketPair,
  });
  return () => {
    Object.defineProperty(globalThis, "Response", { configurable: true, value: NativeResponse });
    Object.defineProperty(globalThis, "WebSocketPair", {
      configurable: true,
      value: NativeWebSocketPair,
    });
  };
};

const settleWebSocketForwarding = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const issueBrowserPermit = async (
  harness: Awaited<ReturnType<typeof createSessionHarness>>,
  cookieSecret: string,
) => {
  const route = await harness.sandbox.getScottyHatchOpenRoute();
  assert.ok(route);
  const digest = await sha256Hex(cookieSecret);
  const permit = await harness.sandbox.issueScottyHatchPermit(
    { sessionId: route.sessionId, port: route.port, routeNonce: route.routeNonce },
    "111111111111",
    digest,
  );
  assert.ok(permit);
  return route;
};

describe("authoritative Hatch session lifecycle", () => {
  it.effect(
    "binds one primary Hatch to the current runtime epoch and persists only permit digests",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const opened = yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
        assert.ok(opened.status === "configured");
        assert.strictEqual(opened.observedStatus, "running");
        assert.strictEqual(opened.exposure, "active");
        assert.isFalse(harness.events.some((event) => event.startsWith("host:hatch:start:")));
        const current = hatchState(harness)?.primary;
        assert.ok(current);
        assert.strictEqual(current.runtimeEpoch, harness.read(sessionHarnessKeys.runtimeEpoch));
        assert.lengthOf(current.permits, 0);
        assert.lengthOf(current.requests, 0);

        const route = yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute());
        assert.ok(route);
        assert.match(route.routeNonce, /^h[a-z0-9]{14}$/u);
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

  it.effect("rejects a different primary service without revoking the active Hatch", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      const original = hatchState(harness)?.primary;
      assert.ok(original);
      const rejected = yield* Effect.promise(() =>
        harness.sandbox
          .ensureScottyHatch({
            service: { ...service, name: "other", port: 5_173 },
          })
          .then(
            () => false,
            () => true,
          ),
      );
      assert.isTrue(rejected);
      const current = hatchState(harness)?.primary;
      assert.strictEqual(current?.hatchId, original.hatchId);
      assert.strictEqual(current?.generation, original.generation);
      assert.strictEqual(current?.exposure, "active");
      assert.strictEqual(
        harness.events.filter((event) => event.startsWith("host:preview:unexpose:")).length,
        0,
      );
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
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
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
      const consumedPermit = hatchState(harness)?.primary?.permits[0];
      assert.strictEqual(consumedPermit?.responseBytes, 5);
      assert.ok(
        yield* Effect.promise(() =>
          harness.sandbox.issueScottyHatchPermit(
            { sessionId: route.sessionId, port: route.port, routeNonce: route.routeNonce },
            "111111111111",
            "f".repeat(64),
          ),
        ),
      );
      const rotatedPermit = hatchState(harness)?.primary?.permits[0];
      assert.strictEqual(rotatedPermit?.responseBytes, 5);
      assert.strictEqual(rotatedPermit?.expiresAt, consumedPermit?.expiresAt);
    }),
  );

  it.effect("retains and completes close cleanup after unexpose fails", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
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

  it.effect("does not let re-ensure overwrite pending unexpose cleanup", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      harness.injectFailure("previewUnexpose");

      const closed = yield* Effect.promise(() =>
        harness.sandbox.closeScottyHatch().then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(closed);
      const pending = hatchState(harness)?.primary;
      assert.ok(pending);
      assert.strictEqual(pending.exposure, "unexpose_pending");
      assert.strictEqual(pending.desiredStatus, "closed");
      assert.strictEqual(pending.cleanup?.target, "stopped");

      const reensured = yield* Effect.promise(() =>
        harness.sandbox.ensureScottyHatch({ service }).then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(reensured);
      const stillPending = hatchState(harness)?.primary;
      assert.ok(stillPending);
      assert.strictEqual(stillPending.generation, pending.generation);
      assert.strictEqual(stillPending.exposure, "unexpose_pending");
      assert.strictEqual(stillPending.cleanup?.operationNonce, pending.cleanup?.operationNonce);
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
        harness.sandbox.ensureScottyHatch({ service }).then(
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

  it.effect("does not let a stale health failure clean a newer Hatch generation", () =>
    Effect.gen(function* () {
      let releaseHealth: () => void = () => undefined;
      const healthGate = new Promise<void>((resolve) => {
        releaseHealth = resolve;
      });
      yield* TestClock.setTime(NOW);
      const clock = yield* Clock.Clock;
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          clock,
          previewBase: "preview.example.test",
          piSessionRunning: true,
          rawPiContainerRunning: true,
          hatchHealthGate: healthGate,
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord({
              id: SESSION_ID,
              hardCapAt: "2026-08-08T13:00:00.000Z",
            }),
            [sessionHarnessKeys.hatch]: persistedHatchState(),
            [sessionHarnessKeys.runtimeEpoch]: "epoch-current",
          },
        }),
      );
      const staleStatus = harness.sandbox.getScottyHatchStatus();
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.include(harness.events, "host:hatch:health:4173:/health")),
      );
      const before = hatchState(harness)?.primary;
      assert.ok(before);

      const snapshot = yield* Effect.promise(() => harness.sandbox.snapshotScottySession());
      assert.strictEqual(snapshot.status, "warm");
      const newer = hatchState(harness)?.primary;
      assert.ok(newer);
      assert.ok(newer.generation > before.generation);
      assert.strictEqual(newer.exposure, "active");

      harness.injectFailure("hatchHealth");
      releaseHealth();
      const stale = yield* Effect.promise(() => staleStatus);
      assert.strictEqual(stale.status, "configured");
      assert.deepInclude(stale, { exposure: "active" });
      assert.strictEqual(hatchState(harness)?.primary?.generation, newer.generation);
      assert.strictEqual(hatchState(harness)?.primary?.exposure, "active");
    }),
  );

  it.effect("revokes the exact-host route on runtime stop and fences the next epoch", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      const first = hatchState(harness)?.primary;
      assert.ok(first);

      yield* Effect.promise(() => harness.stopRuntime());
      const failed = hatchState(harness)?.primary;
      assert.ok(failed);
      assert.strictEqual(failed.observedStatus, "failed");
      assert.strictEqual(failed.exposure, "closed");
      assert.strictEqual(failed.runtimeEpoch, undefined);
      assert.lengthOf(failed.permits, 0);
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
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      const firstEpoch = harness.read(sessionHarnessKeys.runtimeEpoch);

      yield* Effect.promise(() => harness.startRuntime());

      assert.ok(harness.events.includes("host:preview:unexpose:4173"));
      assert.notStrictEqual(harness.read(sessionHarnessKeys.runtimeEpoch), firstEpoch);
      assert.strictEqual(hatchState(harness)?.primary?.observedStatus, "failed");
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
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));

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

  it.effect("restores the exact managed service after snapshot with a fenced generation", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      const before = hatchState(harness)?.primary;
      assert.ok(before);

      const snapshot = yield* Effect.promise(() => harness.sandbox.snapshotScottySession());
      assert.strictEqual(snapshot.status, "warm");
      const restored = hatchState(harness)?.primary;
      assert.ok(restored);
      assert.strictEqual(restored.desiredStatus, "open");
      assert.strictEqual(restored.observedStatus, "running");
      assert.strictEqual(restored.exposure, "active");
      assert.ok(restored.generation > before.generation);
      assert.deepStrictEqual(restored.service, before.service);

      const unexpose = harness.events.indexOf("host:preview:unexpose:4173");
      const quiesce = harness.events.indexOf("host:pi:fetch:43117:/quiesce");
      const extensionShutdown = harness.events.indexOf("host:hatch:extension-shutdown");
      const restoredByExtension = harness.events.findIndex((event) =>
        event.startsWith(
          `host:hatch:extension-restore:${restored.hatchId}:${restored.generation}:`,
        ),
      );
      const healthy = harness.events.lastIndexOf("host:hatch:health:4173:/health");
      const reexposed = harness.events.lastIndexOf("host:preview:expose:4173");
      assert.ok(unexpose >= 0);
      assert.ok(quiesce > unexpose);
      assert.ok(extensionShutdown > quiesce);
      assert.ok(restoredByExtension > extensionShutdown);
      assert.ok(healthy > restoredByExtension);
      assert.ok(reexposed > healthy);
      assert.isFalse(harness.events.some((event) => event.startsWith("host:hatch:start:")));
    }),
  );

  it.effect("records managed sleep only after stop and restores on a new runtime epoch", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness(true);
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      const before = hatchState(harness)?.primary;
      assert.ok(before);

      const slept = yield* Effect.promise(() => harness.sandbox.sleepScottySession());
      assert.strictEqual(slept.status, "sleeping");
      const sleeping = hatchState(harness)?.primary;
      assert.ok(sleeping);
      assert.strictEqual(sleeping.desiredStatus, "open");
      assert.strictEqual(sleeping.observedStatus, "sleeping");
      assert.strictEqual(sleeping.exposure, "closed");
      assert.strictEqual(sleeping.runtimeEpoch, undefined);
      const stopped = harness.events.indexOf("host:stop");
      const sleepingCommit = harness.events.lastIndexOf("record:sleeping");
      assert.ok(stopped >= 0);
      assert.ok(sleepingCommit > stopped);

      yield* Effect.promise(() => harness.startRuntime());
      const epoch = harness.read<string>(sessionHarnessKeys.runtimeEpoch);
      assert.ok(epoch);
      assert.notStrictEqual(epoch, before.runtimeEpoch);
      const resumed = yield* Effect.promise(() => harness.sandbox.resumeScottySession());
      assert.strictEqual(resumed.status, "warm");
      const restored = hatchState(harness)?.primary;
      assert.ok(restored);
      assert.strictEqual(restored.observedStatus, "running");
      assert.strictEqual(restored.exposure, "active");
      assert.strictEqual(restored.runtimeEpoch, epoch);
      assert.ok(restored.generation > sleeping.generation);
      assert.deepStrictEqual(restored.service, before.service);
      const restoredByExtension = harness.events.findLastIndex((event) =>
        event.startsWith(
          `host:hatch:extension-restore:${restored.hatchId}:${restored.generation}:`,
        ),
      );
      const healthy = harness.events.lastIndexOf("host:hatch:health:4173:/health");
      const exposed = harness.events.lastIndexOf("host:preview:expose:4173");
      assert.ok(restoredByExtension >= 0);
      assert.ok(healthy > restoredByExtension);
      assert.ok(exposed > healthy);
      assert.isFalse(harness.events.some((event) => event.startsWith("host:hatch:start:")));
    }),
  );

  it.effect("fails closed when managed restoration cannot make the exact service healthy", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness(true);
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      yield* Effect.promise(() => harness.sandbox.sleepScottySession());
      yield* Effect.promise(() => harness.startRuntime());
      harness.injectFailure("hatchHealth");

      const rejected = yield* Effect.promise(() =>
        harness.sandbox.resumeScottySession().then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(rejected);
      assert.strictEqual(harness.readRecord()?.status, "failed");
      const failed = hatchState(harness)?.primary;
      assert.ok(failed);
      assert.strictEqual(failed.desiredStatus, "open");
      assert.strictEqual(failed.observedStatus, "failed");
      assert.strictEqual(failed.exposure, "closed");
      assert.strictEqual(
        yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute()),
        undefined,
      );
    }),
  );

  it.effect("revokes access and renders unhealthy after an unexpected application stop", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
      yield* Effect.promise(() => harness.sandbox.snapshotScottySession());
      const generation = hatchState(harness)?.primary?.generation;
      assert.ok(generation);
      harness.stopHatchProcess(generation);

      const status = yield* Effect.promise(() => harness.sandbox.getScottyHatchStatus());
      assert.ok(status.status === "configured");
      assert.strictEqual(status.observedStatus, "unhealthy");
      assert.strictEqual(
        yield* Effect.promise(() => harness.sandbox.getScottyHatchOpenRoute()),
        undefined,
      );
      const failed = hatchState(harness)?.primary;
      assert.ok(failed);
      assert.strictEqual(failed.desiredStatus, "open");
      assert.strictEqual(failed.observedStatus, "unhealthy");
      assert.strictEqual(failed.exposure, "closed");
    }),
  );

  it.effect("bounds WebSocket admission and closes tracked sockets without extending permits", () =>
    Effect.gen(function* () {
      const restoreRuntime = installWebSocketRuntime();
      const servicePairs = [new HarnessWebSocketPair(), new HarnessWebSocketPair()];
      let forwardedSockets = 0;
      try {
        const harness = yield* createHarness();
        // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: align the deterministic authority clock with the native WebSocket admission clock
        yield* TestClock.setTime(Date.now());
        Reflect.set(harness.sandbox, "hatchRequestForwarder", async () => {
          const pair = servicePairs[forwardedSockets];
          forwardedSockets += 1;
          assert.ok(pair);
          return new Response(null, {
            status: 101,
            // lint-allow-double-cast: boundary: focused test mock supplies the native Worker WebSocket host surface
            webSocket: pair[0] as unknown as WebSocket,
            headers: { "sec-websocket-protocol": "vite-hmr" },
          });
        });
        yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));
        const cookieSecret = "e".repeat(64);
        const route = yield* Effect.promise(() => issueBrowserPermit(harness, cookieSecret));
        const host = `${route.port}-${route.sessionId}-${route.routeNonce}.preview.example.test`;
        const admission = {
          sessionId: route.sessionId,
          port: route.port,
          routeNonce: route.routeNonce,
          host,
          origin: `https://${host}`,
          cookieSecret,
        };
        assert.strictEqual(
          yield* Effect.promise(() =>
            harness.sandbox.admitScottyHatchWebSocket({
              ...admission,
              origin: "https://attacker.example",
            }),
          ),
          undefined,
        );
        const permits = [];
        for (let index = 0; index < HATCH_MAX_CONCURRENT_SOCKETS; index += 1) {
          const permit = yield* Effect.promise(() =>
            harness.sandbox.admitScottyHatchWebSocket(admission),
          );
          assert.ok(permit);
          permits.push(permit);
        }
        assert.strictEqual(
          yield* Effect.promise(() => harness.sandbox.admitScottyHatchWebSocket(admission)),
          undefined,
        );
        for (const permit of permits.slice(2))
          yield* Effect.promise(() => harness.sandbox.cancelScottyHatchWebSocket(permit.socketId));

        const permitExpiry = hatchState(harness)?.primary?.permits[0]?.expiresAt;
        const active = permits[0];
        assert.ok(active);
        const admissions = Reflect.get(harness.sandbox, "hatchWebSocketAdmissions") as Map<
          string,
          { readonly expiresAtMillis: number }
        >;
        const pending = admissions.get(active.socketId);
        assert.ok(pending);
        // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: verifies the native upgrade deadline used by Sandbox.fetch
        assert.ok(pending.expiresAtMillis > Date.now());
        const internalRequest = new Request(`https://${host}/hmr`, {
          headers: {
            [HATCH_PRIVATE_WEBSOCKET_HEADER]: active.socketId,
            "x-sandbox-preview-port": String(route.port),
            "x-sandbox-preview-proxy": "1",
            "x-sandbox-preview-sandbox-id": route.sessionId,
            "x-sandbox-preview-token": route.routeNonce,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-protocol": "vite-hmr",
          },
        });
        const parseForwardingRoute = Reflect.get(
          harness.sandbox,
          "hatchWebSocketForwardingRoute",
        ) as (request: Request) => unknown;
        assert.ok(parseForwardingRoute(internalRequest));
        const response = yield* Effect.promise(() => harness.sandbox.fetch(internalRequest));
        assert.strictEqual(forwardedSockets, 1);
        assert.strictEqual(response.status, 101);
        assert.strictEqual(
          response.headers.get(HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER),
          active.socketId,
        );
        // lint-allow-double-cast: boundary: focused test recovers its native Worker WebSocket mock
        const client = response.webSocket as unknown as HarnessWebSocket;
        client.accept();
        let forwarded: unknown;
        servicePairs[0]?.[1].addEventListener("message", (event) => {
          forwarded = (event as MessageEvent).data;
        });
        client.send("hmr-ping");
        yield* Effect.promise(settleWebSocketForwarding);
        assert.strictEqual(forwarded, "hmr-ping");
        assert.strictEqual(hatchState(harness)?.primary?.permits[0]?.expiresAt, permitExpiry);

        client.send("x".repeat(HATCH_MAX_WEBSOCKET_MESSAGE_BYTES + 1));
        yield* Effect.promise(settleWebSocketForwarding);
        assert.strictEqual(client.closed?.code, 1_009);

        const second = permits[1];
        assert.ok(second);
        const secondResponse = yield* Effect.promise(() =>
          harness.sandbox.fetch(
            new Request(`https://${host}/hmr`, {
              headers: {
                [HATCH_PRIVATE_WEBSOCKET_HEADER]: second.socketId,
                "x-sandbox-preview-port": String(route.port),
                "x-sandbox-preview-proxy": "1",
                "x-sandbox-preview-sandbox-id": route.sessionId,
                "x-sandbox-preview-token": route.routeNonce,
                connection: "Upgrade",
                upgrade: "websocket",
              },
            }),
          ),
        );
        // lint-allow-double-cast: boundary: focused test recovers its native Worker WebSocket mock
        const secondClient = secondResponse.webSocket as unknown as HarnessWebSocket;
        secondClient.accept();
        yield* Effect.promise(() => harness.sandbox.closeScottyHatch());
        assert.strictEqual(secondClient.closed?.code, 1_001);
        assert.strictEqual(hatchState(harness)?.primary?.exposure, "closed");
      } finally {
        restoreRuntime();
      }
    }),
  );

  it.effect("unexposes before vaporize destroys the runtime and removes Hatch authority", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.sandbox.ensureScottyHatch({ service }));

      yield* Effect.promise(() => harness.sandbox.vaporizeScottySession());

      const unexpose = harness.events.lastIndexOf("host:preview:unexpose:4173");
      const destroy = harness.events.indexOf("host:destroy");
      assert.ok(unexpose >= 0);
      assert.ok(destroy > unexpose);
      assert.strictEqual(hatchState(harness), undefined);
      assert.strictEqual(harness.readRecord()?.status, "gone");
    }),
  );

  it.effect("settles Hatch cleanup during vaporize when the runtime is already absent", () =>
    Effect.gen(function* () {
      const running = yield* createHarness();
      yield* Effect.promise(() => running.sandbox.ensureScottyHatch({ service }));
      const activeHatch = hatchState(running);
      assert.ok(activeHatch?.primary?.exposure === "active");

      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          previewBase: "preview.example.test",
          rawPiContainerRunning: false,
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
            [sessionHarnessKeys.hatch]: activeHatch,
          },
          initialProjections: {
            [`session:${SESSION_ID}`]: { id: SESSION_ID, status: "warm" },
          },
        }),
      );

      const result = yield* Effect.promise(() => harness.sandbox.vaporizeScottySession());

      assert.deepStrictEqual(result, { id: SESSION_ID, status: "gone" });
      assert.ok(!harness.events.includes("host:preview:unexpose:4173"));
      assert.ok(!harness.events.includes("host:destroy"));
      assert.strictEqual(hatchState(harness), undefined);
      assert.strictEqual(harness.readRecord()?.status, "gone");
    }),
  );

  it.effect("removes an unreadable legacy Hatch record under the vaporize lease", () =>
    Effect.gen(function* () {
      const running = yield* createHarness();
      yield* Effect.promise(() => running.sandbox.ensureScottyHatch({ service }));
      const activeHatch = hatchState(running);
      assert.ok(activeHatch?.primary !== undefined);
      const legacyHatch = {
        primary: { ...activeHatch.primary, routeNonce: "legacy-hyphen" },
      };

      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          previewBase: "preview.example.test",
          rawPiContainerRunning: false,
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
            [sessionHarnessKeys.hatch]: legacyHatch,
          },
          initialProjections: {
            [`session:${SESSION_ID}`]: { id: SESSION_ID, status: "warm" },
          },
        }),
      );

      const result = yield* Effect.promise(() => harness.sandbox.vaporizeScottySession());

      assert.deepStrictEqual(result, { id: SESSION_ID, status: "gone" });
      assert.strictEqual(harness.read(sessionHarnessKeys.hatch), undefined);
      assert.strictEqual(harness.readRecord()?.status, "gone");
    }),
  );
});
