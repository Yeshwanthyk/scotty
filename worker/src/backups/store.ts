import type { BackupOptions, RestoreBackupResult } from "@cloudflare/sandbox";
import { Context, Data, Effect, Layer } from "effect";
import type { DirectoryBackup } from "../session/contracts";

type BackupOperation = "create" | "delete" | "restore";

export class BackupStoreFailure extends Data.TaggedError("BackupStoreFailure")<{
  readonly operation: BackupOperation;
}> {}

export interface BackupCapabilities {
  readonly createBackup: (options: BackupOptions) => Promise<DirectoryBackup>;
  readonly restoreBackup: (backup: DirectoryBackup) => Promise<RestoreBackupResult>;
  readonly deleteBackup: (backupId: string) => Promise<void>;
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
  beforeRuntimeOperation?: Effect.Effect<void, E>,
): Layer.Layer<BackupStore> =>
  Layer.succeed(BackupStore)(makeBackupStore(capabilities, beforeRuntimeOperation ?? Effect.void));

const makeBackupStore = <E>(
  capabilities: BackupCapabilities,
  beforeRuntimeOperation: Effect.Effect<void, E>,
): BackupStoreShape => {
  const failure = (operation: BackupOperation): BackupStoreFailure =>
    new BackupStoreFailure({ operation });
  const guard = (operation: BackupOperation): Effect.Effect<void, BackupStoreFailure> =>
    beforeRuntimeOperation.pipe(Effect.mapError(() => failure(operation)));

  return BackupStore.of({
    create: (options) =>
      guard("create").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => capabilities.createBackup(options),
            catch: () => failure("create"),
          }),
        ),
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
    delete: (backupId) =>
      Effect.tryPromise({
        try: () => capabilities.deleteBackup(backupId),
        catch: () => failure("delete"),
      }),
  });
};
