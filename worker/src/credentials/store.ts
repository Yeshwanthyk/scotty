import { Clock, Context, Data, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import {
  decodeCredentialRegistryAuthorityResult,
  decodeCredentialRegistryGithubCliResolveInputResult,
  decodeCredentialRegistryGrantInputResult,
  decodeCredentialRegistryDesiredSyncInputResult,
  decodeCredentialRegistryReleaseInputResult,
  decodeCredentialRegistryResolveInputResult,
  decodeCredentialRegistrySyncInputResult,
  type CredentialRegistryAuthority,
  type CredentialRegistryCredential,
  type CredentialRegistryGrantResult,
  type CredentialRegistryReleaseResult,
  type CredentialRegistryResolveInput,
  type CredentialRegistrySyncEntry,
  type CredentialRegistrySyncInput,
  type CredentialRegistrySyncResult,
  type CredentialRegistryVersionRecord,
  type EncryptedCredentialEnvelope,
} from "./contracts";
import {
  parseManagedHandle,
  type CredentialGrant,
  type CredentialKind,
  type CredentialRedactedMetadata,
  type ManagedHandleSlot,
} from "../../../protocol/credentials";
import { serializePiAuthProviders } from "../../../protocol/pi-auth";
import { repositoryIdentityKey } from "../../../protocol/repository";
import {
  CredentialCrypto,
  type CredentialCryptoFailure,
  type CredentialCryptoShape,
} from "./crypto";

// oxlint-disable-next-line scotty/no-storage-key-literal -- authority storage owns this single persisted record
const CREDENTIAL_REGISTRY_KEY = "scotty:credential-registry:1";

type CredentialRegistryFailureReason =
  | "invalid_authority"
  | "invalid_input"
  | "credential_conflict"
  | "credential_missing"
  | "credential_ambiguous"
  | "version_missing"
  | "grant_missing"
  | "handle_mismatch"
  | "storage"
  | CredentialCryptoFailure["reason"];

export class CredentialRegistryFailure extends Data.TaggedError("CredentialRegistryFailure")<{
  readonly reason: CredentialRegistryFailureReason;
  readonly message: string;
}> {}

export interface CredentialRegistryTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (authority: CredentialRegistryAuthority) => Promise<void>;
}

export interface CredentialRegistryStorage {
  readonly transaction: <A>(
    operation: (transaction: CredentialRegistryTransaction) => Promise<A>,
  ) => Promise<A>;
}

export interface CredentialStoreShape {
  readonly sync: (
    input: unknown,
  ) => Effect.Effect<CredentialRegistrySyncResult, CredentialRegistryFailure>;
  readonly list: Effect.Effect<
    ReadonlyArray<CredentialRedactedMetadata>,
    CredentialRegistryFailure
  >;
  readonly issueGrants: (
    input: unknown,
  ) => Effect.Effect<CredentialRegistryGrantResult, CredentialRegistryFailure>;
  readonly resolve: (
    input: unknown,
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialRegistryFailure>;
  readonly resolveGithubCliCredential: (
    input: unknown,
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialRegistryFailure>;
  readonly release: (
    input: unknown,
  ) => Effect.Effect<CredentialRegistryReleaseResult, CredentialRegistryFailure>;
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreShape>()(
  "scotty/CredentialStore",
) {}

export const durableObjectCredentialRegistryStorage = (
  storage: DurableObjectStorage,
): CredentialRegistryStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(CREDENTIAL_REGISTRY_KEY),
        put: (authority) => transaction.put(CREDENTIAL_REGISTRY_KEY, authority),
      }),
    ),
});

export const credentialStoreLayer = (
  storage: CredentialRegistryStorage,
  installation: string,
): Layer.Layer<CredentialStore, never, CredentialCrypto> =>
  Layer.effect(
    CredentialStore,
    Effect.map(CredentialCrypto, (crypto) => makeCredentialStore(storage, installation, crypto)),
  );

export type GithubCliCredentialSelectionFailure = "missing" | "ambiguous";

export type PiAuthCredentialSelectionFailure = "missing" | "ambiguous";

