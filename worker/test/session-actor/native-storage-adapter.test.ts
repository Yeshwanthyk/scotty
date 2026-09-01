import { assert, describe, it } from "@effect/vitest";
import { Predicate, Result } from "effect";
import type { AcceptedDecision, Decision } from "../../src/session-actor/decision";
import { makeLifecycleJournalEvent } from "../../src/session-actor/journal";
import { decide } from "../../src/session-actor/reducer";
import type { ActorStorageTransactionPlan, EvidenceMutation } from "../../src/session-actor/store";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
import {
  durableObjectSessionActorMetadataStorage,
  durableObjectSessionActorStorage,
  SESSION_ACTOR_AUTHORITY_KEY,
  SESSION_ACTOR_EVIDENCE_KEY,
  SESSION_ACTOR_JOURNAL_SEQUENCE_KEY,
  SESSION_ACTOR_JOURNAL_TAIL_KEY,
  SESSION_ACTOR_METADATA_KEY,
  SESSION_ACTOR_REVISION_KEY,
} from "../../src/session/store";

const T0 = "2026-03-01T00:00:00.000Z";
const DEADLINE = "2026-03-01T01:00:00.000Z";
const JOURNAL_PREFIX = "scotty:session-actor:journal:";

const journalKey = (sequence: number): string =>
  `${JOURNAL_PREFIX}${String(sequence).padStart(16, "0")}`;

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const initialDecision = (): AcceptedDecision =>
  accepted(
    decide(undefined, {
      _tag: "CreateCommand",
      expectedRevision: 0,
      correlationId: "correlation-native-storage",
      nonce: "nonce-native-storage",
      attempt: "attempt-native-storage",
      timestamp: T0,
      deadlineAt: DEADLINE,
      session: {
        id: "session-native-storage",
        title: "Native storage",
        repository: "owner/repository",
        execution: { provider: "cloudflare", runtimeName: "runtime-native-storage" },
        createdAt: T0,
      },
    }),
  );

const commitPlan = (
  evidence: EvidenceMutation,
  sequence = 1,
): Extract<ActorStorageTransactionPlan, { readonly _tag: "Commit" }> => {
  const decision = initialDecision();
  const event = makeLifecycleJournalEvent(
    sequence,
    sequence,
    decision.journalEvent,
    sequence === 1 ? null : sequence - 1,
  );
  assert.ok(Result.isSuccess(event));
  return {
    _tag: "Commit",
    write: {
      authority: { ...decision.nextAuthority, revision: sequence },
      revision: sequence,
      journalSequence: sequence,
      appendJournal: event.success,
      evidence,
    },
    outcome: { _tag: "Committed" },
  };
};

class FakeDurableObjectStorage {
  readonly calls = { transactions: 0, puts: 0, deletes: 0 };
  private values = new Map<string, unknown>();
  beforeTransaction: (ordinal: number) => Promise<void> = () => Promise.resolve();

