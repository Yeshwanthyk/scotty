import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Result } from "effect";
import { SessionActor, type ActorHandleResult } from "../../src/session-actor/actor";
import type {
  ReadinessProof,
  SessionAuthority,
  SessionIdentity,
} from "../../src/session-actor/authority";
import {
  CreateController,
  CreateControllerBoundaryFailure,
  createControllerLayer,
  createHardCapControllerLayer,
  createMetadataControllerLayer,
  type CreateHardCapArm,
  type CreateControllerRequest,
  type CreateMetadataReservation,
} from "../../src/session-actor/create-controller";
import type { AcceptedDecision } from "../../src/session-actor/decision";
import {
  makeSessionActorMetadata,
  type SessionActorMetadata,
} from "../../src/session-actor/metadata";
import { decide } from "../../src/session-actor/reducer";

const T0 = "2026-03-04T00:00:00.000Z";
const DEADLINE = "2026-03-04T01:00:00.000Z";
const KEY_DIGEST = "a".repeat(64);
const INPUT_DIGEST = "b".repeat(64);

const session: SessionIdentity = {
  id: "create-controller-session",
  title: "Create controller session",
  repository: "owner/disposable",
  execution: { provider: "cloudflare", runtimeName: "runtime-create-controller" },
  createdAt: T0,
};

const request = (overrides: Partial<CreateControllerRequest> = {}): CreateControllerRequest => ({
  session,
  branch: "scotty/create-controller-session",
  createRepositoryIfMissing: false,
  initialPrompt: "Keep this private",
  payloadReference: "private-payload-ref",
  idempotency: { keyDigest: KEY_DIGEST, inputDigest: INPUT_DIGEST },
  correlationId: "create-controller-correlation",
  nonce: "create-controller-nonce",
  attempt: "create-controller-attempt",
  timestamp: T0,
  transitionDeadlineAt: DEADLINE,
  hardCap: {
    durationSeconds: 3_600,
    deadlineAt: DEADLINE,
    generation: "hard-cap-generation",
  },
  ...overrides,
});

const readiness: ReadinessProof = {
  runtime: {
    providerRuntimeId: "provider-runtime",
    runtimeGeneration: "runtime-generation",
    containerIncarnation: "container-incarnation",
  },
  supervisor: {
    processId: "supervisor-process",
    supervisorEpoch: "supervisor-epoch",
    runtimeGeneration: "runtime-generation",
    containerIncarnation: "container-incarnation",
  },
  transport: {
    transportId: "transport",
    supervisorEpoch: "supervisor-epoch",
    runtimeGeneration: "runtime-generation",
    containerIncarnation: "container-incarnation",
  },
};

const warmAuthority = (proof: ReadinessProof = readiness): SessionAuthority => ({
  revision: 8,
  session,
  hardCap: request().hardCap,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness: proof,
      backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
      activity: null,
    },
  },
});

const acceptedAdmission = (value: CreateControllerRequest = request()): AcceptedDecision => {
  const admission = decide(undefined, {
    _tag: "CreateCommand",
    expectedRevision: 0,
    correlationId: value.correlationId,
    nonce: value.nonce,
    attempt: value.attempt,
    timestamp: value.timestamp,
    deadlineAt: value.transitionDeadlineAt,
    session: value.session,
    hardCap: value.hardCap,
  });
  assert.ok(Predicate.isTagged(admission, "Accepted"));
  return admission;
};

const actorResult = (authority: SessionAuthority): ActorHandleResult => ({
  decision: {
    _tag: "Accepted",
    nextAuthority: authority,
    journalEvent: {
      timestamp: T0,
      correlationId: "create-controller-correlation",
      transitionNonce: null,
      eventType: "completed",
      transitionKind: "Create",
      transitionPhase: "TransportVerifying",
      resultCode: "completed",
      causeAttempt: "create-controller-attempt",
    },
    effectIntents: [],
  },
  committed: [
    {
      authority,
      journalEvent: {
        sequence: authority.revision,
        revision: authority.revision,
        timestamp: T0,
        correlationId: "create-controller-correlation",
        transitionNonce: null,
        eventType: "completed",
        transitionKind: "Create",
        transitionPhase: "TransportVerifying",
        resultCode: "completed",
        causeSequence: null,
        causeAttempt: "create-controller-attempt",
      },
      effectIntents: [],
    },
  ],
});

const metadata = (value: CreateControllerRequest = request()): SessionActorMetadata => {
  const made = makeSessionActorMetadata(acceptedAdmission(value).nextAuthority, {
    branch: value.branch,
    createRepositoryIfMissing: value.createRepositoryIfMissing,
    hardCap: value.hardCap,
    createIdempotency: value.idempotency ?? null,
    payload: { reference: value.payloadReference },
    initialPrompt: value.initialPrompt,
  });
  assert.ok(Result.isSuccess(made));
  return made.success;
};

interface HarnessOptions {
  readonly reservation?: CreateMetadataReservation;
  readonly authority?: SessionAuthority;
  readonly hardCapFailure?: boolean;
  readonly events?: string[];
}