/** Selects the only Pi credential that can apply to a Session. */
export const selectPiAuthCredential = (
  credentials: ReadonlyArray<CredentialRegistryCredential>,
): Result.Result<CredentialRegistryCredential, PiAuthCredentialSelectionFailure> => {
  const piCredentials = credentials.filter(({ kind }) => kind === "pi-auth");
  if (piCredentials.length === 1) return Result.succeed(piCredentials[0]);
  return Result.fail(piCredentials.length === 0 ? "missing" : "ambiguous");
};

/**
 * Selects one GitHub credential without exposing plaintext: one exact match wins; otherwise
 * exactly one global declaration is allowed as the fallback.
 */
export const selectGithubCliCredential = (
  credentials: ReadonlyArray<CredentialRegistryCredential>,
  repository: string,
): Result.Result<CredentialRegistryCredential, GithubCliCredentialSelectionFailure> => {
  const githubCredentials = credentials.filter(({ kind }) => kind === "github-cli");
  const exact = githubCredentials.filter(
    (credential) =>
      credential.scope === "repository" &&
      credential.repositories?.some(
        (candidate) => repositoryIdentityKey(candidate) === repositoryIdentityKey(repository),
      ) === true,
  );
  if (exact.length > 1) return Result.fail("ambiguous");
  if (exact.length === 1) return Result.succeed(exact[0]);

  const global = githubCredentials.filter(({ scope }) => scope === "global");
  if (global.length !== 1) return Result.fail(global.length === 0 ? "missing" : "ambiguous");
  return Result.succeed(global[0]);
};

