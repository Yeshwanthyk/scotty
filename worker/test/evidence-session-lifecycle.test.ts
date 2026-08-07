import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER,
  EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER,
  EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
  type EvidenceStateV1,
} from "../src/evidence-contracts";
import { sha256Hex } from "../src/digest";
import { KitesurfClient } from "../src/kitesurf-client";
import {
  createSessionHarness,
  injectedHarnessFailure,
  SESSION_ID,
  sessionHarnessKeys,
  type HarnessOptions,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);

const createHarness = (options: Omit<HarnessOptions, "clock" | "initialEntries"> = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const clock = yield* Clock.Clock;
    return yield* Effect.promise(() =>
      createSessionHarness({
        evidenceEnabled: true,
        ...options,
        clock,
        initialEntries: {
          [sessionHarnessKeys.record]: makeSessionRecord({
            id: SESSION_ID,
            hardCapAt: "2026-08-06T13:00:00.000Z",
          }),
        },
      }),
    );
  });

const previewForwardingRequest = (
  requestId: string,
  routeNonce: string,
  signal?: AbortSignal,
  extraHeaders: Readonly<Record<string, string>> = {},
): Request =>
  new Request(`https://4173-${SESSION_ID}-${routeNonce}.preview.scotty.example/`, {
    headers: {
      [EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER]: requestId,
      "x-sandbox-preview-proxy": "1",
      "x-sandbox-preview-port": "4173",
      "x-sandbox-preview-sandbox-id": SESSION_ID,
      "x-sandbox-preview-token": routeNonce,
      ...extraHeaders,
    },
    signal,
  });

const job = {
  version: 1,
  port: 4_173,
  capture: { screenshots: "after-each-step", replay: true },
  steps: [
    {
      name: "Open the app",
      action: { kind: "goto", path: "/" },
      expect: [{ kind: "urlPath", expected: "/" }],
    },
  ],
} as const;

