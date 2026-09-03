import { BackupCreateError, Sandbox } from "@cloudflare/sandbox";
import { assert, describe, expect, it } from "vitest";

const BACKUP_ID = "1ed4a6f4-7d9f-46b9-8a07-ef6d9c1dd64c";
const DIR = "/workspace/a0b1c2d3e4f5";
const NAME = "scotty-a0b1c2d3e4f5-1ed4a6f4-7d9f-46b9-8a07-ef6d9c1dd64c";
const TTL = 259_200;

const completedMetadata = (overrides = {}) => ({
  id: BACKUP_ID,
  dir: DIR,
  name: NAME,
  sizeBytes: 42,
  ttl: TTL,
  createdAt: "2026-09-02T22:00:00.000Z",
  ...overrides,
});

const invokeLocalCreate = (metadata, archiveSize = 42) => {
  const writes = [];
  const deletes = [];
  const bucket = {
    get: async () => ({ json: async () => metadata }),
    head: async () => ({ size: archiveSize }),
    put: async (...args) => writes.push(args),
    delete: async (keys) => deletes.push(keys),
    list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
  };
  const calls = [];
  const receiver = {
    ctx: { storage: { get: async () => undefined } },
    env: { BACKUP_BUCKET: bucket },
    resolveBackupCompression: (compression) => compression,
    normalizeBackupExcludes: (excludes) => excludes,
    ensureBackupSession: async () => {
      calls.push("ensureBackupSession");
      throw new Error("completed backup must be adopted before container work");
    },
    logger: {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
  };
  return {
    calls,
    deletes,
    writes,
    result: Reflect.apply(Sandbox.prototype.doCreateBackupLocal, receiver, [
      { dir: DIR, backupId: BACKUP_ID, name: NAME, ttl: TTL, localBucket: true },
    ]),
  };
};

describe("patched Sandbox deterministic backup identity", () => {
  it("adopts a complete same-ID backup without overwriting immutable objects", async () => {
    const invocation = invokeLocalCreate(completedMetadata());

    assert.deepStrictEqual(await invocation.result, {
      id: BACKUP_ID,
      dir: DIR,
      localBucket: true,
    });
    assert.deepStrictEqual(invocation.calls, []);
    assert.deepStrictEqual(invocation.writes, []);
  });

  it("rejects conflicting or incomplete same-ID state without overwriting it", async () => {
    const invocation = invokeLocalCreate(completedMetadata({ dir: "/workspace/other" }));

    await expect(invocation.result).rejects.toBeInstanceOf(BackupCreateError);
    assert.deepStrictEqual(invocation.calls, []);
    assert.deepStrictEqual(invocation.writes, []);
  });

  it("rejects a completion marker whose immutable archive is incomplete", async () => {
    const invocation = invokeLocalCreate(completedMetadata(), 41);

    await expect(invocation.result).rejects.toBeInstanceOf(BackupCreateError);
    assert.deepStrictEqual(invocation.deletes, []);
    assert.deepStrictEqual(invocation.calls, []);
    assert.deepStrictEqual(invocation.writes, []);
  });

  it("lets overlapping same-ID retries converge without writes", async () => {
    const first = invokeLocalCreate(completedMetadata());
    const second = invokeLocalCreate(completedMetadata());

    const results = await Promise.all([first.result, second.result]);
    assert.deepStrictEqual(results[0], results[1]);
    assert.deepStrictEqual([...first.writes, ...second.writes], []);
  });

  it("serializes overlapping public creates before either can finalize the same ID", async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const entered = [];
    const receiver = {
      backupInProgress: Promise.resolve(),
      enqueueBackupOp: Sandbox.prototype.enqueueBackupOp,
      doCreateBackupLocal: async () => {
        entered.push(entered.length + 1);
        if (entered.length === 1) await firstGate;
        return { id: BACKUP_ID, dir: DIR, localBucket: true };
      },
    };

    const first = Reflect.apply(Sandbox.prototype.createBackup, receiver, [
      { dir: DIR, backupId: BACKUP_ID, localBucket: true },
    ]);
    const second = Reflect.apply(Sandbox.prototype.createBackup, receiver, [
      { dir: DIR, backupId: BACKUP_ID, localBucket: true },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(entered, [1]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepStrictEqual(entered, [1, 2]);
  });

  it("persists a tombstone before queued deletion can run", async () => {
    let releaseCreate;
    const createGate = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    const events = [];
    const receiver = {
      backupInProgress: createGate,
      ctx: { storage: { put: async () => events.push("tombstone") } },
      enqueueBackupOp: Sandbox.prototype.enqueueBackupOp,
      requireBackupBucket: () => ({
        list: async () => {
          events.push("list");
          return { objects: [], truncated: false };
        },
      }),
    };

    const deletion = Reflect.apply(Sandbox.prototype.deleteBackup, receiver, [BACKUP_ID]);
    await Promise.resolve();
    assert.deepStrictEqual(events, ["tombstone"]);
    releaseCreate();
    await deletion;
    assert.deepStrictEqual(events, ["tombstone", "list"]);
  });

  it("aborts metadata publication when deletion tombstones an uploaded backup", async () => {
    let tombstoned = false;
    const deletes = [];
    const writes = [];
    const receiver = {
      ctx: { storage: { get: async () => tombstoned } },
      requireBackupBucket: () => ({
        get: async () => null,
        put: async (...args) => writes.push(args),
        delete: async (key) => deletes.push(key),
      }),
      requirePresignedURLSupport: () => undefined,
      resolveBackupCompression: (value) => value,
      normalizeBackupExcludes: (value) => value,
      ensureBackupSession: async () => "backup-session",
      client: {
        backup: { createArchive: async () => ({ success: true, sizeBytes: 42 }) },
        utils: { deleteSession: async () => undefined },
      },
      uploadBackupPresigned: async () => {
        tombstoned = true;
      },
      execWithSession: async () => undefined,
      logger: { debug() {}, error() {}, info() {}, warn() {} },
    };

    await expect(
      Reflect.apply(Sandbox.prototype.doCreateBackup, receiver, [
        { dir: DIR, backupId: BACKUP_ID, name: NAME, ttl: TTL, multipart: false },
      ]),
    ).rejects.toBeInstanceOf(BackupCreateError);
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(deletes, [
      `backups/${BACKUP_ID}/data.sqsh`,
      `backups/${BACKUP_ID}/meta.json`,
    ]);
  });
});