const makeCredentialStore = (
  storage: CredentialRegistryStorage,
  installation: string,
  credentialCrypto: CredentialCryptoShape,
): CredentialStoreShape => {
  const failure = (
    reason: CredentialRegistryFailureReason,
    message: string,
  ): CredentialRegistryFailure => new CredentialRegistryFailure({ reason, message });
  const invalidAuthority = (): CredentialRegistryFailure =>
    failure("invalid_authority", "Stored credential registry authority is invalid");
  const invalidInput = (): CredentialRegistryFailure =>
    failure("invalid_input", "Credential registry input is invalid");
  const storageFailure = (): CredentialRegistryFailure =>
    failure("storage", "Credential registry storage operation failed");
  const cryptoFailure = (error: CredentialCryptoFailure): CredentialRegistryFailure =>
    failure(
      error.reason,
      error.reason === "wrapping_key_unavailable"
        ? "Installation wrapping key is unavailable"
        : "Credential cryptographic operation failed",
    );
  const parse = (
    value: unknown | undefined,
  ): Result.Result<CredentialRegistryAuthority, CredentialRegistryFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    const decoded = decodeCredentialRegistryAuthorityResult(value);
    if (Result.isFailure(decoded)) return Result.fail(invalidAuthority());
    const normalized = normalizeAuthority(decoded.success);
    if (!validAuthority(normalized)) return Result.fail(invalidAuthority());
    return Result.succeed(normalized);
  };

  type TransactionResult<A> = {
    readonly value: A;
    readonly authority: CredentialRegistryAuthority;
    readonly write?: boolean;
  };

  const transact = <A>(
    operation: (
      authority: CredentialRegistryAuthority,
      now: number,
    ) => Promise<Result.Result<TransactionResult<A>, CredentialRegistryFailure>>,
  ): Effect.Effect<A, CredentialRegistryFailure> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* Effect.tryPromise({
        try: () =>
          storage.transaction(async (transaction) => {
            const authority = parse(await transaction.get());
            if (Result.isFailure(authority)) return Result.fail(authority.failure);
            const next = await operation(authority.success, now);
            if (Result.isFailure(next)) return Result.fail(next.failure);
            if (next.success.write !== false) {
              if (!validAuthority(next.success.authority)) return Result.fail(invalidAuthority());
              await transaction.put(next.success.authority);
            }
            return Result.succeed(next.success.value);
          }),
        catch: () => storageFailure(),
      });
      return yield* Effect.fromResult(result);
    });

  const read = <A>(
    operation: (
      authority: CredentialRegistryAuthority,
    ) => Result.Result<A, CredentialRegistryFailure>,
  ): Effect.Effect<A, CredentialRegistryFailure> =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const authority = parse(await transaction.get());
          return Result.isFailure(authority)
            ? Result.fail(authority.failure)
            : operation(authority.success);
        }),
      catch: () => storageFailure(),
    }).pipe(Effect.flatMap(Effect.fromResult));

  const decode = <A>(result: Result.Result<A, Schema.SchemaError>) =>
    Result.mapError(result, invalidInput);

  const metadata = (credential: CredentialRegistryCredential): CredentialRedactedMetadata => ({
    name: credential.name,
    kind: credential.kind,
    scope: credential.scope,
    ...(credential.repositories === undefined
      ? {}
      : { repositories: [...credential.repositories] }),
    configured: true,
  });

  const list: Effect.Effect<
    ReadonlyArray<CredentialRedactedMetadata>,
    CredentialRegistryFailure
  > = read((authority) => Result.succeed(authority.credentials.map(metadata)));

  const validateIncoming = (
    input: CredentialRegistrySyncInput,
  ): Effect.Effect<void, CredentialRegistryFailure> =>
    Effect.gen(function* () {
      for (const entry of input.credentials) {
        const plaintext = yield* credentialCrypto
          .decrypt(installation, entry.name, entry.versionRef, entry.kind, entry.envelope)
          .pipe(Effect.mapError(cryptoFailure));
        Redacted.wipeUnsafe(plaintext);
      }
    });

  const handleSlots = (kind: CredentialKind): CredentialGrant["handleSlots"] =>
    kind === "pi-auth"
      ? ([
          { provider: "openai", slot: "api-key" },
          { provider: "openai-codex", slot: "access" },
        ] as const)
      : ([{ provider: "github", slot: "git-https" }] as const);

  const projectGrant = (grant: CredentialRegistryAuthority["grants"][number]): CredentialGrant => {
    const { issuedAt: _issuedAt, sessionId: _sessionId, ...projection } = grant;
    return projection;
  };

  const grantFor = (
    authority: CredentialRegistryAuthority,
    input: Pick<
      CredentialRegistryResolveInput,
      "sessionId" | "name" | "kind" | "versionRef" | "handle"
    >,
  ): Result.Result<CredentialRegistryVersionRecord, CredentialRegistryFailure> => {
    const grant = authority.grants.find(
      (candidate) =>
        candidate.sessionId === input.sessionId &&
        candidate.name === input.name &&
        candidate.kind === input.kind &&
        candidate.versionRef === input.versionRef,
    );
    if (grant === undefined)
      return Result.fail(failure("grant_missing", "Credential grant is not available"));

    const handle = parseManagedHandle(input.handle);
    if (
      Option.isNone(handle) ||
      handle.value.name !== grant.name ||
      !grant.handleSlots.some(
        ({ provider, slot }) => provider === handle.value.provider && slot === handle.value.slot,
      )
    )
      return Result.fail(failure("handle_mismatch", "Managed credential handle is not authorized"));

    const version = authority.versions.find(
      (candidate) =>
        candidate.name === grant.name &&
        candidate.kind === grant.kind &&
        candidate.versionRef === grant.versionRef,
    );
    return version === undefined
      ? Result.fail(failure("version_missing", "Credential version is not available"))
      : Result.succeed(version);
  };

  const issue = (
    input: unknown,
  ): Effect.Effect<CredentialRegistryGrantResult, CredentialRegistryFailure> => {
    const decoded = decode(decodeCredentialRegistryGrantInputResult(input));
    if (Result.isFailure(decoded)) return Effect.fail(decoded.failure);

    return transact(async (authority, now) => {
      const existing = authority.grants.filter(
        ({ sessionId }) => sessionId === decoded.success.sessionId,
      );
      const issuedSessions = authority.issuedSessions ?? [];
      if (issuedSessions.includes(decoded.success.sessionId))
        return Result.succeed({
          value: {
            sessionId: decoded.success.sessionId,
            grants: existing.map(projectGrant),
          },
          authority,
          write: false as const,
        });

      const repository = decoded.success.repository;
      const piCredentials = authority.credentials.filter(({ kind }) => kind === "pi-auth");
      const selectedPi =
        piCredentials.length === 0 ? undefined : selectPiAuthCredential(piCredentials);
      if (selectedPi !== undefined && Result.isFailure(selectedPi))
        return Result.fail(
          failure(
            selectedPi.failure === "ambiguous" ? "credential_ambiguous" : "credential_missing",
            selectedPi.failure === "ambiguous"
              ? "Pi credential declaration is ambiguous"
              : "Pi credential is not declared",
          ),
        );
      const selectedPiName =
        selectedPi === undefined || Result.isFailure(selectedPi)
          ? undefined
          : selectedPi.success.name;
      const githubCredentials = authority.credentials.filter(({ kind }) => kind === "github-cli");
      const selectedGithub =
        githubCredentials.length === 0
          ? undefined
          : selectGithubCliCredential(githubCredentials, repository ?? "");
      if (selectedGithub !== undefined && Result.isFailure(selectedGithub))
        return Result.fail(
          failure(
            selectedGithub.failure === "ambiguous" ? "credential_ambiguous" : "credential_missing",
            selectedGithub.failure === "ambiguous"
              ? "GitHub credential declaration is ambiguous"
              : "GitHub credential is not declared for this repository",
          ),
        );
      const selectedGithubName =
        selectedGithub === undefined || Result.isFailure(selectedGithub)
          ? undefined
          : selectedGithub.success.name;
      const grants = authority.credentials.flatMap((credential) => {
        if (credential.kind === "pi-auth" && credential.name !== selectedPiName) return [];
        if (credential.kind === "github-cli" && credential.name !== selectedGithubName) return [];
        const inScope =
          credential.kind === "github-cli" ||
          credential.scope === "global" ||
          (repository !== undefined &&
            credential.repositories?.some(
              (candidate) => repositoryIdentityKey(candidate) === repositoryIdentityKey(repository),
            ) === true);
        if (!inScope) return [];
        const version = authority.versions.find(
          (candidate) =>
            candidate.name === credential.name &&
            candidate.kind === credential.kind &&
            candidate.versionRef === credential.currentVersionRef,
        );
        if (version === undefined) return [];
        return [
          {
            sessionId: decoded.success.sessionId,
            name: credential.name,
            kind: credential.kind,
            versionRef: credential.currentVersionRef,
            handleSlots: handleSlots(credential.kind),
            ...(version.expires === undefined ? {} : { expires: version.expires }),
            issuedAt: new Date(now).toISOString(),
          },
        ];
      });
      const next = {
        ...authority,
        issuedSessions: [...issuedSessions, decoded.success.sessionId],
        grants: [...authority.grants, ...grants],
      };
      return Result.succeed({
        value: {
          sessionId: decoded.success.sessionId,
          grants: grants.map(projectGrant),
        },
        authority: next,
        write: true,
      });
    });
  };

  const resolveGithubCliCredential = (
    input: unknown,
  ): Effect.Effect<Redacted.Redacted<string>, CredentialRegistryFailure> => {
    const decoded = decode(decodeCredentialRegistryGithubCliResolveInputResult(input));
    if (Result.isFailure(decoded)) return Effect.fail(decoded.failure);
    return Effect.gen(function* () {
      const version = yield* read((authority) => {
        const selected = selectGithubCliCredential(
          authority.credentials,
          decoded.success.repository,
        );
        if (Result.isFailure(selected))
          return Result.fail(
            failure(
              selected.failure === "ambiguous" ? "credential_ambiguous" : "credential_missing",
              selected.failure === "ambiguous"
                ? "GitHub credential declaration is ambiguous"
                : "GitHub credential is not declared for this repository",
            ),
          );
        const current = authority.versions.find(
          (candidate) =>
            candidate.name === selected.success.name &&
            candidate.kind === selected.success.kind &&
            candidate.versionRef === selected.success.currentVersionRef,
        );
        return current === undefined
          ? Result.fail(failure("version_missing", "GitHub credential version is not available"))
          : Result.succeed(current);
      });
      return yield* credentialCrypto
        .decrypt(installation, version.name, version.versionRef, version.kind, version.envelope)
        .pipe(Effect.mapError(cryptoFailure));
    });
  };

  const resolve = (
    input: unknown,
  ): Effect.Effect<Redacted.Redacted<string>, CredentialRegistryFailure> => {
    const decoded = decode(decodeCredentialRegistryResolveInputResult(input));
    if (Result.isFailure(decoded)) return Effect.fail(decoded.failure);
    return Effect.gen(function* () {
      const version = yield* read((authority) => grantFor(authority, decoded.success));
      return yield* credentialCrypto
        .decrypt(installation, version.name, version.versionRef, version.kind, version.envelope)
        .pipe(Effect.mapError(cryptoFailure));
    });
  };

  const release = (
    input: unknown,
  ): Effect.Effect<CredentialRegistryReleaseResult, CredentialRegistryFailure> => {
    const decoded = decode(decodeCredentialRegistryReleaseInputResult(input));
    if (Result.isFailure(decoded)) return Effect.fail(decoded.failure);

    return transact(async (authority) => {
      const issuedSessions = authority.issuedSessions ?? [];
      const existing = authority.grants.filter(
        ({ sessionId }) => sessionId === decoded.success.sessionId,
      );
      if (!issuedSessions.includes(decoded.success.sessionId))
        return Result.succeed({
          value: {
            sessionId: decoded.success.sessionId,
            released: true as boolean,
          },
          authority,
          write: false as const,
        });

      if (
        decoded.success.grants !== undefined &&
        !sameGrantSet(existing.map(projectGrant), decoded.success.grants)
      )
        return Result.fail(
          failure("grant_missing", "Credential grant release does not match authority"),
        );

      const next = garbageCollect({
        ...authority,
        issuedSessions: issuedSessions.filter(
          (sessionId) => sessionId !== decoded.success.sessionId,
        ),
        grants: authority.grants.filter(({ sessionId }) => sessionId !== decoded.success.sessionId),
      });
      return Result.succeed({
        value: {
          sessionId: decoded.success.sessionId,
          released: true as boolean,
        },
        authority: next,
      });
    });
  };

  const syncEncrypted = (
    input: unknown,
  ): Effect.Effect<CredentialRegistrySyncResult, CredentialRegistryFailure> => {
    const decoded = decode(decodeCredentialRegistrySyncInputResult(input));
    if (Result.isFailure(decoded)) return Effect.fail(decoded.failure);

    return Effect.gen(function* () {
      yield* validateIncoming(decoded.success);
      return yield* transact(async (authority, now) => {
        const versions = [...authority.versions];
        const credentials: CredentialRegistryCredential[] = [];
        const entries = [...decoded.success.credentials].toSorted((left, right) =>
          left.name.localeCompare(right.name),
        );

        for (const entry of entries) {
          const conflictingKind =
            authority.versions.some(
              (version) => version.name === entry.name && version.kind !== entry.kind,
            ) ||
            authority.grants.some(
              (grant) => grant.name === entry.name && grant.kind !== entry.kind,
            );
          if (conflictingKind)
            return Result.fail(
              failure("credential_conflict", "Credential kind conflicts with authority"),
            );

          const existing = versions.find(
            (version) =>
              version.name === entry.name &&
              version.kind === entry.kind &&
              version.versionRef === entry.versionRef,
          );
          if (existing !== undefined) {
            if (
              !sameCredential(existing.envelope, entry.envelope) ||
              existing.expires !== entry.expires
            )
              return Result.fail(
                failure("credential_conflict", "Credential version conflicts with authority"),
              );
          } else {
            const sameNameAndRef = versions.some(
              (version) => version.name === entry.name && version.versionRef === entry.versionRef,
            );
            if (sameNameAndRef)
              return Result.fail(
                failure("credential_conflict", "Credential version conflicts with authority"),
              );
            versions.push({
              name: entry.name,
              kind: entry.kind,
              versionRef: entry.versionRef,
              envelope: entry.envelope,
              createdAt: new Date(now).toISOString(),
              ...(entry.expires === undefined ? {} : { expires: entry.expires }),
            });
          }

          credentials.push({
            name: entry.name,
            kind: entry.kind,
            scope: entry.scope,
            ...(entry.repositories === undefined ? {} : { repositories: [...entry.repositories] }),
            currentVersionRef: entry.versionRef,
          });
        }

        const next = garbageCollect({
          credentials,
          versions,
          grants: authority.grants,
          issuedSessions: authority.issuedSessions ?? [],
        });
        return Result.succeed({
          value: {
            credentials: next.credentials.map(metadata),
          },
          authority: next,
        });
      });
    });
  };

  const sync = (
    input: unknown,
  ): Effect.Effect<CredentialRegistrySyncResult, CredentialRegistryFailure> => {
    const desired = decode(decodeCredentialRegistryDesiredSyncInputResult(input));
    if (Result.isFailure(desired)) return Effect.fail(invalidInput());

    return Effect.gen(function* () {
      const entries: CredentialRegistrySyncEntry[] = [];
      for (const entry of desired.success.credentials) {
        const plaintextValue =
          entry.kind === "pi-auth" ? serializePiAuthProviders(entry.providers) : entry.token;
        const codexCredential =
          entry.kind === "pi-auth" ? entry.providers["openai-codex"] : undefined;
        const expires = codexCredential?.type === "oauth" ? codexCredential.expires : undefined;
        const versionRef = yield* Effect.tryPromise({
          try: async () => {
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(plaintextValue),
            );
            return Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
          },
          catch: () => invalidInput(),
        });
        const plaintext = Redacted.make(plaintextValue);
        const envelope = yield* credentialCrypto
          .encrypt(installation, entry.name, versionRef, entry.kind, plaintext)
          .pipe(
            Effect.mapError(cryptoFailure),
            Effect.ensuring(Effect.sync(() => void Redacted.wipeUnsafe(plaintext))),
          );
        entries.push({
          name: entry.name,
          kind: entry.kind,
          scope: entry.scope,
          ...(entry.kind === "github-cli" && entry.repositories !== undefined
            ? { repositories: [...entry.repositories] }
            : {}),
          versionRef,
          envelope,
          ...(expires === undefined ? {} : { expires }),
        });
      }
      return yield* syncEncrypted({ credentials: entries });
    });
  };

  return CredentialStore.of({
    sync,
    list,
    issueGrants: issue,
    resolve,
    resolveGithubCliCredential,
    release,
  });
};

