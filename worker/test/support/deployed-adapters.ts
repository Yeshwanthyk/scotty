import type { BackupOptions, RestoreBackupResult } from "@cloudflare/sandbox";
import { assert } from "@effect/vitest";
import { Schema } from "effect";
import type { BackupCapabilities } from "../../src/backups/store";
import { DirectoryBackupSchema, type DirectoryBackup } from "../../src/session/contracts";

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};

const env = process.env;

const AckSchema = Schema.Struct({ ok: Schema.Literal(true) });
const RestoreBackupResultSchema = Schema.Struct({
  success: Schema.Boolean,
  dir: Schema.String,
  id: Schema.String,
});
const decodeAck = Schema.decodeUnknownPromise(AckSchema);
const decodeDirectoryBackup = Schema.decodeUnknownPromise(DirectoryBackupSchema);
const decodeRestoreBackupResult = Schema.decodeUnknownPromise(RestoreBackupResultSchema);

const deployedGateEnabled =
  env.SCOTTY_E2E_DEPLOYED === "1" &&
  env.SCOTTY_E2E_CONFIRM_DESTRUCTIVE === "YES" &&
  Boolean(env.SCOTTY_E2E_TOKEN);

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
      deleteBackup: async (backupId: string): Promise<void> => {
        await initialize();
        await decodeAck(
          await request(url, {
            adapter: "backup-store",
            operation: "delete",
            namespace,
            backupId,
          }),
        );
      },
    },
  };
};