describe("evidence session lifecycle", () => {
  it.effect(
    "runs one accepted job through the scoped RPC and existing artifact publication path",
    () =>
      Effect.gen(function* () {
        const browserEvents: Array<string> = [];
        const kitesurfClient = KitesurfClient.of({
          withPage: (_options, use) =>
            Effect.acquireUseRelease(
              Effect.sync(() => browserEvents.push("browser:open")),
              () =>
                use({
                  goto: () => Effect.void,
                  click: () => Effect.void,
                  fill: () => Effect.void,
                  press: () => Effect.void,
                  isVisible: () => Effect.succeed(true),
                  textContent: () => Effect.succeed("Ready"),
                  count: () => Effect.succeed(1),
                  urlPath: Effect.succeed("/"),
                  screenshot: Effect.succeed(PNG),
                }),
              () => Effect.sync(() => browserEvents.push("browser:close")),
            ),
        });
        const harness = yield* createHarness({
          kitesurfClient,
          previewBase: "preview.scotty.example",
        });
        yield* Effect.promise(() => harness.startRuntime());

        const result = yield* Effect.promise(() => harness.sandbox.runScottyEvidenceJob(job));

        assert.strictEqual(result.status, "succeeded");
        assert.strictEqual(result.completedSteps, 1);
        assert.strictEqual(result.frameCount, 1);
        assert.match(result.summaryUrl, new RegExp(`^/s/${SESSION_ID}/evidence/job-`, "u"));
        assert.deepStrictEqual(browserEvents, ["browser:open", "browser:close"]);
        assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
        assert.lengthOf(harness.artifactKeys(), 1);
        const state = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence);
        assert.strictEqual(state?.activeJob, undefined);
        assert.strictEqual(state?.jobs[0]?.status, "succeeded");
        assert.strictEqual(state?.jobs[0]?.frameCount, 1);
        assert.strictEqual(harness.readRecord()?.operation, null);
      }),
  );

  it.effect("fails an invalid screenshot without publishing an artifact", () =>
    Effect.gen(function* () {
      const kitesurfClient = KitesurfClient.of({
        withPage: (_options, use) =>
          use({
            goto: () => Effect.void,
            click: () => Effect.void,
            fill: () => Effect.void,
            press: () => Effect.void,
            isVisible: () => Effect.succeed(true),
            textContent: () => Effect.succeed("Ready"),
            count: () => Effect.succeed(1),
            urlPath: Effect.succeed("/"),
            screenshot: Effect.succeed(Uint8Array.from([0, 1, 2, 3])),
          }),
      });
      const harness = yield* createHarness({
        kitesurfClient,
        previewBase: "preview.scotty.example",
      });
      yield* Effect.promise(() => harness.startRuntime());

      const result = yield* Effect.promise(() => harness.sandbox.runScottyEvidenceJob(job));

      assert.strictEqual(result.status, "failed");
      assert.deepStrictEqual(result.failure, { code: "artifact_invalid", step: 0 });
      assert.strictEqual(result.completedSteps, 0);
      assert.strictEqual(result.frameCount, 0);
      assert.deepStrictEqual(harness.artifactKeys(), []);
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
      assert.strictEqual(harness.readRecord()?.operation, null);
    }),
  );

  it.effect("keeps acceptance, exposure, and authorization disabled without the gate", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ evidenceEnabled: false });
      yield* Effect.promise(() => harness.startRuntime());
      const acceptance = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.acceptScottyEvidenceJob(job),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(acceptance));
      const exposure = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.exposeScottyEvidencePreview("valid-nonce"),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(exposure));
      assert.strictEqual(
        yield* Effect.promise(() =>
          harness.sandbox.admitScottyEvidencePreview({
            sessionId: SESSION_ID,
            port: job.port,
            routeNonce: "valid_route_0001",
            cookieSecret: "a".repeat(64),
            ingressBytes: 0,
          }),
        ),
        undefined,
      );
    }),
  );

  it.effect("preserves the pre-evidence lifecycle exactly when the gate is disabled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const clock = yield* Clock.Clock;
      const malformedEvidence = { version: 1, activeJob: "malformed" };
      const malformedRuntimeEpoch = { epoch: "malformed" };
      const harness = yield* Effect.promise(() =>
        createSessionHarness({
          evidenceEnabled: false,
          failureStage: "runtimeEpochPut",
          clock,
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord({
              id: SESSION_ID,
              hardCapAt: "2026-08-06T13:00:00.000Z",
            }),
            [sessionHarnessKeys.evidence]: malformedEvidence,
            [sessionHarnessKeys.runtimeEpoch]: malformedRuntimeEpoch,
          },
          onStorageGet: (key) => {
            if (key === sessionHarnessKeys.evidence || key === sessionHarnessKeys.runtimeEpoch)
              throw injectedHarnessFailure(`disabled lifecycle read ${key}`);
          },
        }),
      );
      harness.injectFailure("runtimeEpochDelete");

      yield* Effect.promise(() => harness.startRuntime());
      yield* Effect.promise(() => harness.stopRuntime());

      assert.deepStrictEqual(harness.read(sessionHarnessKeys.evidence), malformedEvidence);
      assert.deepStrictEqual(harness.read(sessionHarnessKeys.runtimeEpoch), malformedRuntimeEpoch);
      assert.deepInclude(harness.readRecord(), {
        status: "failed",
        failure: {
          code: "runtime_stopped",
          message: "Sandbox runtime stopped before a managed checkpoint",
          recoverable: false,
        },
      });
      assert.notInclude(harness.events, `storage:delete:${sessionHarnessKeys.runtimeEpoch}`);
      assert.notInclude(harness.events, `storage:put:${sessionHarnessKeys.runtimeEpoch}`);
      assert.notInclude(harness.events, `storage:put:${sessionHarnessKeys.evidence}`);
    }),
  );

  it.effect("decodes, acquires, schedules, and expires one evidence job", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      assert.strictEqual(accepted.status, "accepted");
      assert.strictEqual(harness.readRecord()?.operation?.kind, "evidence");
      assert.deepInclude(harness.schedules[0], {
        callback: "expireEvidenceJob",
        payload: { nonce: accepted.operationNonce, deadlineAt: accepted.deadlineAt },
      });

      yield* Effect.promise(() =>
        harness.sandbox.expireEvidenceJob({
          nonce: accepted.operationNonce,
          deadlineAt: accepted.deadlineAt,
        }),
      );
      const state = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence);
      assert.strictEqual(state?.activeJob, undefined);
      assert.deepInclude(state?.jobs[0], {
        jobId: accepted.jobId,
        status: "interrupted",
        failure: { code: "deadline" },
      });
      assert.strictEqual(harness.readRecord()?.operation, null);
    }),
  );

  it.effect("retains vaporize retry authority until artifact absence is proved", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      yield* Effect.promise(() =>
        harness.sandbox.completeScottyEvidenceStep(accepted.operationNonce, {
          index: 0,
          startedAt: "2026-08-06T12:00:00.100Z",
          completedAt: "2026-08-06T12:00:01.000Z",
          offsetMillis: 1_000,
          assertions: [{ kind: "urlPath", passed: true, expected: "/", actual: "/" }],
          frame: {
            frameId: "frame-1",
            bytes: PNG,
            capturedAt: "2026-08-06T12:00:01.000Z",
            offsetMillis: 1_000,
          },
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.finalizeScottyEvidenceJob(accepted.operationNonce, "succeeded"),
      );
      harness.injectFailure("artifactDelete");

      const failed = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.vaporizeScottySession(),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(failed));
      const nonce = harness.readRecord()?.operation?.nonce;
      assert.strictEqual(harness.readRecord()?.operation?.kind, "vaporize");
      assert.ok(nonce !== undefined);
      const pending = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence);
      assert.deepInclude(pending?.artifacts[0], { status: "delete_pending" });
      assert.deepInclude(pending?.pendingDeletes[0], { reason: "vaporize" });
      assert.strictEqual(harness.artifactKeys().length, 1);

      harness.clearFailure("artifactDelete");
      yield* Effect.promise(() => harness.sandbox.retryVaporizeSession({ id: SESSION_ID, nonce }));
      assert.strictEqual(harness.readRecord()?.status, "gone");
      assert.strictEqual(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence), undefined);
      assert.deepStrictEqual(harness.artifactKeys(), []);
    }),
  );

  it.effect("lets vaporize revoke permits and unexpose before destroying owned state", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      assert.ok(
        (yield* Effect.promise(() =>
          harness.sandbox.admitScottyEvidencePreview({
            sessionId: SESSION_ID,
            port: job.port,
            routeNonce: accepted.routeNonce,
            cookieSecret: exposed.cookieSecret,
            ingressBytes: 0,
          }),
        )) !== undefined,
      );
      const eventStart = harness.events.length;
      const gone = yield* Effect.promise(() => harness.sandbox.vaporizeScottySession());
      const cleanupEvents = harness.events.slice(eventStart);
      assert.deepStrictEqual(gone, { id: SESSION_ID, status: "gone" });
      assert.strictEqual(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence), undefined);
      assert.include(harness.deletedSchedules, "expireEvidenceJob");
      assert.isBelow(
        cleanupEvents.indexOf(`storage:put:${sessionHarnessKeys.evidence}`),
        cleanupEvents.indexOf(`host:preview:unexpose:${job.port}`),
      );
      assert.isBelow(
        cleanupEvents.indexOf(`host:preview:unexpose:${job.port}`),
        cleanupEvents.indexOf("host:destroy"),
      );
    }),
  );

  it.effect("accepts only a warm running session with a lifecycle-owned runtime epoch", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const unavailable = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.acceptScottyEvidenceJob(job),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(unavailable));
      assert.strictEqual(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence), undefined);

      yield* Effect.promise(() => harness.startRuntime());
      const runtimeEpoch = harness.read<string>(sessionHarnessKeys.runtimeEpoch);
      assert.match(runtimeEpoch ?? "", /^[0-9a-f]{32}$/u);
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      assert.strictEqual(accepted.runtimeEpoch, runtimeEpoch);
      assert.strictEqual(accepted.previewCookieDigest, null);
    }),
  );

  it.effect("recovers a persisted running epoch in a replacement DO instance", () =>
    Effect.gen(function* () {
      const original = yield* createHarness();
      yield* Effect.promise(() => original.startRuntime());
      const runtimeEpoch = original.read<string>(sessionHarnessKeys.runtimeEpoch);
      assert.match(runtimeEpoch ?? "", /^[0-9a-f]{32}$/u);
      const clock = yield* Clock.Clock;
      const replacement = yield* Effect.promise(() =>
        createSessionHarness({
          evidenceEnabled: true,
          clock,
          rawPiContainerRunning: true,
          sharedMemory: original.memory,
        }),
      );

      const accepted = yield* Effect.promise(() =>
        replacement.sandbox.acceptScottyEvidenceJob(job),
      );
      assert.strictEqual(accepted.runtimeEpoch, runtimeEpoch);
      assert.strictEqual(replacement.read<string>(sessionHarnessKeys.runtimeEpoch), runtimeEpoch);
    }),
  );

  it.effect("does not expose after the evidence deadline or session hard cap", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      yield* TestClock.setTime(Date.parse("2026-08-06T13:00:00.000Z"));
      const exposed = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(exposed));
      assert.notInclude(harness.events, `host:preview:expose:${job.port}`);
      assert.deepInclude(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob, {
        exposure: "not_exposed",
        previewCookieDigest: null,
      });
    }),
  );

  it.effect(
    "publishes only the cookie digest and rejects authorization after an epoch rotation",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
        yield* Effect.promise(() => harness.startRuntime());
        const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
        const exposed = yield* Effect.promise(() =>
          harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
        );
        assert.strictEqual(
          exposed.origin,
          `https://${job.port}-${SESSION_ID}-${accepted.routeNonce}.preview.scotty.example`,
        );
        assert.match(exposed.cookieSecret, /^[0-9a-f]{64}$/u);
        const state = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence);
        assert.strictEqual(
          state?.activeJob?.previewCookieDigest,
          yield* Effect.promise(() => sha256Hex(exposed.cookieSecret)),
        );
        assert.strictEqual(state?.activeJob?.exposure, "active");
        assert.notInclude(JSON.stringify(state), exposed.cookieSecret);
        assert.notInclude(JSON.stringify(state), exposed.origin);
        assert.deepStrictEqual(harness.exposedPreviewPorts(), [job.port]);

        const authorization = {
          sessionId: SESSION_ID,
          port: job.port,
          routeNonce: accepted.routeNonce,
          cookieSecret: exposed.cookieSecret,
        } as const;
        assert.ok(
          (yield* Effect.promise(() =>
            harness.sandbox.admitScottyEvidencePreview({ ...authorization, ingressBytes: 0 }),
          )) !== undefined,
        );
        yield* Effect.promise(() => harness.startRuntime());
        assert.strictEqual(
          yield* Effect.promise(() =>
            harness.sandbox.admitScottyEvidencePreview({ ...authorization, ingressBytes: 0 }),
          ),
          undefined,
        );
      }),
  );

  it.effect("serializes concurrent preview admission at four persisted permits", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      const admissions = yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 5 }, () =>
            harness.sandbox.admitScottyEvidencePreview({
              sessionId: SESSION_ID,
              port: job.port,
              routeNonce: accepted.routeNonce,
              cookieSecret: exposed.cookieSecret,
              ingressBytes: 0,
            }),
          ),
        ),
      );
      assert.strictEqual(admissions.filter(Predicate.isNotUndefined).length, 4);
      assert.strictEqual(
        harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob?.previewAccounting
          .permits.length,
        4,
      );
    }),
  );

  it.effect("claims at Sandbox.fetch and settles only when the response stream reaches EOF", () =>
    Effect.gen(function* () {
      const forwarded: Request[] = [];
      const harness = yield* createHarness({
        previewBase: "preview.scotty.example",
        previewRequestForwarder: async (request) => {
          forwarded.push(request.clone());
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.of(1, 2));
                controller.enqueue(Uint8Array.of(3, 4, 5));
                controller.close();
              },
            }),
          );
        },
      });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      const directSdkRequest = previewForwardingRequest("0".repeat(32), accepted.routeNonce);
      const directHeaders = new Headers(directSdkRequest.headers);
      directHeaders.delete(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER);
      assert.strictEqual(
        (yield* Effect.promise(() =>
          harness.sandbox.fetch(new Request(directSdkRequest, { headers: directHeaders })),
        )).status,
        404,
      );
      assert.strictEqual(forwarded.length, 0);
      const permit = yield* Effect.promise(() =>
        harness.sandbox.admitScottyEvidencePreview({
          sessionId: SESSION_ID,
          port: job.port,
          routeNonce: accepted.routeNonce,
          cookieSecret: exposed.cookieSecret,
          ingressBytes: 7,
        }),
      );
      assert.ok(permit !== undefined);
      const response = yield* Effect.promise(() =>
        harness.sandbox.fetch(previewForwardingRequest(permit.requestId, accepted.routeNonce)),
      );
      assert.strictEqual(
        harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob?.previewAccounting
          .permits[0]?.state,
        "claimed",
      );
      assert.strictEqual(
        response.headers.get(EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER),
        permit.requestId,
      );
      assert.strictEqual(forwarded[0]?.headers.get(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER), null);
      assert.deepStrictEqual(
        new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
        Uint8Array.of(1, 2, 3, 4, 5),
      );
      assert.deepStrictEqual(
        harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob?.previewAccounting,
        { consumedBytes: 12, consumedRequestMillis: 0, permits: [] },
      );
    }),
  );

  it.effect("rejects every WebSocket framing header before claiming the permit", () =>
    Effect.gen(function* () {
      let forwarded = 0;
      const harness = yield* createHarness({
        previewBase: "preview.scotty.example",
        previewRequestForwarder: async () => {
          forwarded += 1;
          return new Response("must not forward");
        },
      });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      for (const [name, value] of [
        ["connection", "keep-alive"],
        ["upgrade", "h2c"],
        ["sec-websocket-key", "attacker"],
        ["sec-websocket-version", "13"],
        ["sec-websocket-protocol", "attacker"],
        ["sec-websocket-extensions", "attacker"],
        ["sec-websocket-unrecognized", "attacker"],
      ] as const) {
        const permit = yield* Effect.promise(() =>
          harness.sandbox.admitScottyEvidencePreview({
            sessionId: SESSION_ID,
            port: job.port,
            routeNonce: accepted.routeNonce,
            cookieSecret: exposed.cookieSecret,
            ingressBytes: 0,
          }),
        );
        assert.ok(permit !== undefined);
        const response = yield* Effect.promise(() =>
          harness.sandbox.fetch(
            previewForwardingRequest(permit.requestId, accepted.routeNonce, undefined, {
              [name]: value,
            }),
          ),
        );
        assert.strictEqual(response.status, 404, name);
      }
      assert.strictEqual(forwarded, 0);
      assert.deepStrictEqual(
        harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob?.previewAccounting,
        { consumedBytes: 0, consumedRequestMillis: 0, permits: [] },
      );
    }),
  );

  it.effect("charges the full reservation and duration when a claimed request times out", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        previewBase: "preview.scotty.example",
        previewRequestForwarder: async () => new Promise<Response>(() => undefined),
      });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      const permit = yield* Effect.promise(() =>
        harness.sandbox.admitScottyEvidencePreview({
          sessionId: SESSION_ID,
          port: job.port,
          routeNonce: accepted.routeNonce,
          cookieSecret: exposed.cookieSecret,
          ingressBytes: 0,
        }),
      );
      assert.ok(permit !== undefined);
      yield* TestClock.setTime(NOW + 29_999);
      const response = yield* Effect.promise(() =>
        harness.sandbox.fetch(previewForwardingRequest(permit.requestId, accepted.routeNonce)),
      );
      assert.strictEqual(response.status, 404);
      assert.deepStrictEqual(
        harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob?.previewAccounting,
        {
          consumedBytes: EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
          consumedRequestMillis: 30_000,
          permits: [],
        },
      );
    }),
  );

  it.effect(
    "cancels and charges an over-limit stream, then revokes live streams before unexpose",
    () =>
      Effect.gen(function* () {
        let sourceCanceled = 0;
        let responseNumber = 0;
        const harness = yield* createHarness({
          previewBase: "preview.scotty.example",
          previewRequestForwarder: async () => {
            responseNumber += 1;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    responseNumber === 1
                      ? new Uint8Array(EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES + 1)
                      : Uint8Array.of(1),
                  );
                },
                cancel() {
                  sourceCanceled += 1;
                },
              }),
            );
          },
        });
        yield* Effect.promise(() => harness.startRuntime());
        const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
        const exposed = yield* Effect.promise(() =>
          harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
        );
        const admit = () =>
          harness.sandbox.admitScottyEvidencePreview({
            sessionId: SESSION_ID,
            port: job.port,
            routeNonce: accepted.routeNonce,
            cookieSecret: exposed.cookieSecret,
            ingressBytes: 0,
          });
        const overLimit = yield* Effect.promise(admit);
        assert.ok(overLimit !== undefined);
        const overLimitResponse = yield* Effect.promise(() =>
          harness.sandbox.fetch(previewForwardingRequest(overLimit.requestId, accepted.routeNonce)),
        );
        const readOverLimit = yield* Effect.result(
          Effect.tryPromise({
            try: () => overLimitResponse.arrayBuffer(),
            catch: (cause) => cause,
          }),
        );
        assert.ok(Result.isFailure(readOverLimit));
        assert.strictEqual(sourceCanceled, 1);
        assert.deepInclude(
          harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob?.previewAccounting,
          { consumedBytes: EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES, permits: [] },
        );

        const live = yield* Effect.promise(admit);
        assert.ok(live !== undefined);
        const liveResponse = yield* Effect.promise(() =>
          harness.sandbox.fetch(previewForwardingRequest(live.requestId, accepted.routeNonce)),
        );
        const reader = liveResponse.body?.getReader();
        assert.ok(reader !== undefined);
        assert.deepStrictEqual(
          (yield* Effect.promise(() => reader.read())).value,
          Uint8Array.of(1),
        );
        const eventStart = harness.events.length;
        yield* Effect.promise(() =>
          harness.sandbox.finalizeScottyEvidenceJob(accepted.operationNonce, "succeeded"),
        );
        const cleanupEvents = harness.events.slice(eventStart);
        assert.strictEqual(sourceCanceled, 2);
        assert.isBelow(
          cleanupEvents.indexOf(`storage:put:${sessionHarnessKeys.evidence}`),
          cleanupEvents.indexOf(`host:preview:unexpose:${job.port}`),
        );
        assert.strictEqual(
          harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob,
          undefined,
        );
      }),
  );

  it.effect("revokes and unexposes before the runtime epoch is removed on stop", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      assert.ok(
        (yield* Effect.promise(() =>
          harness.sandbox.admitScottyEvidencePreview({
            sessionId: SESSION_ID,
            port: job.port,
            routeNonce: accepted.routeNonce,
            cookieSecret: exposed.cookieSecret,
            ingressBytes: 0,
          }),
        )) !== undefined,
      );
      const eventStart = harness.events.length;
      yield* Effect.promise(() => harness.stopRuntime());
      const cleanupEvents = harness.events.slice(eventStart);
      assert.strictEqual(harness.read<string>(sessionHarnessKeys.runtimeEpoch), undefined);
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
      assert.strictEqual(harness.readRecord()?.operation, null);
      assert.deepInclude(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.jobs[0], {
        status: "interrupted",
      });
      assert.isBelow(
        cleanupEvents.indexOf(`storage:put:${sessionHarnessKeys.evidence}`),
        cleanupEvents.indexOf(`host:preview:unexpose:${job.port}`),
      );
      assert.isBelow(
        cleanupEvents.indexOf(`host:preview:unexpose:${job.port}`),
        cleanupEvents.lastIndexOf(`storage:delete:${sessionHarnessKeys.runtimeEpoch}`),
      );
    }),
  );

  it.effect("compensates an ambiguous expose before releasing evidence authority", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        failureStage: "previewExpose",
        previewBase: "preview.scotty.example",
      });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(exposed));
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
      assert.strictEqual(harness.readRecord()?.operation, null);
      assert.deepInclude(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.jobs[0], {
        status: "interrupted",
      });
      assert.isBelow(
        harness.events.indexOf(`host:preview:expose:${job.port}`),
        harness.events.indexOf(`host:preview:unexpose:${job.port}`),
      );
    }),
  );

  it.effect("unexposes and refuses success when the runtime epoch changes during exposure", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        previewBase: "preview.scotty.example",
        rotateEpochAfterPreviewExpose: true,
      });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(exposed));
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
      const state = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence);
      assert.strictEqual(state?.activeJob, undefined);
      assert.deepInclude(state?.jobs[0], { status: "interrupted" });
      assert.isBelow(
        harness.events.indexOf(`host:preview:expose:${job.port}`),
        harness.events.indexOf(`host:preview:unexpose:${job.port}`),
      );
    }),
  );

  it.effect("revokes the digest before ambiguous unexpose and retains finalizing authority", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      harness.injectFailure("previewUnexpose");

      const finalized = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            harness.sandbox.finalizeScottyEvidenceJob(accepted.operationNonce, "succeeded"),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(finalized));
      const pending = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob;
      assert.strictEqual(pending?.previewCookieDigest, null);
      assert.strictEqual(pending?.exposure, "unexpose_pending");
      assert.strictEqual(pending?.status, "finalizing");
      assert.strictEqual(harness.readRecord()?.operation?.kind, "evidence");
      assert.deepStrictEqual(harness.exposedPreviewPorts(), [job.port]);

      harness.clearFailure("previewUnexpose");
      const summary = yield* Effect.promise(() =>
        harness.sandbox.finalizeScottyEvidenceJob(accepted.operationNonce, "succeeded"),
      );
      assert.strictEqual(summary.status, "succeeded");
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
      assert.strictEqual(harness.readRecord()?.operation, null);
    }),
  );

  it.effect("retains the evidence lease when deadline cleanup is ambiguous", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      harness.injectFailure("previewUnexpose");

      yield* Effect.promise(() =>
        harness.sandbox.expireEvidenceJob({
          nonce: accepted.operationNonce,
          deadlineAt: accepted.deadlineAt,
        }),
      );
      assert.strictEqual(harness.readRecord()?.operation?.kind, "evidence");
      assert.deepInclude(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob, {
        status: "interrupted",
        exposure: "unexpose_pending",
        previewCookieDigest: null,
      });
      assert.deepInclude(
        harness.schedules.find(({ callback }) => callback === "expireEvidenceJob"),
        {
          callback: "expireEvidenceJob",
          payload: { nonce: accepted.operationNonce, deadlineAt: accepted.deadlineAt },
        },
      );

      harness.clearFailure("previewUnexpose");
      yield* Effect.promise(() =>
        harness.sandbox.expireEvidenceJob({
          nonce: accepted.operationNonce,
          deadlineAt: accepted.deadlineAt,
        }),
      );
      assert.strictEqual(harness.readRecord()?.operation, null);
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
    }),
  );

  it.effect("destroys compute and fails the callback when cleanup retry scheduling fails", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      harness.injectFailure("previewUnexpose");
      harness.injectFailure("hardCapSchedule");

      const enforced = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.enforceHardCap({ hardCapAt: "2026-08-06T13:00:00.000Z" }),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(enforced));
      assert.include(harness.events, "host:destroy");
      assert.strictEqual(harness.readRecord()?.operation?.kind, "evidence");
      assert.deepInclude(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob, {
        status: "interrupted",
        exposure: "unexpose_pending",
        previewCookieDigest: null,
      });
      assert.deepStrictEqual(harness.exposedPreviewPorts(), [job.port]);
    }),
  );

  it.effect("fails closed when runtime epoch start or stop persistence is ambiguous", () =>
    Effect.gen(function* () {
      const failedStart = yield* createHarness({ failureStage: "runtimeEpochPut" });
      const started = yield* Effect.result(
        Effect.tryPromise({
          try: () => failedStart.startRuntime(),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(started));
      assert.strictEqual(failedStart.read<string>(sessionHarnessKeys.runtimeEpoch), undefined);
      const accepted = yield* Effect.result(
        Effect.tryPromise({
          try: () => failedStart.sandbox.acceptScottyEvidenceJob(job),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(accepted));

      const failedStop = yield* createHarness({
        previewBase: "preview.scotty.example",
      });
      yield* Effect.promise(() => failedStop.startRuntime());
      const active = yield* Effect.promise(() => failedStop.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        failedStop.sandbox.exposeScottyEvidencePreview(active.operationNonce),
      );
      failedStop.injectFailure("runtimeEpochDelete");
      const stopped = yield* Effect.result(
        Effect.tryPromise({
          try: () => failedStop.stopRuntime(),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(stopped));
      assert.strictEqual(failedStop.read<string>(sessionHarnessKeys.runtimeEpoch), undefined);
      assert.strictEqual(
        yield* Effect.promise(() =>
          failedStop.sandbox.admitScottyEvidencePreview({
            sessionId: SESSION_ID,
            port: job.port,
            routeNonce: active.routeNonce,
            cookieSecret: exposed.cookieSecret,
            ingressBytes: 0,
          }),
        ),
        undefined,
      );
      assert.deepStrictEqual(failedStop.exposedPreviewPorts(), []);
    }),
  );

  it.effect("keeps vaporize fail-closed but hard cap destroys compute with cleanup pending", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ previewBase: "preview.scotty.example" });
      yield* Effect.promise(() => harness.startRuntime());
      const accepted = yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job));
      const exposed = yield* Effect.promise(() =>
        harness.sandbox.exposeScottyEvidencePreview(accepted.operationNonce),
      );
      assert.ok(
        (yield* Effect.promise(() =>
          harness.sandbox.admitScottyEvidencePreview({
            sessionId: SESSION_ID,
            port: job.port,
            routeNonce: accepted.routeNonce,
            cookieSecret: exposed.cookieSecret,
            ingressBytes: 0,
          }),
        )) !== undefined,
      );
      harness.injectFailure("previewUnexpose");

      const vaporized = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.vaporizeScottySession(),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(vaporized));
      assert.strictEqual(harness.readRecord()?.operation?.kind, "evidence");
      assert.notInclude(harness.events, "host:destroy");
      const pending = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob;
      assert.strictEqual(pending?.previewCookieDigest, null);
      assert.strictEqual(pending?.exposure, "unexpose_pending");
      assert.deepStrictEqual(pending?.previewAccounting, {
        consumedBytes: EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
        consumedRequestMillis: 30_000,
        permits: [],
      });

      const hardCapStart = harness.events.length;
      yield* Effect.promise(() =>
        harness.sandbox.enforceHardCap({ hardCapAt: "2026-08-06T13:00:00.000Z" }),
      );
      const hardCapEvents = harness.events.slice(hardCapStart);
      assert.include(hardCapEvents, `storage:put:${sessionHarnessKeys.evidence}`);
      assert.include(hardCapEvents, "host:destroy");
      assert.isBelow(
        hardCapEvents.indexOf(`storage:put:${sessionHarnessKeys.evidence}`),
        hardCapEvents.indexOf("host:destroy"),
      );
      assert.deepInclude(
        harness.schedules.find(({ callback }) => callback === "enforceHardCap"),
        {
          callback: "enforceHardCap",
          payload: { hardCapAt: "2026-08-06T13:00:00.000Z" },
        },
      );
      assert.strictEqual(harness.readRecord()?.operation?.kind, "evidence");
      assert.deepInclude(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence)?.activeJob, {
        status: "interrupted",
        exposure: "unexpose_pending",
        previewCookieDigest: null,
      });
      assert.deepStrictEqual(harness.exposedPreviewPorts(), [job.port]);

      harness.clearFailure("previewUnexpose");
      const gone = yield* Effect.promise(() => harness.sandbox.vaporizeScottySession());
      assert.deepStrictEqual(gone, { id: SESSION_ID, status: "gone" });
      assert.deepStrictEqual(harness.exposedPreviewPorts(), []);
    }),
  );
});