const emptyAuthority = (): CredentialRegistryAuthority => ({
  credentials: [],
  versions: [],
  grants: [],
  issuedSessions: [],
});

const versionKey = (name: string, kind: string, versionRef: string): string =>
  `${name}\u0000${kind}\u0000${versionRef}`;

const garbageCollect = (authority: CredentialRegistryAuthority): CredentialRegistryAuthority => {
  const desired = new Set(
    authority.credentials.map((credential) =>
      versionKey(credential.name, credential.kind, credential.currentVersionRef),
    ),
  );
  const granted = new Set(
    authority.grants.map((grant) => versionKey(grant.name, grant.kind, grant.versionRef)),
  );
  return {
    ...authority,
    credentials: [...authority.credentials].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    ),
    versions: authority.versions
      .filter(
        (version) =>
          desired.has(versionKey(version.name, version.kind, version.versionRef)) ||
          granted.has(versionKey(version.name, version.kind, version.versionRef)),
      )
      .toSorted(
        (left, right) =>
          left.name.localeCompare(right.name) || left.versionRef.localeCompare(right.versionRef),
      ),
    grants: [...authority.grants].toSorted(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) || left.name.localeCompare(right.name),
    ),
  };
};

// Encryption uses a fresh IV for every write. The keyed digest identifies the
// plaintext version, so a repeated sync may safely retain the existing ciphertext.
const sameCredential = (
  left: EncryptedCredentialEnvelope,
  right: EncryptedCredentialEnvelope,
): boolean => left.kind === right.kind && left.keyedDigest === right.keyedDigest;

