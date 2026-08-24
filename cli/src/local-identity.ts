import { Data, Effect } from "effect";
import {
  CliRuntime,
  CredentialStore,
  CredentialStoreFailure,
  FileSystem,
  type PrivateFileError,
} from "./services";
import {
  clientCredentialPath,
  rootCredentialPath,
  scottyStateRoot,
  type LocalCredentialName,
} from "./local-paths";

export type LocalIdentityKind = LocalCredentialName;

export interface RootIdentity {
  readonly kind: "root";
  readonly credential: string;
}

export interface ClientIdentity {
  readonly kind: "client";
  readonly credential: string;
}

export type LocalIdentity = RootIdentity | ClientIdentity;

export class LocalIdentityError extends Data.TaggedError("LocalIdentityError")<{
  readonly kind: LocalIdentityKind;
  readonly operation: "load" | "save" | "remove";
  readonly path: string;
  readonly reason:
    | "empty"
    | "credential_store_corrupt"
    | "credential_store_permission"
    | "credential_store_failed"
    | PrivateFileError["reason"];
}> {}

const identityPath = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  kind: LocalIdentityKind,
): string => (kind === "root" ? rootCredentialPath(home, env) : clientCredentialPath(home, env));

const credentialStoreError = (
  kind: LocalIdentityKind,
  operation: LocalIdentityError["operation"],
  path: string,
  error: CredentialStoreFailure,
): LocalIdentityError =>
  new LocalIdentityError({
    kind,
    operation,
    path,
    reason:
      error.reason === "corrupt"
        ? "credential_store_corrupt"
        : error.reason === "permission"
          ? "credential_store_permission"
          : "credential_store_failed",
  });

const normalizeCredential = (
  kind: LocalIdentityKind,
  operation: LocalIdentityError["operation"],
  path: string,
  value: string,
): Effect.Effect<string, LocalIdentityError> => {
  const normalized = value.trim();
  return normalized.length === 0
    ? Effect.fail(new LocalIdentityError({ kind, operation, path, reason: "empty" }))
    : Effect.succeed(normalized);
};

const readFallback = Effect.fnUntraced(function* (
  kind: LocalIdentityKind,
  operation: LocalIdentityError["operation"],
  path: string,
  stateRoot: string,
) {
  const fileSystem = yield* FileSystem;
  const text = yield* fileSystem.readPrivateCredential(path, stateRoot).pipe(
    Effect.mapError(
      (error) => new LocalIdentityError({ kind, operation, path, reason: error.reason }),
    ),
    Effect.catchTag("LocalIdentityError", (error) =>
      error.reason === "missing" ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
  if (text === undefined) return undefined;
  return yield* normalizeCredential(kind, operation, path, text);
});

const saveFallback = Effect.fnUntraced(function* (
  kind: LocalIdentityKind,
  path: string,
  stateRoot: string,
  value: string,
) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem
    .writePrivateCredential(path, stateRoot, `${value}\n`)
    .pipe(
      Effect.mapError(
        (error) => new LocalIdentityError({ kind, operation: "save", path, reason: error.reason }),
      ),
    );
});

const removeFallback = Effect.fnUntraced(function* (
  kind: LocalIdentityKind,
  path: string,
  stateRoot: string,
) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem.removePrivateCredential(path, stateRoot).pipe(
    Effect.mapError(
      (error) => new LocalIdentityError({ kind, operation: "remove", path, reason: error.reason }),
    ),
    Effect.catchTag("LocalIdentityError", (error) =>
      error.reason === "missing" ? Effect.void : Effect.fail(error),
    ),
  );
});

export const loadLocalIdentity = Effect.fnUntraced(function* (kind: LocalIdentityKind) {
  const runtime = yield* CliRuntime;
  const credentialStore = yield* CredentialStore;
  const path = identityPath(runtime.home, runtime.env, kind);
  return yield* credentialStore.load(kind).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.succeed(undefined)
        : normalizeCredential(kind, "load", path, value),
    ),
    Effect.catchTag("CredentialStoreUnavailable", () =>
      readFallback(kind, "load", path, scottyStateRoot(runtime.home, runtime.env)),
    ),
    Effect.catchTag("CredentialStoreFailure", (error) =>
      Effect.fail(credentialStoreError(kind, "load", path, error)),
    ),
  );
});

export const saveLocalIdentity = Effect.fnUntraced(function* (
  kind: LocalIdentityKind,
  value: string,
) {
  const runtime = yield* CliRuntime;
  const credentialStore = yield* CredentialStore;
  const path = identityPath(runtime.home, runtime.env, kind);
  const normalized = yield* normalizeCredential(kind, "save", path, value);
  return yield* credentialStore.save(kind, normalized).pipe(
    Effect.catchTag("CredentialStoreUnavailable", () =>
      saveFallback(kind, path, scottyStateRoot(runtime.home, runtime.env), normalized),
    ),
    Effect.catchTag("CredentialStoreFailure", (error) =>
      Effect.fail(credentialStoreError(kind, "save", path, error)),
    ),
  );
});

export const removeLocalIdentity = Effect.fnUntraced(function* (kind: LocalIdentityKind) {
  const runtime = yield* CliRuntime;
  const credentialStore = yield* CredentialStore;
  const path = identityPath(runtime.home, runtime.env, kind);
  return yield* credentialStore.remove(kind).pipe(
    Effect.flatMap(() => removeFallback(kind, path, scottyStateRoot(runtime.home, runtime.env))),
    Effect.catchTag("CredentialStoreUnavailable", () =>
      removeFallback(kind, path, scottyStateRoot(runtime.home, runtime.env)),
    ),
    Effect.catchTag("CredentialStoreFailure", (error) =>
      Effect.fail(credentialStoreError(kind, "remove", path, error)),
    ),
  );
});

export const loadRootIdentity = (): Effect.Effect<
  string | undefined,
  LocalIdentityError,
  CliRuntime | CredentialStore | FileSystem
> => loadLocalIdentity("root");

export const loadClientIdentity = (): Effect.Effect<
  string | undefined,
  LocalIdentityError,
  CliRuntime | CredentialStore | FileSystem
> => loadLocalIdentity("client");

export const saveRootIdentity = (
  value: string,
): Effect.Effect<void, LocalIdentityError, CliRuntime | CredentialStore | FileSystem> =>
  saveLocalIdentity("root", value);

export const saveClientIdentity = (
  value: string,
): Effect.Effect<void, LocalIdentityError, CliRuntime | CredentialStore | FileSystem> =>
  saveLocalIdentity("client", value);

export const removeRootIdentity = (): Effect.Effect<
  void,
  LocalIdentityError,
  CliRuntime | CredentialStore | FileSystem
> => removeLocalIdentity("root");

export const removeClientIdentity = (): Effect.Effect<
  void,
  LocalIdentityError,
  CliRuntime | CredentialStore | FileSystem
> => removeLocalIdentity("client");
