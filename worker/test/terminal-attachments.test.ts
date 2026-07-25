import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { TerminalAttachmentLease } from "../src/contracts";
import type { CreateIdempotencyMetadata } from "../src/create-idempotency";
import { SessionStore, sessionStoreLayer, type SessionRecordStorage } from "../src/session-store";
import { createSessionHarness, SESSION_ID, sessionHarnessKeys } from "./session-harness";
import {
  TerminalAttachments,
  TERMINAL_ATTACHMENT_TTL_MS,
  terminalAttachmentCleanupBestEffort,
  terminalAttachmentsLayer,
  type TerminalAttachmentStorage,
  type TerminalAttachmentsShape,
} from "../src/terminal-attachments";
import { InMemoryFaultInjectableFake, makeSessionRecord } from "./support";

const NOW = Date.parse("2026-04-05T06:07:08.000Z");
const InitialSessionStorageStateSchema = Schema.Struct({
  record: Schema.optionalKey(Schema.Unknown),
  idempotency: Schema.optionalKey(Schema.Unknown),
});
const decodeInitialSessionStorageState = Schema.decodeUnknownSync(InitialSessionStorageStateSchema);

const makeStorage = (
  initial?: ReadonlyArray<TerminalAttachmentLease> | unknown,
): {
  readonly memory: InMemoryFaultInjectableFake;
  readonly storage: TerminalAttachmentStorage;
} => {
  const memory = new InMemoryFaultInjectableFake(initial);
  return {
    memory,
    storage: {
      get: () => memory.invoke("get", [], () => memory.snapshot()),
      delete: () =>
        memory.invoke("delete", [], () => {
          memory.value = undefined;
        }),
      transaction: (operation) =>
        memory.transaction((transaction) =>
          operation({
            get: transaction.get,
            put: (attachments) => transaction.put(attachments),
          }),
        ),
    },
  };
};

const withAttachments = <A, E>(
  storage: TerminalAttachmentStorage,
  effect: Effect.Effect<A, E, TerminalAttachments>,
): Effect.Effect<A, E> => Effect.provide(effect, terminalAttachmentsLayer(storage));