const sameGrant = (left: CredentialGrant, right: CredentialGrant): boolean =>
  left.name === right.name &&
  left.kind === right.kind &&
  left.versionRef === right.versionRef &&
  left.expires === right.expires &&
  left.handleSlots.length === right.handleSlots.length &&
  left.handleSlots.every((slot) =>
    right.handleSlots.some(
      (candidate) => candidate.provider === slot.provider && candidate.slot === slot.slot,
    ),
  );

const sameGrantSet = (
  left: ReadonlyArray<CredentialGrant>,
  right: ReadonlyArray<CredentialGrant>,
): boolean =>
  left.length === right.length &&
  left.every((grant) => right.some((candidate) => sameGrant(grant, candidate)));

const validHandleSlot = (kind: CredentialKind, slot: ManagedHandleSlot): boolean =>
  kind === "pi-auth"
    ? (slot.provider === "openai" && slot.slot === "api-key") ||
      (slot.provider === "openai-codex" && slot.slot === "access")
    : slot.provider === "github" && slot.slot === "git-https";
const validIssuedSessions = (authority: CredentialRegistryAuthority): boolean => {
  const sessions = authority.issuedSessions ?? [];
  return new Set(sessions).size === sessions.length;
};

const validAuthority = (authority: CredentialRegistryAuthority): boolean => {
  const issuedSessions = new Set(authority.issuedSessions ?? []);
  const desiredNames = new Set<string>();
  const desiredRefs = new Set<string>();
  for (const credential of authority.credentials) {
    if (
      desiredNames.has(credential.name) ||
      (credential.scope === "global"
        ? credential.repositories !== undefined
        : credential.repositories === undefined)
    )
      return false;
    desiredNames.add(credential.name);
    desiredRefs.add(versionKey(credential.name, credential.kind, credential.currentVersionRef));
  }

  const versions = new Map<string, CredentialRegistryVersionRecord>();
  for (const version of authority.versions) {
    const key = versionKey(version.name, version.kind, version.versionRef);
    if (versions.has(key) || version.envelope.kind !== version.kind) return false;
    versions.set(key, version);
  }
  for (const credential of authority.credentials) {
    if (!versions.has(versionKey(credential.name, credential.kind, credential.currentVersionRef)))
      return false;
  }

  const grants = new Set<string>();
  for (const grant of authority.grants) {
    const grantKey = `${grant.sessionId}\u0000${grant.name}`;
    const version = versions.get(versionKey(grant.name, grant.kind, grant.versionRef));
    if (
      grants.has(grantKey) ||
      !issuedSessions.has(grant.sessionId) ||
      version === undefined ||
      grant.expires !== version.expires ||
      grant.handleSlots.some((slot) => !validHandleSlot(grant.kind, slot))
    )
      return false;
    grants.add(grantKey);
  }
  for (const version of authority.versions) {
    const key = versionKey(version.name, version.kind, version.versionRef);
    if (
      !desiredRefs.has(key) &&
      !authority.grants.some(
        (grant) => versionKey(grant.name, grant.kind, grant.versionRef) === key,
      )
    )
      return false;
  }
  return validIssuedSessions(authority);
};

