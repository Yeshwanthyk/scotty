import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Result } from "effect";
import { SessionActor, type ActorHandleResult } from "../../src/session-actor/actor";
import type { ReadinessProof, SessionAuthority } from "../../src/session-actor/authority";
import {
  LifecycleController,
  lifecycleControllerLayer,
  type LifecycleControllerRequest,
} from "../../src/session-actor/lifecycle-controller";
import { ActorStore, type ActorStoreSnapshot } from "../../src/session-actor/store";
import type { SessionActorInput } from "../../src/session-actor/input";
import { createHardCapControllerLayer } from "../../src/session-actor/create-controller";

const T0 = "2026-09-01T00:00:00.000Z";
const hardCap = {
  durationSeconds: 3_600,
  deadlineAt: "2026-09-01T01:00:00.000Z",
  generation: "hard-cap-1",
};
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
const warm: SessionAuthority = {
  revision: 7,
  hardCap,
  session: {
    id: "lifecycle-session",
    title: "Lifecycle session",
    repository: "owner/disposable",
    execution: { provider: "cloudflare", runtimeName: "lifecycle-session" },
    createdAt: T0,
  },
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness,
      backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
      activity: null,
    },
  },
};

const request = (kind: LifecycleControllerRequest["kind"]): LifecycleControllerRequest => {
  const fields = {
    correlationId: "correlation",
    nonce: "nonce",
    attempt: "attempt",
    timestamp: T0,
    deadlineAt: "2026-09-01T00:10:00.000Z",
  };
  return kind === "Resume"
    ? { kind, ...fields, nextHardCap: { ...hardCap, generation: "hard-cap-resume" } }
    : { kind, ...fields };
};

const snapshot = (authority: SessionAuthority): ActorStoreSnapshot => ({
  authority,
  revision: authority.revision,
  journalSequence: authority.revision,
  journalTail: undefined,
  evidence: undefined,
});

const accepted = (authority: SessionAuthority): ActorHandleResult => ({
  decision: {
    _tag: "Accepted",
    nextAuthority: authority,
    journalEvent: {
      timestamp: T0,
      correlationId: "correlation",
      transitionNonce: "nonce",
      eventType: "completed",
      transitionKind: "Checkpoint",
      transitionPhase: "TransportReady",
      resultCode: "complete",
      causeAttempt: "attempt",
    },
    effectIntents: [],
  },
  committed: [],
});

const layer = (
  handle: SessionActor["Service"]["handle"],
  read: ActorStore["Service"]["read"] = Effect.succeed(snapshot(warm)),
) =>
  lifecycleControllerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SessionActor)(
          SessionActor.of({ handle, resume: () => Effect.succeed(undefined) }),
        ),
        Layer.succeed(ActorStore)(
          ActorStore.of({
            read,
            commit: () => Effect.die("unused"),
            reconcileUnknownCommit: () => Effect.die("unused"),
          }),
        ),
        createHardCapControllerLayer(() => Effect.void),
      ),
    ),
  );

describe("lifecycle controller", () => {
  it.effect("fences an admitted command to the authority revision", () => {
    let observed: SessionActorInput | undefined;
    const testLayer = layer((input) => {
      observed = input;
      return Effect.succeed(accepted(warm));
    });
    return Effect.gen(function* () {
      const result = yield* Effect.flatMap(LifecycleController, (controller) =>
        controller.run(request("Checkpoint")),
      ).pipe(Effect.provide(testLayer));
      assert.ok(Predicate.isTagged(result, "Settled"));
      assert.ok(Predicate.isTagged(observed, "CheckpointCommand"));
      assert.strictEqual(observed.expectedRevision, warm.revision);
    });
  });

  it.effect("publishes actor rejection without dispatching another command", () => {
    const rejected: ActorHandleResult = {
      decision: { _tag: "Rejected", code: "not_admissible" },
      committed: [],
    };
    return Effect.gen(function* () {
      const outcome = yield* Effect.result(
        Effect.flatMap(LifecycleController, (controller) => controller.run(request("Resume"))).pipe(
          Effect.provide(layer(() => Effect.succeed(rejected))),
        ),
      );
      assert.ok(Result.isFailure(outcome));
      assert.ok(Predicate.isTagged(outcome.failure, "LifecycleControllerRejected"));
      assert.strictEqual(outcome.failure.code, "not_admissible");
    });
  });
});
