import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Result } from "effect";
import { sessionActorLayer } from "../../src/session-actor/actor";
import { ActorEffectRunner } from "../../src/session-actor/effect-runner";
import {
  decodeSessionAuthority,
  StableStateSchema,
  TransitionSchema,
  type ReadinessProof,
  type SessionAuthority,
} from "../../src/session-actor/authority";
import {
  actorStoreLayer,
  type ActorStoragePort,
  type RawActorStorageSnapshot,
} from "../../src/session-actor/store";
import {
  WarmWorkController,
  warmWorkControllerLayer,
} from "../../src/session-actor/transitions/warm-work";
import { decide } from "../../src/session-actor/reducer";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:01:00.000Z";
const DEADLINE = "2026-09-01T01:00:00.000Z";
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
  revision: 1,
  hardCap: { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap" },
  session: {
    id: "warm-work-session",
    title: "Warm work",
    repository: "owner/disposable",
    execution: { provider: "cloudflare", runtimeName: "warm-work-session" },
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

const testLayer = () => {
  let state: RawActorStorageSnapshot = {
    authority: warm,
    revision: 1,
    journalSequence: 1,
    journalTail: {
      sequence: 1,
      revision: 1,
      timestamp: T0,
      correlationId: "create",
      transitionNonce: null,
      eventType: "completed",
      transitionKind: null,
      transitionPhase: null,
      resultCode: "warm",
      causeSequence: null,
      causeAttempt: null,
    },
  };
  const port: ActorStoragePort = {
    read: () => Promise.resolve(state),
    transaction: (operation) => {
      const plan = operation(state);
      if (Predicate.isTagged(plan, "NoCommit")) return Promise.resolve(plan.outcome);
      state = {
        authority: plan.write.authority,
        revision: plan.write.revision,
        journalSequence: plan.write.journalSequence,
        journalTail: plan.write.appendJournal,
        evidence: Predicate.isTagged(plan.write.evidence, "Put")
          ? plan.write.evidence.value
          : state.evidence,
      };
      return Promise.resolve(plan.outcome);
    },
  };
  const store = actorStoreLayer(port);
  const runner = Layer.succeed(ActorEffectRunner)(
    ActorEffectRunner.of({ run: () => Effect.succeed({ _tag: "NoObservation" }) }),
  );
  const actor = sessionActorLayer.pipe(Layer.provide(Layer.merge(store, runner)));
  return {
    layer: warmWorkControllerLayer.pipe(Layer.provide(Layer.merge(store, actor))),
    snapshot: () => state,
  };
};

describe("warm work controller", () => {
  it("blocks sleep while WarmWork owns mutation and admits vaporize priority", () => {
    const admitted = decide(warm, {
      _tag: "WarmWorkCommand",
      expectedRevision: warm.revision,
      correlationId: "warm-work",
      nonce: "warm-work-nonce",
      attempt: "warm-work-attempt",
      timestamp: T0,
      deadlineAt: DEADLINE,
      workKind: "Evidence",
    });
    assert.ok(Predicate.isTagged(admitted, "Accepted"));
    if (!Predicate.isTagged(admitted, "Accepted")) return;
    const sleep = decide(admitted.nextAuthority, {
      _tag: "SleepCommand",
      expectedRevision: admitted.nextAuthority.revision,
      correlationId: "sleep",
      nonce: "sleep-nonce",
      attempt: "sleep-attempt",
      timestamp: T1,
      deadlineAt: DEADLINE,
    });
    assert.deepStrictEqual(sleep, { _tag: "Rejected", code: "transition_owned" });

    const vaporize = decide(admitted.nextAuthority, {
      _tag: "VaporizeCommand",
      expectedRevision: admitted.nextAuthority.revision,
      correlationId: "vaporize",
      nonce: "vaporize-nonce",
      attempt: "vaporize-attempt",
      timestamp: T1,
      deadlineAt: DEADLINE,
    });
    assert.ok(Predicate.isTagged(vaporize, "Accepted"));
  });

  it.effect("commits intent before work and returns to Warm after fenced settlement", () => {
    const test = testLayer();
    return Effect.gen(function* () {
      const controller = yield* WarmWorkController;
      const lease = yield* controller.admit({
        kind: "Evidence",
        correlationId: "evidence-correlation",
        nonce: "evidence-nonce",
        attempt: "evidence-attempt",
        timestamp: T0,
        deadlineAt: DEADLINE,
        evidence: { _tag: "Put", value: { activeJob: "safe-evidence" } },
      });
      const admitted = test.snapshot();
      assert.deepStrictEqual(admitted.evidence, { activeJob: "safe-evidence" });
      const admittedAuthority = decodeSessionAuthority(admitted.authority);
      assert.ok(Result.isSuccess(admittedAuthority));
      assert.ok(Predicate.isTagged(admittedAuthority.success.state, "Transitioning"));
      assert.ok(TransitionSchema.guards.WarmWork(admittedAuthority.success.state.transition));
      assert.strictEqual(admittedAuthority.success.state.transition.phase, "Running");

      const settled = yield* controller.settle(lease, T1, "evidence_complete");
      assert.ok(Predicate.isTagged(settled.state, "Stable"));
      assert.ok(StableStateSchema.guards.Warm(settled.state.stable));
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("retains WarmWork authority when an external outcome is unknown", () => {
    const test = testLayer();
    return Effect.gen(function* () {
      const controller = yield* WarmWorkController;
      const lease = yield* controller.admit({
        kind: "Hatch",
        correlationId: "hatch-correlation",
        nonce: "hatch-nonce",
        attempt: "hatch-attempt",
        timestamp: T0,
        deadlineAt: DEADLINE,
      });
      const authority = yield* controller.reconcile(lease, T1, "hatch_outcome_unknown");
      assert.ok(Predicate.isTagged(authority.state, "Transitioning"));
      assert.ok(TransitionSchema.guards.WarmWork(authority.state.transition));
      assert.strictEqual(authority.state.transition.mode, "reconciling");
    }).pipe(Effect.provide(test.layer));
  });
});
