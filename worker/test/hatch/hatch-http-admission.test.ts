import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  HATCH_MAX_INGRESS_BYTES,
  HATCH_MAX_RESPONSE_BYTES,
  type HatchState,
} from "../../src/hatch/contracts";
import { HatchStore, hatchStoreLayer } from "../../src/hatch/store";
import { makeSessionRecord } from "../support";

const SESSION_ID = "a0b1c2d3e4f5";
const ROUTE_NONCE = "h0123456789abcd";
const RUNTIME_EPOCH = "runtime-current";
const COOKIE_DIGEST = "a".repeat(64);
const HISTORICAL_BYTES = 100 * 1_024 * 1_024;

const requestId = (index: number): string => index.toString(16).padStart(32, "0");

it.effect("admits more than 32 active HTTP requests before and after prior traffic", () =>
  Effect.gen(function* () {
    const record = makeSessionRecord({ id: SESSION_ID });
    let state: HatchState = {
      primary: {
        hatchId: "hatch-one",
        sessionId: SESSION_ID,
        generation: 1,
        service: {
          name: "web",
          argv: ["npm", "run", "dev"],
          workingDirectory: `/workspace/${SESSION_ID}`,
          port: 4_173,
          healthPath: "/health",
        },
        desiredStatus: "open",
        observedStatus: "running",
        runtimeEpoch: RUNTIME_EPOCH,
        exposure: "active",
        routeNonce: ROUTE_NONCE,
        permits: [
          {
            permitId: "permit-browser",
            browserClientId: "111111111111",
            cookieDigest: COOKIE_DIGEST,
            createdAt: "1970-01-01T00:00:00.000Z",
            expiresAt: "2100-01-01T00:00:00.000Z",
            ingressBytes: HISTORICAL_BYTES,
            responseBytes: HISTORICAL_BYTES,
          },
        ],
        requests: [
          {
            requestId: "f".repeat(32),
            permitId: "permit-browser",
            generation: 1,
            runtimeEpoch: RUNTIME_EPOCH,
            reservedIngressBytes: HATCH_MAX_INGRESS_BYTES,
            ingressBytes: HATCH_MAX_INGRESS_BYTES,
            reservedResponseBytes: HATCH_MAX_RESPONSE_BYTES,
            status: "admitted",
            admittedAt: "1970-01-01T00:00:00.000Z",
            expiresAt: "1970-01-01T00:00:30.000Z",
          },
        ],
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
    };
    const layer = hatchStoreLayer({
      get: async () => state,
      transaction: async (operation) =>
        operation({
          getHatch: async () => state,
          getActorAuthority: async () => undefined,
          getRecord: async () => record,
          getRuntimeEpoch: async () => RUNTIME_EPOCH,
          putHatch: async (next) => {
            state = next;
          },
          deleteHatch: async () => {
            state = {};
          },
        }),
    });

    yield* Effect.gen(function* () {
      const store = yield* HatchStore;
      assert.strictEqual((yield* store.read).primary?.permits[0]?.ingressBytes, HISTORICAL_BYTES);
      assert.deepInclude((yield* store.read).primary?.requests[0], {
        reservedIngressBytes: HATCH_MAX_INGRESS_BYTES,
        reservedResponseBytes: HATCH_MAX_RESPONSE_BYTES,
      });
      assert.isDefined(
        yield* store.claimRequest({
          requestId: "f".repeat(32),
          sessionId: SESSION_ID,
          port: 4_173,
          routeNonce: ROUTE_NONCE,
          runtimeEpoch: RUNTIME_EPOCH,
        }),
      );
      yield* store.settleRequest("f".repeat(32));

      const firstWave = yield* Effect.all(
        Array.from({ length: 40 }, (_, index) =>
          store.admitRequest({
            requestId: requestId(index + 1),
            sessionId: SESSION_ID,
            port: 4_173,
            routeNonce: ROUTE_NONCE,
            runtimeEpoch: RUNTIME_EPOCH,
            cookieDigest: COOKIE_DIGEST,
          }),
        ),
      );
      assert.isTrue(firstWave.every((permit) => permit !== undefined));
      assert.strictEqual(state.primary?.requests.length, 40);
      assert.isTrue(
        state.primary?.requests.every(
          (request) =>
            request.reservedIngressBytes === undefined &&
            request.reservedResponseBytes === undefined,
        ),
      );

      const adjustments = yield* Effect.forEach(firstWave, (permit, index) => {
        assert.isDefined(permit);
        return store.adjustRequest(permit.requestId, index % 2 === 0 ? HATCH_MAX_INGRESS_BYTES : 0);
      });
      assert.isTrue(adjustments.every(Boolean));
      yield* Effect.forEach(firstWave, (permit) => {
        assert.isDefined(permit);
        return store.settleRequest(permit.requestId);
      });
      assert.strictEqual(state.primary?.requests.length, 0);
      assert.deepInclude(state.primary?.permits[0], {
        ingressBytes: HISTORICAL_BYTES,
        responseBytes: HISTORICAL_BYTES,
      });

      const secondWave = yield* Effect.all(
        Array.from({ length: 40 }, (_, index) =>
          store.admitRequest({
            requestId: requestId(index + 101),
            sessionId: SESSION_ID,
            port: 4_173,
            routeNonce: ROUTE_NONCE,
            runtimeEpoch: RUNTIME_EPOCH,
            cookieDigest: COOKIE_DIGEST,
          }),
        ),
      );
      assert.isTrue(secondWave.every((permit) => permit !== undefined));
      assert.strictEqual(state.primary?.requests.length, 40);
    }).pipe(Effect.provide(layer));
  }),
);
