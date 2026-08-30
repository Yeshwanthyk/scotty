import type { BackupOptions, RestoreBackupResult } from "@cloudflare/sandbox";
import { assert } from "@effect/vitest";
import { Schema } from "effect";
import type { BackupCapabilities, BackupObjectPage } from "../../src/backups/store";
import { DirectoryBackupSchema, type DirectoryBackup } from "../../src/session/contracts";
import type { SessionRecordStorage, SessionRecordTransaction } from "../../src/session/store";

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};

const env = process.env;

const AckSchema = Schema.Struct({ ok: Schema.Literal(true) });
const StoredValueSchema = Schema.Struct({
  value: Schema.optionalKey(Schema.Unknown),
  revision: Schema.String,
});
const CompareAndSetSchema = Schema.Struct({
  applied: Schema.Boolean,
  revision: Schema.String,
});
const RestoreBackupResultSchema = Schema.Struct({
  success: Schema.Boolean,
  dir: Schema.String,
  id: Schema.String,
});
const BackupObjectPageSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
});
const decodeAck = Schema.decodeUnknownPromise(AckSchema);
const decodeStoredValue = Schema.decodeUnknownPromise(StoredValueSchema);
const decodeCompareAndSet = Schema.decodeUnknownPromise(CompareAndSetSchema);
const decodeDirectoryBackup = Schema.decodeUnknownPromise(DirectoryBackupSchema);
const decodeRestoreBackupResult = Schema.decodeUnknownPromise(RestoreBackupResultSchema);
const decodeBackupObjectPage = Schema.decodeUnknownPromise(BackupObjectPageSchema);

const deployedGateEnabled =
  env.SCOTTY_E2E_DEPLOYED === "1" &&
  env.SCOTTY_E2E_CONFIRM_DESTRUCTIVE === "YES" &&
  Boolean(env.SCOTTY_E2E_TOKEN);

export const deployedSessionRecordStorageEnabled =
  deployedGateEnabled && Boolean(env.SCOTTY_E2E_SESSION_RECORD_STORAGE_URL);

export const deployedBackupStoreEnabled =
  deployedGateEnabled && Boolean(env.SCOTTY_E2E_BACKUP_STORE_URL);

const request = async (url: string, body: object): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SCOTTY_E2E_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `Deployed adapter harness returned HTTP ${response.status}`);
  return response.json();
};

const namespaceId = (kind: string): string => `${kind}-${crypto.randomUUID()}`;

export const makeDeployedSessionRecordStorage = (
  initial?: unknown,
): { readonly storage: SessionRecordStorage } => {
  const url = env.SCOTTY_E2E_SESSION_RECORD_STORAGE_URL;
  assert.ok(url, "SCOTTY_E2E_SESSION_RECORD_STORAGE_URL is required");
  const namespace = namespaceId("session-record");
  let initialized: Promise<void> | undefined;

  const initialize = (): Promise<void> => {
    initialized ??= request(url, {
      adapter: "session-record-storage",
      operation: "reset",
      namespace,
      ttlSeconds: 900,
      ...(initial === undefined ? {} : { initial }),
    }).then(async (value) => {
      await decodeAck(value);
    });
    return initialized;
  };

  const readStored = async (): Promise<{
    readonly value: unknown;
    readonly revision: string;
  }> => {
    await initialize();
    const decoded = await decodeStoredValue(
      await request(url, {
        adapter: "session-record-storage",
        operation: "get",
        namespace,
      }),
    );
    return { value: decoded.value, revision: decoded.revision };
  };

  return {
    storage: {
      get: async () => (await readStored()).value,
      deleteCreateIdempotency: async () => {
        await initialize();
        await decodeAck(
          await request(url, {
            adapter: "session-record-storage",
            operation: "delete-create-idempotency",
            namespace,
          }),
        );
      },
      put: async (record) => {
        await initialize();
        await decodeAck(
          await request(url, {
            adapter: "session-record-storage",
            operation: "put",
            namespace,
            value: record,
          }),
        );
      },
      transaction: async <A>(
        operation: (transaction: SessionRecordTransaction) => Promise<A>,
      ): Promise<A> => {
        for (;;) {
          const current = await readStored();
          let staged = current.value;
          const result = await operation({
            get: async () => structuredClone(staged),
            put: async (record) => {
              staged = structuredClone(record);
            },
          });
          const committed = await decodeCompareAndSet(
            await request(url, {
              adapter: "session-record-storage",
              operation: "compare-and-set",
              namespace,
              expectedRevision: current.revision,
              value: staged,
            }),
          );
          if (committed.applied) return result;
        }
      },
    },
  };
};

export interface BackupCapabilitiesContract {
  readonly capabilities: BackupCapabilities;
  readonly dir: string;
}

export const makeDeployedBackupCapabilities = (): BackupCapabilitiesContract => {
  const url = env.SCOTTY_E2E_BACKUP_STORE_URL;
  assert.ok(url, "SCOTTY_E2E_BACKUP_STORE_URL is required");
  const namespace = namespaceId("backup-store");
  const dir = `/workspace/${namespace}`;
  let initialized: Promise<void> | undefined;

  const initialize = (): Promise<void> => {
    initialized ??= request(url, {
      adapter: "backup-store",
      operation: "reset",
      namespace,
      dir,
      ttlSeconds: 900,
    }).then(async (value) => {
      await decodeAck(value);
    });
    return initialized;
  };

  return {
    dir,
    capabilities: {
      createBackup: async (options: BackupOptions): Promise<DirectoryBackup> => {
        await initialize();
        return decodeDirectoryBackup(
          await request(url, {
            adapter: "backup-store",
            operation: "create",
            namespace,
            options,
          }),
        );
      },
      restoreBackup: async (backup: DirectoryBackup): Promise<RestoreBackupResult> => {
        await initialize();
        return decodeRestoreBackupResult(
          await request(url, {
            adapter: "backup-store",
            operation: "restore",
            namespace,
            backup,
          }),
        );
      },
      listObjects: async (prefix: string, cursor?: string): Promise<BackupObjectPage> => {
        await initialize();
        return decodeBackupObjectPage(
          await request(url, {
            adapter: "backup-store",
            operation: "list",
            namespace,
            prefix,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
      },
      deleteObjects: async (keys: ReadonlyArray<string>): Promise<void> => {
        await initialize();
        await decodeAck(
          await request(url, {
            adapter: "backup-store",
            operation: "delete",
            namespace,
            keys,
          }),
        );
      },
    },
  };
};
