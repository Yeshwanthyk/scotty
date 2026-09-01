import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import type { AcceptedDecision, Decision } from "../../src/session-actor/decision";
import { decodeLifecycleJournalEvent } from "../../src/session-actor/journal";
import { decide } from "../../src/session-actor/reducer";
import {
  ActorStoreTransactionOutcomeUnknown,
  makeActorStore,
  type ActorCommitRequest,
  type ActorStoragePort,
  type ActorStorageTransactionOutcome,
  type ActorStorageTransactionPlan,
  type RawActorStorageSnapshot,
} from "../../src/session-actor/store";

const T0 = "2026-03-01T00:00:00.000Z";
const DEADLINE = "2026-03-01T01:00:00.000Z";
const hardCap = { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" };
const session = {
  id: "session-atomicity",
  title: "Atomicity",
  repository: "owner/repository",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-atomicity" },
  createdAt: T0,
};

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const initialDecision = (): AcceptedDecision =>
  accepted(
    decide(undefined, {
      _tag: "CreateCommand",
      expectedRevision: 0,
      correlationId: "correlation-create",
      nonce: "nonce-create",
      attempt: "attempt-create",
      timestamp: T0,
      deadlineAt: DEADLINE,
      session,
      hardCap,
    }),
  );

const request = (decision = initialDecision()): ActorCommitRequest => ({
  expectedRevision: 0,
  expectedTransitionNonce: null,
  expectedPhase: null,
  decision,
  evidence: { _tag: "Put", value: { _tag: "SafeEvidence", revision: 1 } },
  causeSequence: null,
});

type Cut = "none" | "before-transaction" | "before-commit" | "between-writes" | "after-commit";

const memoryPort = (cut: Cut = "none") => {
  let state: RawActorStorageSnapshot = {};
  const journal: unknown[] = [];
  let nextCut = cut;
  const port: ActorStoragePort = {
    read: () => Promise.resolve(state),
    transaction: (operation) => {
      if (nextCut === "before-transaction") {
        nextCut = "none";
        return Promise.reject(new Error("cut"));
      }
      const plan = operation(state);
      if (Predicate.isTagged(plan, "NoCommit")) return Promise.resolve(plan.outcome);
      if (nextCut === "before-commit" || nextCut === "between-writes") {
        nextCut = "none";
        return Promise.reject(new Error("cut"));
      }
      state = {
        authority: plan.write.authority,
        revision: plan.write.revision,
        journalSequence: plan.write.journalSequence,
        journalTail: plan.write.appendJournal,
        evidence: Predicate.isTagged(plan.write.evidence, "Put")
          ? plan.write.evidence.value
          : Predicate.isTagged(plan.write.evidence, "Delete")
            ? undefined
            : state.evidence,
      };
      journal.push(plan.write.appendJournal);
      if (nextCut === "after-commit") {
        nextCut = "none";
        return Promise.reject(new Error("cut"));
      }
      return Promise.resolve(plan.outcome);
    },
  };
  return { port, snapshot: () => state, journal: () => journal };
};

const transactionUnknown = (result: Result.Result<unknown, unknown>): void => {
  assert.ok(Result.isFailure(result));
  assert.ok(Predicate.isTagged(result.failure, "ActorStoreTransactionOutcomeUnknown"));
};

describe("session actor store atomicity", () => {
  for (const cut of ["before-transaction", "before-commit", "between-writes"] as const) {
    it.effect(`retains all-old state for ${cut}`, () =>
      Effect.gen(function* () {
        const memory = memoryPort(cut);
        const store = makeActorStore(memory.port);
        transactionUnknown(yield* Effect.result(store.commit(request())));
        assert.deepStrictEqual(memory.snapshot(), {});
        assert.deepStrictEqual(memory.journal(), []);
        const reconciled = yield* Effect.result(store.reconcileUnknownCommit(request()));
        assert.ok(Result.isFailure(reconciled));
        assert.ok(Predicate.isTagged(reconciled.failure, "ActorStoreUnconfirmedCommit"));
      }),
    );
  }

  it.effect("retains all-new state and confirms an after-commit ambiguity by reread", () =>
    Effect.gen(function* () {
      const memory = memoryPort("after-commit");
      const store = makeActorStore(memory.port);
      const commit = yield* Effect.result(store.commit(request()));
      transactionUnknown(commit);

      const snapshot = memory.snapshot();
      assert.deepStrictEqual(snapshot.authority, initialDecision().nextAuthority);
      assert.strictEqual(snapshot.revision, 1);
      assert.strictEqual(snapshot.journalSequence, 1);
      assert.deepStrictEqual(snapshot.evidence, { _tag: "SafeEvidence", revision: 1 });
      assert.strictEqual(memory.journal().length, 1);

      const reconciled = yield* store.reconcileUnknownCommit(request());
      assert.strictEqual(reconciled.authority.revision, 1);
      assert.strictEqual(reconciled.journalEvent.sequence, 1);
    }),
  );

  it.effect("rejects corrupt authority without changing any logical write", () =>
    Effect.gen(function* () {
      let raw: RawActorStorageSnapshot = {
        authority: { invented: true },
        revision: 1,
        journalSequence: 1,
      };
      const port: ActorStoragePort = {
        read: () => Promise.resolve(raw),
        transaction: (operation) => {
          const plan: ActorStorageTransactionPlan = operation(raw);
          if (Predicate.isTagged(plan, "Commit")) {
            return Promise.reject(new Error("unexpected commit"));
          }
          return Promise.resolve(plan.outcome);
        },
      };
      const result = yield* Effect.result(makeActorStore(port).commit(request()));
      assert.ok(Result.isFailure(result));
      assert.ok(Predicate.isTagged(result.failure, "ActorStoreCorrupt"));
      assert.deepStrictEqual(raw, {
        authority: { invented: true },
        revision: 1,
        journalSequence: 1,
      });
    }),
  );

  it.effect("rejects a stale co-transactional evidence snapshot", () =>
    Effect.gen(function* () {
      const memory = memoryPort();
      const stale = request();
      const result = yield* makeActorStore(memory.port)
        .commit({
          ...stale,
          evidence: {
            _tag: "Put",
            expected: { activeJob: "stale" },
            value: { activeJob: "next" },
          },
        })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(result));
      assert.ok(Predicate.isTagged(result.failure, "ActorStoreConflict"));
      assert.strictEqual(result.failure.reason, "evidence");
      assert.deepStrictEqual(memory.snapshot(), {});
    }),
  );

  it("uses a typed unknown outcome rather than treating transaction rejection as rollback", () => {
    const error = new ActorStoreTransactionOutcomeUnknown({
      correlationId: "correlation-create",
      expectedRevision: 0,
    });
    assert.ok(Predicate.isTagged(error, "ActorStoreTransactionOutcomeUnknown"));
  });

  it.effect("turns bounded Promise interruption into an unknown commit outcome", () =>
    Effect.gen(function* () {
      let invoked = false;
      const port: ActorStoragePort = {
        read: () => Promise.resolve({}),
        transaction: (operation) => {
          invoked = true;
          operation({});
          return new Promise<ActorStorageTransactionOutcome>(() => undefined);
        },
      };
      const fiber = yield* makeActorStore(port, "5 seconds")
        .commit(request())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.strictEqual(invoked, true);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Effect.result(Fiber.join(fiber));
      assert.ok(Result.isFailure(result));
      assert.ok(Predicate.isTagged(result.failure, "ActorStoreTransactionOutcomeUnknown"));
    }),
  );

  it("rejects raw provider payload fields at the journal boundary", () => {
    const decoded = decodeLifecycleJournalEvent({
      sequence: 1,
      revision: 1,
      timestamp: T0,
      correlationId: "correlation-create",
      transitionNonce: "nonce-create",
      eventType: "admitted",
      transitionKind: "Create",
      transitionPhase: "IntentCommitted",
      resultCode: "admitted",
      causeSequence: null,
      causeAttempt: "attempt-create",
      rawProviderPayload: "forbidden",
    });
    assert.ok(Result.isFailure(decoded));
  });
});