const useAttachments = <A, E>(
  storage: TerminalAttachmentStorage,
  use: (attachments: TerminalAttachmentsShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => withAttachments(storage, Effect.flatMap(TerminalAttachments, use));

const makeInitialSessionStorage = (): {
  readonly memory: InMemoryFaultInjectableFake;
  readonly storage: SessionRecordStorage;
} => {
  const memory = new InMemoryFaultInjectableFake({});

  const withState = async <A>(
    operation: (state: {
      readonly getRecord: () => unknown | undefined;
      readonly setRecord: (value: unknown | undefined) => void;
      readonly getIdempotency: () => unknown | undefined;
      readonly setIdempotency: (value: unknown | undefined) => void;
    }) => Promise<A>,
  ): Promise<A> =>
    memory.transaction(async (stateTransaction) => {
      const stored = decodeInitialSessionStorageState(await stateTransaction.get());
      let record = stored.record;
      let idempotency = stored.idempotency;
      const result = await operation({
        getRecord: () => structuredClone(record),
        setRecord: (next) => {
          record = structuredClone(next);
        },
        getIdempotency: () => structuredClone(idempotency),
        setIdempotency: (next) => {
          idempotency = structuredClone(next);
        },
      });
      await stateTransaction.put({
        ...(record === undefined ? {} : { record }),
        ...(idempotency === undefined ? {} : { idempotency }),
      });
      return result;
    });

  return {
    memory,
    storage: {
      get: async () => decodeInitialSessionStorageState(memory.snapshot()).record,
      put: (record) =>
        withState(async (state) => {
          state.setRecord(record);
        }),
      transaction: (operation) =>
        withState((state) =>
          operation({
            get: async () => state.getRecord(),
            put: async (record) => {
              state.setRecord(record);
            },
          }),
        ),
      initialSessionTransaction: (operation) =>
        withState((state) =>
          operation({
            getRecord: async () => state.getRecord(),
            getCreateIdempotency: async () => state.getIdempotency(),
            putRecord: async (record) => {
              state.setRecord(record);
            },
            putCreateIdempotency: async (metadata) => {
              state.setIdempotency(metadata);
            },
            deleteCreateIdempotency: async () => {
              state.setIdempotency(undefined);
            },
          }),
        ),
    },
  };
};

describe("TerminalAttachments", () => {
  it("kills the isolated PTY process before deleting its execution session and lease", async () => {
    const clientId = "123456abcdef";
    const sessionId = `scotty-web-${clientId}`;
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({ id: SESSION_ID }),
        [sessionHarnessKeys.terminalAttachments]: [
          {
            sessionId,
            status: "active",
            lastSeenAt: "2026-04-05T06:07:08.000Z",
            createSettled: true,
          },
        ],
      },
      initialExecutionSessions: [sessionId],
    });

    await harness.sandbox.releaseTerminalAttachment(clientId);

    const killIndex = harness.events.indexOf(`host:killAllProcesses:${sessionId}`);
    const deleteIndex = harness.events.indexOf("host:deleteSession");
    assert.ok(killIndex >= 0);
    assert.ok(killIndex < deleteIndex);
    assert.deepStrictEqual(harness.read(sessionHarnessKeys.terminalAttachments), []);
  });

  it.effect("transitions creating leases to active and updates activity with Clock", () =>
    Effect.gen(function* () {
      const { storage } = makeStorage();
      yield* TestClock.setTime(NOW);
      const creating = yield* useAttachments(storage, (attachments) =>
        attachments.begin("scotty-web-a0b1c2d3e4f5"),
      );
      assert.deepStrictEqual(creating, {
        sessionId: "scotty-web-a0b1c2d3e4f5",
        status: "creating",
        lastSeenAt: "2026-04-05T06:07:08.000Z",
        createSettled: false,
      });

      const active = yield* useAttachments(storage, (attachments) =>
        attachments.activate(creating.sessionId),
      );
      assert.deepInclude(active, { status: "active", createSettled: true });

      yield* TestClock.adjust("1 second");
      const touched = yield* useAttachments(storage, (attachments) =>
        attachments.touch(creating.sessionId),
      );
      assert.strictEqual(touched?.lastSeenAt, "2026-04-05T06:07:09.000Z");
    }),
  );

  it.effect("preserves a concurrent release while creation settles", () =>
    Effect.gen(function* () {
      const { storage } = makeStorage();
      yield* TestClock.setTime(NOW);
      const creating = yield* useAttachments(storage, (attachments) =>
        attachments.begin("scotty-web-a0b1c2d3e4f5"),
      );
      const releasing = yield* useAttachments(storage, (attachments) =>
        attachments.requestRelease(creating.sessionId, {
          kind: "observedAt",
          value: creating.lastSeenAt,
        }),
      );
      assert.deepInclude(releasing, { status: "releasing", createSettled: false });

      const activated = yield* useAttachments(storage, (attachments) =>
        attachments.activate(creating.sessionId),
      );
      assert.deepInclude(activated, { status: "releasing", createSettled: true });
    }),
  );

  it.effect("settles releasing creates and keeps conditional release fencing atomic", () =>
    Effect.gen(function* () {
      const { storage } = makeStorage();
      yield* TestClock.setTime(NOW);
      const lease = yield* useAttachments(storage, (attachments) =>
        attachments.begin("scotty-web-a0b1c2d3e4f5"),
      );
      assert.strictEqual(
        yield* useAttachments(storage, (attachments) =>
          attachments.requestRelease(lease.sessionId, {
            kind: "observedAt",
            value: "2026-04-05T06:07:07.000Z",
          }),
        ),
        undefined,
      );

      yield* useAttachments(storage, (attachments) => attachments.requestRelease(lease.sessionId));
      const settled = yield* useAttachments(storage, (attachments) =>
        attachments.settleCreate(lease.sessionId),
      );
      assert.deepInclude(settled, { status: "releasing", createSettled: true });

      const finalized = yield* useAttachments(storage, (attachments) =>
        attachments.finalizeRelease(lease.sessionId, {
          kind: "observedAt",
          value: "different-observation",
        }),
      );
      assert.strictEqual(finalized?.status, "releasing");
    }),
  );

  it.effect("rejects duplicate and over-capacity leases without mutation", () =>
    Effect.gen(function* () {
      const leases = Array.from({ length: 8 }, (_, index) => ({
        sessionId: `scotty-web-${index.toString(16).padStart(12, "0")}`,
        status: "active" as const,
        lastSeenAt: "2026-04-05T06:07:08.000Z",
        createSettled: true,
      }));
      const { storage } = makeStorage(leases);
      const duplicate = yield* Effect.result(
        useAttachments(storage, (attachments) => attachments.begin(leases[0].sessionId)),
      );
      assert.ok(Result.isFailure(duplicate));
      assert.deepInclude(duplicate.failure, {
        code: "conflict",
        message: "Terminal attachment already exists",
      });

      const full = yield* Effect.result(
        useAttachments(storage, (attachments) => attachments.begin("scotty-web-ffffffffffff")),
      );
      assert.ok(Result.isFailure(full));
      assert.deepInclude(full.failure, {
        code: "conflict",
        message: "Too many terminal attachments",
      });
      assert.deepStrictEqual(
        yield* useAttachments(storage, (attachments) => attachments.read),
        leases,
      );
    }),
  );

  it.effect("finds only expired non-releasing leases and filters invalid persisted IDs", () =>
    Effect.gen(function* () {
      const old = new Date(NOW - TERMINAL_ATTACHMENT_TTL_MS).toISOString();
      const recent = new Date(NOW - TERMINAL_ATTACHMENT_TTL_MS + 1).toISOString();
      const { storage } = makeStorage([
        {
          sessionId: "scotty-web-000000000001",
          status: "active",
          lastSeenAt: old,
          createSettled: true,
        },
        {
          sessionId: "scotty-web-000000000002",
          status: "active",
          lastSeenAt: recent,
          createSettled: true,
        },
        {
          sessionId: "scotty-web-000000000003",
          status: "releasing",
          lastSeenAt: old,
          createSettled: true,
        },
        {
          sessionId: "invalid",
          status: "active",
          lastSeenAt: old,
          createSettled: true,
        },
      ]);
      yield* TestClock.setTime(NOW);
      assert.deepStrictEqual(yield* useAttachments(storage, (attachments) => attachments.expired), [
        {
          sessionId: "scotty-web-000000000001",
          status: "active",
          lastSeenAt: old,
          createSettled: true,
        },
      ]);
    }),
  );

  it.effect("removes leases, clears persisted state, and exposes typed storage failures", () =>
    Effect.gen(function* () {
      const lease: TerminalAttachmentLease = {
        sessionId: "scotty-web-a0b1c2d3e4f5",
        status: "active",
        lastSeenAt: "2026-04-05T06:07:08.000Z",
        createSettled: true,
      };
      const { memory, storage } = makeStorage([lease]);
      yield* useAttachments(storage, (attachments) => attachments.remove(lease.sessionId));
      assert.deepStrictEqual(yield* useAttachments(storage, (attachments) => attachments.read), []);

      memory.injectFailure("delete", { times: 1 });
      const failed = yield* Effect.result(
        useAttachments(storage, (attachments) => attachments.clear),
      );
      assert.ok(Result.isFailure(failed));
      assert.deepInclude(failed.failure, {
        _tag: "TerminalAttachmentsFailure",
        reason: "storage",
        operation: "clear",
      });

      yield* useAttachments(storage, (attachments) => attachments.clear);
      assert.strictEqual(memory.snapshot(), undefined);
    }),
  );

  it.effect("logs cleanup failures and returns success for best-effort release", () =>
    Effect.gen(function* () {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>((options) => {
        messages.push(options.message);
      });
      yield* terminalAttachmentCleanupBestEffort(
        "scotty-web-a0b1c2d3e4f5",
        Effect.fail("delete failed"),
      ).pipe(Effect.provide(Logger.layer([logger])));
      assert.include(JSON.stringify(messages), "Terminal attachment cleanup failed");
    }),
  );
});

