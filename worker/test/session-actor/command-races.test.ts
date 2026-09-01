import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import type { AcceptedDecision, Decision } from "../../src/session-actor/decision";
import { decide } from "../../src/session-actor/reducer";
import {
  makeActorStore,
  type ActorCommitRequest,
  type ActorStoragePort,
  type RawActorStorageSnapshot,
} from "../../src/session-actor/store";

const T0 = "2026-03-02T00:00:00.000Z";
const DEADLINE = "2026-03-02T01:00:00.000Z";
const hardCap = { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" };
const session = {
  id: "session-race",
  title: "Race",
  repository: "owner/repository",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-race" },
  createdAt: T0,
};

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const create = (nonce: string): AcceptedDecision =>
  accepted(
    decide(undefined, {
      _tag: "CreateCommand",
      expectedRevision: 0,
      correlationId: `correlation-${nonce}`,
      nonce,
      attempt: `attempt-${nonce}`,
      timestamp: T0,
      deadlineAt: DEADLINE,
      session,
      hardCap,
    }),
  );

const request = (decision: AcceptedDecision): ActorCommitRequest => ({
  expectedRevision: 0,
  expectedTransitionNonce: null,
  expectedPhase: null,
  decision,
  evidence: { _tag: "Keep" },
  causeSequence: null,
});

const serializedPort = () => {
  let raw: RawActorStorageSnapshot = {};
  let tail: Promise<void> = Promise.resolve();
  const port: ActorStoragePort = {
    read: () => Promise.resolve(raw),
    transaction: (operation) => {
      const result = tail.then(() => {
        const plan = operation(raw);
        if (Predicate.isTagged(plan, "Commit")) {
          raw = {
            authority: plan.write.authority,
            revision: plan.write.revision,
            journalSequence: plan.write.journalSequence,
            journalTail: plan.write.appendJournal,
          };
        }
        return plan.outcome;
      });
      tail = result.then(() => undefined);
      return result;
    },
  };
  return { port, snapshot: () => raw };
};

describe("session actor command races", () => {
  it.effect("allows exactly one same-revision lifecycle admission to win", () =>
    Effect.gen(function* () {
      const memory = serializedPort();
      const store = makeActorStore(memory.port);
      const outcomes = yield* Effect.all(
        [store.commit(request(create("one"))), store.commit(request(create("two")))],
        { concurrency: "unbounded", mode: "result" },
      );
      assert.strictEqual(outcomes.filter(Result.isSuccess).length, 1);
      assert.strictEqual(outcomes.filter(Result.isFailure).length, 1);
      const loser = outcomes.find(Result.isFailure);
      assert.ok(loser !== undefined && Result.isFailure(loser));
      assert.ok(Predicate.isTagged(loser.failure, "ActorStoreConflict"));
      assert.strictEqual(memory.snapshot().revision, 1);
    }),
  );

  it.effect("rejects stale revision, transition nonce, and phase fences", () =>
    Effect.gen(function* () {
      const memory = serializedPort();
      const store = makeActorStore(memory.port);
      const winner = create("winner");
      yield* store.commit(request(winner));
      const next = accepted(
        decide(winner.nextAuthority, {
          _tag: "VaporizeCommand",
          expectedRevision: 1,
          correlationId: "vaporize",
          nonce: "vaporize",
          attempt: "vaporize-attempt",
          timestamp: T0,
          deadlineAt: DEADLINE,
        }),
      );
      const staleRevision = yield* Effect.result(store.commit(request(create("stale"))));
      assert.ok(Result.isFailure(staleRevision));
      assert.deepInclude(staleRevision.failure, { reason: "revision" });

      const staleNonce = yield* Effect.result(
        store.commit({
          ...request(next),
          expectedRevision: 1,
          expectedTransitionNonce: "wrong",
          expectedPhase: "IntentCommitted",
        }),
      );
      assert.ok(Result.isFailure(staleNonce));
      assert.deepInclude(staleNonce.failure, { reason: "nonce" });

      const stalePhase = yield* Effect.result(
        store.commit({
          ...request(next),
          expectedRevision: 1,
          expectedTransitionNonce: "winner",
          expectedPhase: "wrong",
        }),
      );
      assert.ok(Result.isFailure(stalePhase));
      assert.deepInclude(stalePhase.failure, { reason: "phase" });
    }),
  );
});
