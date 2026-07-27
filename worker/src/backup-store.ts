import type { BackupOptions, RestoreBackupResult } from "@cloudflare/sandbox";
import { Context, Data, Effect, Layer, Schedule } from "effect";
import type { DirectoryBackup } from "./contracts";

type BackupOperation = "create" | "delete" | "list" | "restore";
const CREATE_RETRY_DELAY = "1 second";

export class BackupStoreFailure extends Data.TaggedError("BackupStoreFailure")<{
  readonly operation: BackupOperation;
}> {}

export interface BackupObjectPage {
  readonly keys: ReadonlyArray<string>;
  readonly cursor?: string;
}

export interface BackupCapabilities {
  readonly createBackup: (options: BackupOptions) => Promise<DirectoryBackup>;
  readonly restoreBackup: (backup: DirectoryBackup) => Promise<RestoreBackupResult>;
  readonly listObjects: (prefix: string, cursor?: string) => Promise<BackupObjectPage>;
  readonly deleteObjects: (keys: ReadonlyArray<string>) => Promise<void>;
}

interface BackupStoreShape {
  readonly create: (options: BackupOptions) => Effect.Effect<DirectoryBackup, BackupStoreFailure>;
  readonly restore: (backup: DirectoryBackup) => Effect.Effect<void, BackupStoreFailure>;
  readonly delete: (backupId: string) => Effect.Effect<void, BackupStoreFailure>;
}

export class BackupStore extends Context.Service<BackupStore, BackupStoreShape>()(
  "scotty/BackupStore",
) {}

export const backupStoreLayer = <E = never>(
  capabilities: BackupCapabilities,
  beforeOperation?: Effect.Effect<void, E>,
): Layer.Layer<BackupStore> =>
  Layer.succeed(BackupStore)(makeBackupStore(capabilities, beforeOperation ?? Effect.void));

const makeBackupStore = <E>(
  capabilities: BackupCapabilities,
  beforeOperation: Effect.Effect<void, E>,
): BackupStoreShape => {
  const failure = (operation: BackupOperation): BackupStoreFailure =>
    new BackupStoreFailure({ operation });
  const guard = (operation: BackupOperation): Effect.Effect<void, BackupStoreFailure> =>
    beforeOperation.pipe(Effect.mapError(() => failure(operation)));

  return BackupStore.of({
    create: (options) =>
      guard("create").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => capabilities.createBackup(options),
            catch: () => failure("create"),
          }),
        ),
        // The SDK uses a fresh session and cleans partial R2 objects before a create rejection.
        Effect.retry({
          schedule: Schedule.spaced(CREATE_RETRY_DELAY),
          times: 1,
        }),
      ),
    restore: (backup) =>
      guard("restore").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => capabilities.restoreBackup(backup),
            catch: () => failure("restore"),
          }),
        ),
        Effect.asVoid,
      ),
    delete: Effect.fnUntraced(function* (backupId) {
      const prefix = `backups/${backupId}/`;
      let cursor: string | undefined;
      do {
        const page = yield* Effect.tryPromise({
          try: () => capabilities.listObjects(prefix, cursor),
          catch: () => failure("list"),
        });
        if (page.keys.length > 0) {
          yield* Effect.tryPromise({
            try: () => capabilities.deleteObjects(page.keys),
            catch: () => failure("delete"),
          });
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
    }),
  });
};