const normalizeAuthority = (
  authority: CredentialRegistryAuthority,
): CredentialRegistryAuthority => ({
  ...authority,
  issuedSessions: [
    ...new Set([
      ...(authority.issuedSessions ?? []),
      ...authority.grants.map(({ sessionId }) => sessionId),
    ]),
  ].toSorted(),
});
export const readCredentialRegistryAuthority = (
  storage: CredentialRegistryStorage,
): Effect.Effect<CredentialRegistryAuthority, CredentialRegistryFailure> =>
  Effect.tryPromise({
    try: () => storage.transaction(async (transaction) => parseAuthority(await transaction.get())),
    catch: () =>
      new CredentialRegistryFailure({
        reason: "storage",
        message: "Credential registry storage operation failed",
      }),
  }).pipe(Effect.flatMap(Effect.fromResult));

const parseAuthority = (
  value: unknown | undefined,
): Result.Result<CredentialRegistryAuthority, CredentialRegistryFailure> => {
  if (value === undefined) return Result.succeed(emptyAuthority());
  const decoded = decodeCredentialRegistryAuthorityResult(value);
  if (Result.isFailure(decoded))
    return Result.fail(
      new CredentialRegistryFailure({
        reason: "invalid_authority",
        message: "Stored credential registry authority is invalid",
      }),
    );
  const normalized = normalizeAuthority(decoded.success);
  return !validAuthority(normalized)
    ? Result.fail(
        new CredentialRegistryFailure({
          reason: "invalid_authority",
          message: "Stored credential registry authority is invalid",
        }),
      )
    : Result.succeed(normalized);
};