describe("SessionStore create idempotency", () => {
  it.effect("atomically persists create metadata and replays only the matching request", () =>
    Effect.gen(function* () {
      const { memory, storage } = makeInitialSessionStorage();
      const record = makeSessionRecord({ status: "booting" });
      const metadata = {
        keyDigest: "a".repeat(64),
        inputDigest: "b".repeat(64),
      } satisfies CreateIdempotencyMetadata;
      const createInitial = (incoming: CreateIdempotencyMetadata) =>
        Effect.provide(
          Effect.flatMap(SessionStore, (store) => store.createInitial(record, incoming)),
          sessionStoreLayer(storage),
        );

      assert.deepStrictEqual(yield* createInitial(metadata), { kind: "create" });
      assert.deepStrictEqual(decodeInitialSessionStorageState(memory.snapshot()), {
        record,
        idempotency: metadata,
      });

      assert.deepStrictEqual(yield* createInitial(metadata), { kind: "replay", record });
      const conflict = yield* Effect.result(
        createInitial({ ...metadata, inputDigest: "c".repeat(64) }),
      );
      assert.ok(Result.isFailure(conflict));
      assert.deepInclude(conflict.failure, {
        code: "conflict",
        message: `Session ${record.id} already exists`,
      });
      assert.deepStrictEqual(decodeInitialSessionStorageState(memory.snapshot()), {
        record,
        idempotency: metadata,
      });
    }),
  );
});