  seed(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  inspect(key: string): unknown | undefined {
    return this.values.get(key);
  }

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  entries(): ReadonlyArray<readonly [string, unknown]> {
    return [...this.values.entries()];
  }

  async transaction<A>(
    operation: (transaction: DurableObjectTransaction) => Promise<A>,
  ): Promise<A> {
    this.calls.transactions += 1;
    const ordinal = this.calls.transactions;
    await this.beforeTransaction(ordinal);
    const draft = new Map(this.values);
    const transaction = {
      get: <T>(key: string): Promise<T | undefined> =>
        Promise.resolve(draft.get(key) as T | undefined),
      put: (key: string, value: unknown): Promise<void> => {
        this.calls.puts += 1;
        draft.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string): Promise<boolean> => {
        this.calls.deletes += 1;
        return Promise.resolve(draft.delete(key));
      },
    };
    // oxlint-disable-next-line scotty/no-double-cast -- boundary: this fake supplies exactly the native transaction capabilities used by the adapter
    const result = await operation(transaction as unknown as DurableObjectTransaction);
    this.values = draft;
    return result;
  }
}

const actorStorage = (storage: FakeDurableObjectStorage) => {
  // oxlint-disable-next-line scotty/no-double-cast -- boundary: this fake supplies exactly the native storage capabilities used by the adapter
  return durableObjectSessionActorStorage(storage as unknown as DurableObjectStorage);
};

describe("native Durable Object session actor storage adapter", () => {
  it("stores private companion metadata only when its transaction decides to write", async () => {
    const native = new FakeDurableObjectStorage();
    const port = durableObjectSessionActorMetadataStorage(
      // oxlint-disable-next-line scotty/no-double-cast -- boundary: this fake supplies exactly the native storage capabilities used by the adapter
      native as unknown as DurableObjectStorage,
    );
    const value: SessionActorMetadata = {
      sessionId: "session-native-storage",
      repository: "owner/repository",
      branch: "scotty/session-native-storage",
      createRepositoryIfMissing: false,
      hardCap: {
        durationSeconds: 3600,
        deadlineAt: DEADLINE,
        generation: "hard-cap-native-storage",
      },
      createIdempotency: null,
      createAttempt: "attempt-native-storage",
      privateCreateInput: {
        attempt: "attempt-native-storage",
        payload: { reference: "payload-native-storage" },
        initialPrompt: "private",
      },
      createObservations: { workspace: null, bundle: null, credentialGrants: null },
    };

    assert.deepStrictEqual(
      await port.transaction(() => ({
        _tag: "Put",
        value,
        outcome: { _tag: "Created", metadata: value },
      })),
      { _tag: "Created", metadata: value },
    );
    assert.deepStrictEqual(await port.read(), value);

    assert.deepStrictEqual(
      await port.transaction((current) => {
        assert.deepStrictEqual(current, value);
        return {
          _tag: "NoWrite",
          outcome: { _tag: "IdempotentReplay", metadata: value },
        };
      }),
      { _tag: "IdempotentReplay", metadata: value },
    );
    assert.deepStrictEqual(native.inspect(SESSION_ACTOR_METADATA_KEY), value);
  });

  it("maps an atomic commit to authority, revision, journal, and evidence storage", async () => {
    const native = new FakeDurableObjectStorage();
    const port = actorStorage(native);
    const plan = commitPlan({ _tag: "Put", value: { state: "collecting" } });

    assert.deepStrictEqual(await port.transaction(() => plan), { _tag: "Committed" });
    assert.deepStrictEqual(native.inspect(SESSION_ACTOR_AUTHORITY_KEY), plan.write.authority);
    assert.strictEqual(native.inspect(SESSION_ACTOR_REVISION_KEY), 1);
    assert.strictEqual(native.inspect(SESSION_ACTOR_JOURNAL_SEQUENCE_KEY), 1);
    assert.deepStrictEqual(
      native.inspect(SESSION_ACTOR_JOURNAL_TAIL_KEY),
      plan.write.appendJournal,
    );
    assert.deepStrictEqual(native.inspect(journalKey(1)), plan.write.appendJournal);
    assert.deepStrictEqual(native.inspect(SESSION_ACTOR_EVIDENCE_KEY), { state: "collecting" });

    assert.deepStrictEqual(await port.read(), {
      authority: plan.write.authority,
      revision: 1,
      journalSequence: 1,
      journalTail: plan.write.appendJournal,
      evidence: { state: "collecting" },
    });
  });

  it("deletes evidence in the same transaction as the next authority commit", async () => {
    const native = new FakeDurableObjectStorage();
    const port = actorStorage(native);
    await port.transaction(() => commitPlan({ _tag: "Put", value: { state: "ready" } }));
    const deletion = commitPlan({ _tag: "Delete" }, 2);

    assert.deepStrictEqual(await port.transaction(() => deletion), { _tag: "Committed" });
    assert.strictEqual(native.inspect(SESSION_ACTOR_EVIDENCE_KEY), undefined);
    assert.strictEqual(native.inspect(SESSION_ACTOR_REVISION_KEY), 2);
    assert.deepStrictEqual(native.inspect(journalKey(2)), deletion.write.appendJournal);
  });

  it("returns NoCommit outcomes without performing any logical write", async () => {
    const native = new FakeDurableObjectStorage();
    native.seed(SESSION_ACTOR_REVISION_KEY, 7);
    const before = native.entries();
    const port = actorStorage(native);

    const outcome = await port.transaction(() => ({
      _tag: "NoCommit",
      outcome: { _tag: "Conflict", reason: "revision", actualRevision: 7 },
    }));

    assert.deepStrictEqual(outcome, {
      _tag: "Conflict",
      reason: "revision",
      actualRevision: 7,
    });
    assert.deepStrictEqual(native.entries(), before);
    assert.strictEqual(native.calls.puts, 0);
    assert.strictEqual(native.calls.deletes, 0);
  });

  it("aborts the whole transaction rather than overwriting an immutable journal event", async () => {
    const native = new FakeDurableObjectStorage();
    native.seed(journalKey(1), { existing: true });
    const before = native.entries();
    const port = actorStorage(native);

    const rejected = await port
      .transaction(() => commitPlan({ _tag: "Keep" }))
      .then(
        () => false,
        () => true,
      );
    assert.strictEqual(rejected, true);
    assert.deepStrictEqual(native.entries(), before);
  });

  it("serializes transactions through the shared control gate", async () => {
    const native = new FakeDurableObjectStorage();
    let releaseFirst = (): void => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    native.beforeTransaction = (ordinal) => (ordinal === 1 ? firstBlocked : Promise.resolve());
    const port = actorStorage(native);
    const noCommit = (): ActorStorageTransactionPlan => ({
      _tag: "NoCommit",
      outcome: { _tag: "Conflict", reason: "revision", actualRevision: 0 },
    });

    const first = port.transaction(noCommit);
    const second = port.transaction(noCommit);
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(native.calls.transactions, 1);

    releaseFirst();
    await Promise.all([first, second]);
    assert.strictEqual(native.calls.transactions, 2);
  });
});