const harness = (options: HarnessOptions = {}) => {
  const events = options.events ?? [];
  let actorCalls = 0;
  let hardCapCalls = 0;
  const hardCapArms: CreateHardCapArm[] = [];
  let scrubCalls = 0;
  const actorLayer = Layer.succeed(SessionActor)(
    SessionActor.of({
      handle: () => {
        actorCalls += 1;
        events.push("actor_provider_dispatch");
        return Effect.succeed(actorResult(options.authority ?? warmAuthority()));
      },
      resume: () => Effect.succeed(undefined),
    }),
  );
  const capLayer = createHardCapControllerLayer((arm) => {
    hardCapCalls += 1;
    hardCapArms.push(arm);
    events.push("hard_cap_armed");
    return options.hardCapFailure
      ? Effect.fail(
          new CreateControllerBoundaryFailure({ boundary: "hard_cap", code: "arm_failed" }),
        )
      : Effect.void;
  });
  const metadataLayer = createMetadataControllerLayer({
    inspect: () => {
      events.push("metadata_inspected");
      return Effect.succeed(
        options.reservation !== undefined && Predicate.isTagged(options.reservation, "Existing")
          ? options.reservation
          : { _tag: "Missing" },
      );
    },
    reserve: () => {
      events.push("metadata_reserved");
      return Effect.succeed(options.reservation ?? { _tag: "Reserved", metadata: metadata() });
    },
    scrubSettled: () => {
      scrubCalls += 1;
      events.push("metadata_scrubbed");
      return Effect.void;
    },
  });
  const dependencies = Layer.merge(Layer.merge(actorLayer, capLayer), metadataLayer);
  const layer = createControllerLayer.pipe(Layer.provide(dependencies));
  const run = (value: CreateControllerRequest = request()) =>
    Effect.flatMap(CreateController, (controller) => controller.create(value)).pipe(
      Effect.provide(layer),
    );
  return {
    run,
    actorCalls: () => actorCalls,
    hardCapCalls: () => hardCapCalls,
    hardCapArms,
    scrubCalls: () => scrubCalls,
    events,
  };
};

describe("create controller", () => {
  it.effect("arms the hard cap before authority commit and stops when arming fails", () =>
    Effect.gen(function* () {
      const test = harness({ hardCapFailure: true });
      const outcome = yield* Effect.result(test.run());
      assert.ok(Result.isFailure(outcome));
      assert.ok(Predicate.isTagged(outcome.failure, "CreateControllerBoundaryFailure"));
      assert.strictEqual(test.actorCalls(), 0);
      assert.deepStrictEqual(test.events, ["metadata_inspected", "hard_cap_armed"]);
    }),
  );

  it.effect("persists private metadata and arms the hard cap before provider dispatch", () =>
    Effect.gen(function* () {
      const test = harness();
      const outcome = yield* test.run();
      assert.ok(Predicate.isTagged(outcome, "Warm"));
      assert.deepStrictEqual(test.events, [
        "metadata_inspected",
        "hard_cap_armed",
        "metadata_reserved",
        "actor_provider_dispatch",
        "metadata_scrubbed",
      ]);
      assert.strictEqual(test.scrubCalls(), 1);
      assert.deepStrictEqual(test.hardCapArms, [
        {
          sessionId: session.id,
          generation: request().hardCap.generation,
          deadlineAt: request().hardCap.deadlineAt,
          durationSeconds: request().hardCap.durationSeconds,
        },
      ]);
    }),
  );

  it.effect("replays matching idempotency without arming or redispatching", () =>
    Effect.gen(function* () {
      const test = harness({
        reservation: { _tag: "Existing", metadata: metadata(), authority: warmAuthority() },
      });
      const outcome = yield* test.run();
      assert.ok(Predicate.isTagged(outcome, "Warm"));
      assert.strictEqual(outcome.replay, true);
      assert.strictEqual(test.actorCalls(), 0);
      assert.strictEqual(test.hardCapCalls(), 0);
      assert.strictEqual(test.scrubCalls(), 1);
    }),
  );

  it.effect("rejects an idempotency mismatch without side effects", () =>
    Effect.gen(function* () {
      const stored = metadata();
      assert.ok(stored.createIdempotency !== null);
      const test = harness({
        reservation: {
          _tag: "Existing",
          metadata: {
            ...stored,
            createIdempotency: { ...stored.createIdempotency, inputDigest: "c".repeat(64) },
          },
          authority: warmAuthority(),
        },
      });
      const outcome = yield* Effect.result(test.run());
      assert.ok(Result.isFailure(outcome));
      assert.ok(Predicate.isTagged(outcome.failure, "CreateControllerConflict"));
      assert.strictEqual(test.actorCalls(), 0);
      assert.strictEqual(test.hardCapCalls(), 0);
      assert.strictEqual(test.scrubCalls(), 0);
    }),
  );

  it.effect("accepts Warm only when transport matches runtime and supervisor proof", () =>
    Effect.gen(function* () {
      const invalid = warmAuthority({
        ...readiness,
        transport: { ...readiness.transport, supervisorEpoch: "stale-supervisor-epoch" },
      });
      const test = harness({ authority: invalid });
      const outcome = yield* Effect.result(test.run());
      assert.ok(Result.isFailure(outcome));
      assert.ok(Predicate.isTagged(outcome.failure, "CreateControllerInvariantFailure"));
      assert.strictEqual(outcome.failure.code, "authority_invalid");
      assert.strictEqual(test.scrubCalls(), 0);
    }),
  );

  it.effect("rejects disabled runner creation before reserving metadata", () =>
    Effect.gen(function* () {
      const test = harness();
      const outcome = yield* Effect.result(
        test.run(
          request({
            session: {
              ...session,
              execution: { provider: "runner", runnerName: "disabled-runner" },
            },
          }),
        ),
      );
      assert.ok(Result.isFailure(outcome));
      assert.ok(Predicate.isTagged(outcome.failure, "CreateControllerRejected"));
      assert.strictEqual(outcome.failure.code, "runner_create_disabled");
      assert.deepStrictEqual(test.events, []);
    }),
  );
});
