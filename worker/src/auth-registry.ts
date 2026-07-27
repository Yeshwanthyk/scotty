import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";
import { sha256Hex } from "./digest";

const AUTHORITY_KEY = "scotty:auth-authority";
const CLIENT_CREDENTIAL_PREFIX = "scotty_client";
const PAIRING_CREDENTIAL_PREFIX = "scotty_pair";
const OWNER_TRANSFER_CREDENTIAL_PREFIX = "scotty_transfer";
const RECOVERY_CREDENTIAL_PREFIX = "scotty_recovery";
const MAX_CLIENTS = 64;
const MAX_PAIRINGS = 32;
const OWNER_RENEWAL_WINDOW_MILLIS = 7 * 24 * 60 * 60 * 1_000;
const OWNER_TTL_MILLIS = 30 * 24 * 60 * 60 * 1_000;

export const STANDARD_AUTH_SCOPES = ["sessions:read", "sessions:write"] as const;

export const ADMIN_AUTH_SCOPES = [...STANDARD_AUTH_SCOPES, "access:read", "access:write"] as const;

export const StandardAuthScopeSchema = Schema.Literals(STANDARD_AUTH_SCOPES);
export type StandardAuthScope = typeof StandardAuthScopeSchema.Type;

export const AuthScopeSchema = Schema.Literals(ADMIN_AUTH_SCOPES);
export type AuthScope = typeof AuthScopeSchema.Type;

const AuthClientRecordV1Schema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(AuthScopeSchema),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  lastSeenAt: Schema.String,
  userAgent: Schema.optionalKey(Schema.String),
  revokedAt: Schema.optionalKey(Schema.String),
});
type AuthClientRecordV1 = typeof AuthClientRecordV1Schema.Type;

const PairingGrantRecordV1Schema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  label: Schema.optionalKey(Schema.String),
  scopes: Schema.Array(AuthScopeSchema),
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
type PairingGrantRecordV1 = typeof PairingGrantRecordV1Schema.Type;

export const AuthAuthorityV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  clients: Schema.Array(AuthClientRecordV1Schema),
  pairings: Schema.Array(PairingGrantRecordV1Schema),
});
export type AuthAuthorityV1 = typeof AuthAuthorityV1Schema.Type;

const AuthClientRecordSchema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(StandardAuthScopeSchema),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  lastSeenAt: Schema.String,
  userAgent: Schema.optionalKey(Schema.String),
  revokedAt: Schema.optionalKey(Schema.String),
});
export type AuthClientRecord = typeof AuthClientRecordSchema.Type;

const PairingGrantRecordSchema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  label: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
type PairingGrantRecord = typeof PairingGrantRecordSchema.Type;

const OwnershipStateSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("unclaimed"),
    epoch: Schema.Number,
  }),
  Schema.Struct({
    state: Schema.Literal("claimed"),
    ownerClientId: Schema.String,
    epoch: Schema.Number,
  }),
]);
export type OwnershipState = typeof OwnershipStateSchema.Type;

const OwnerTransferRecordSchema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  sourceOwnerClientId: Schema.String,
  targetClientId: Schema.String,
  ownerEpoch: Schema.Number,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  idempotencyKeyDigest: Schema.optionalKey(Schema.String),
});
type OwnerTransferRecord = typeof OwnerTransferRecordSchema.Type;

const RecoveryGrantRecordSchema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  ownerEpoch: Schema.Number,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  idempotencyKeyDigest: Schema.optionalKey(Schema.String),
});
type RecoveryGrantRecord = typeof RecoveryGrantRecordSchema.Type;

export const AuthAuthoritySchema = Schema.Struct({
  version: Schema.Literal(2),
  ownership: OwnershipStateSchema,
  clients: Schema.Array(AuthClientRecordSchema),
  pairings: Schema.Array(PairingGrantRecordSchema),
  ownerTransfer: Schema.optionalKey(OwnerTransferRecordSchema),
  recoveryGrant: Schema.optionalKey(RecoveryGrantRecordSchema),
});
export type AuthAuthority = typeof AuthAuthoritySchema.Type;

const CredentialCandidateSchema = Schema.Struct({
  id: Schema.String,
  secret: Schema.String,
});
export type CredentialCandidate = typeof CredentialCandidateSchema.Type;

const ClientCandidateSchema = Schema.Struct({
  credential: CredentialCandidateSchema,
  label: Schema.String,
  ttlMillis: Schema.Number,
  userAgent: Schema.optionalKey(Schema.String),
});
export type ClientCandidate = typeof ClientCandidateSchema.Type;

const PairingCandidateSchema = Schema.Struct({
  credential: CredentialCandidateSchema,
  label: Schema.optionalKey(Schema.String),
  ttlMillis: Schema.Number,
});
export type PairingCandidate = typeof PairingCandidateSchema.Type;

const OwnerTransferCandidateSchema = Schema.Struct({
  credential: CredentialCandidateSchema,
  targetClientId: Schema.String,
  ttlMillis: Schema.Number,
  idempotencyKey: Schema.optionalKey(Schema.String),
});
export type OwnerTransferCandidate = typeof OwnerTransferCandidateSchema.Type;

const ReplacementCredentialCandidateSchema = Schema.Struct({
  secret: Schema.String,
  ttlMillis: Schema.Number,
});
export type ReplacementCredentialCandidate = typeof ReplacementCredentialCandidateSchema.Type;

const RecoveryGrantCandidateSchema = Schema.Struct({
  credential: CredentialCandidateSchema,
  ttlMillis: Schema.Number,
  idempotencyKey: Schema.optionalKey(Schema.String),
});
export type RecoveryGrantCandidate = typeof RecoveryGrantCandidateSchema.Type;

export const AuthClientViewSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(AuthScopeSchema),
  role: Schema.Literals(["owner", "standard"]),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  lastSeenAt: Schema.String,
  userAgent: Schema.optionalKey(Schema.String),
  current: Schema.optionalKey(Schema.Boolean),
});
export type AuthClientView = typeof AuthClientViewSchema.Type;

export const OwnerTransferViewSchema = Schema.Struct({
  id: Schema.String,
  sourceOwnerClientId: Schema.String,
  targetClientId: Schema.String,
  ownerEpoch: Schema.Number,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type OwnerTransferView = typeof OwnerTransferViewSchema.Type;

export interface AuthenticatedClient {
  readonly client: AuthClientView;
  readonly renewed: boolean;
}

export interface IssuedPairingGrant {
  readonly id: string;
  readonly credential: string;
  readonly expiresAt: string;
}

export interface IssuedClientCredential {
  readonly credential: string;
  readonly client: AuthClientView;
}

export interface IssuedOwnerTransfer {
  readonly id: string;
  readonly credential: string;
  readonly transfer: OwnerTransferView;
}

export interface IssuedRecoveryGrant {
  readonly id: string;
  readonly credential: string;
  readonly expiresAt: string;
}

export type AuthRegistryFailureReason =
  | "capacity"
  | "client_missing"
  | "credential_invalid"
  | "forbidden"
  | "invalid_authority"
  | "invalid_input"
  | "outcome_unknown"
  | "owner_required"
  | "pairing_invalid"
  | "recovery_invalid"
  | "self_revoke"
  | "storage"
  | "transfer_invalid"
  | "transfer_pending";

export class AuthRegistryFailure extends Data.TaggedError("AuthRegistryFailure")<{
  readonly reason: AuthRegistryFailureReason;
  readonly message: string;
}> {}

export interface AuthAuthorityTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (authority: AuthAuthority) => Promise<void>;
}

export interface AuthAuthorityStorage {
  readonly transaction: <A>(
    operation: (transaction: AuthAuthorityTransaction) => Promise<A>,
  ) => Promise<A>;
}

interface AuthRegistryShape {
  readonly authenticate: (
    credential: unknown,
  ) => Effect.Effect<AuthenticatedClient, AuthRegistryFailure>;
  readonly issuePairing: (
    ownerCredential: unknown,
    candidate: unknown,
  ) => Effect.Effect<IssuedPairingGrant, AuthRegistryFailure>;
  readonly consumePairing: (
    credential: unknown,
    client: unknown,
  ) => Effect.Effect<IssuedClientCredential, AuthRegistryFailure>;
  readonly listClients: (
    ownerCredential: unknown,
  ) => Effect.Effect<ReadonlyArray<AuthClientView>, AuthRegistryFailure>;
  readonly revokeClient: (
    ownerCredential: unknown,
    clientId: string,
  ) => Effect.Effect<void, AuthRegistryFailure>;
  readonly logoutClient: (credential: unknown) => Effect.Effect<void, AuthRegistryFailure>;
  readonly startOwnerTransfer: (
    ownerCredential: unknown,
    candidate: unknown,
  ) => Effect.Effect<IssuedOwnerTransfer, AuthRegistryFailure>;
  readonly currentOwnerTransfer: (
    ownerCredential: unknown,
  ) => Effect.Effect<OwnerTransferView | null, AuthRegistryFailure>;
  readonly cancelOwnerTransfer: (
    ownerCredential: unknown,
    transferId: string,
  ) => Effect.Effect<void, AuthRegistryFailure>;
  readonly acceptOwnerTransfer: (
    targetCredential: unknown,
    transferCredential: unknown,
    replacement: unknown,
  ) => Effect.Effect<IssuedClientCredential, AuthRegistryFailure>;
  readonly issueRecoveryGrant: (
    candidate: unknown,
  ) => Effect.Effect<IssuedRecoveryGrant, AuthRegistryFailure>;
  readonly consumeRecoveryGrant: (
    credential: unknown,
    ownerClient: unknown,
  ) => Effect.Effect<IssuedClientCredential, AuthRegistryFailure>;
}

export class AuthRegistry extends Context.Service<AuthRegistry, AuthRegistryShape>()(
  "scotty/AuthRegistry",
) {}

export const durableObjectAuthAuthorityStorage = (
  storage: DurableObjectStorage,
): AuthAuthorityStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(AUTHORITY_KEY),
        put: (authority) => transaction.put(AUTHORITY_KEY, authority),
      }),
    ),
});

export const authRegistryLayer = (storage: AuthAuthorityStorage): Layer.Layer<AuthRegistry> =>
  Layer.succeed(AuthRegistry)(makeAuthRegistry(storage));

const decodeAuthorityV1 = Schema.decodeUnknownResult(AuthAuthorityV1Schema, {
  onExcessProperty: "error",
});
const decodeAuthorityV2 = Schema.decodeUnknownResult(AuthAuthoritySchema, {
  onExcessProperty: "error",
});
const decodeCredentialCandidate = Schema.decodeUnknownResult(CredentialCandidateSchema, {
  onExcessProperty: "error",
});
const decodeClientCandidate = Schema.decodeUnknownResult(ClientCandidateSchema, {
  onExcessProperty: "error",
});
const decodePairingCandidate = Schema.decodeUnknownResult(PairingCandidateSchema, {
  onExcessProperty: "error",
});
const decodeOwnerTransferCandidate = Schema.decodeUnknownResult(OwnerTransferCandidateSchema, {
  onExcessProperty: "error",
});
const decodeReplacementCredentialCandidate = Schema.decodeUnknownResult(
  ReplacementCredentialCandidateSchema,
  { onExcessProperty: "error" },
);
const decodeRecoveryGrantCandidate = Schema.decodeUnknownResult(RecoveryGrantCandidateSchema, {
  onExcessProperty: "error",
});
const emptyAuthority = (): AuthAuthority => ({
  version: 2,
  ownership: { state: "unclaimed", epoch: 0 },
  clients: [],
  pairings: [],
});

const makeAuthRegistry = (storage: AuthAuthorityStorage): AuthRegistryShape => {
  const failure = (reason: AuthRegistryFailureReason, message: string): AuthRegistryFailure =>
    new AuthRegistryFailure({ reason, message });
  const invalidAuthority = (): AuthRegistryFailure =>
    failure("invalid_authority", "Stored authentication authority is invalid");
  const invalidInput = (): AuthRegistryFailure =>
    failure("invalid_input", "Authentication input is invalid");
  const storageFailure = (): AuthRegistryFailure =>
    failure("storage", "Authentication storage operation failed");

  const parseAuthority = (
    value: unknown | undefined,
    nowMillis: number,
  ): Result.Result<AuthAuthority, AuthRegistryFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    const v2 = decodeAuthorityV2(value);
    if (Result.isSuccess(v2))
      return validAuthority(v2.success)
        ? Result.succeed(purgeExpired(v2.success, nowMillis))
        : Result.fail(invalidAuthority());
    const v1 = decodeAuthorityV1(value);
    if (Result.isFailure(v1) || !validAuthorityV1(v1.success))
      return Result.fail(invalidAuthority());
    return Result.succeed(migrateAuthority(v1.success, nowMillis));
  };

  const transact = <A>(
    operation: (
      authority: AuthAuthority,
      nowMillis: number,
    ) => Promise<
      Result.Result<{ readonly value: A; readonly authority: AuthAuthority }, AuthRegistryFailure>
    >,
  ): Effect.Effect<A, AuthRegistryFailure> =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: () =>
          storage.transaction(async (transaction) => {
            const decoded = parseAuthority(await transaction.get(), nowMillis);
            if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
            const result = await operation(decoded.success, nowMillis);
            if (Result.isFailure(result)) return Result.fail(result.failure);
            if (!validAuthority(result.success.authority)) return Result.fail(invalidAuthority());
            await transaction.put(result.success.authority);
            return Result.succeed(result.success.value);
          }),
        catch: storageFailure,
      }).pipe(Effect.flatMap(Effect.fromResult));
    });

  const makeClient = async (
    authority: AuthAuthority,
    candidateValue: unknown,
    nowMillis: number,
    ignoreCapacity = false,
  ): Promise<
    Result.Result<
      { readonly record: AuthClientRecord; readonly issued: IssuedClientCredential },
      AuthRegistryFailure
    >
  > => {
    const decoded = Result.mapError(decodeClientCandidate(candidateValue), invalidInput);
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    const candidate = decoded.success;
    if (!validCandidate(candidate.credential) || !validTtl(candidate.ttlMillis))
      return Result.fail(invalidInput());
    if (!ignoreCapacity && activeClients(authority, nowMillis).length >= MAX_CLIENTS)
      return Result.fail(failure("capacity", "Registered client limit reached"));
    if (authority.clients.some((client) => client.id === candidate.credential.id))
      return Result.fail(invalidInput());
    const now = toIso(nowMillis);
    const record: AuthClientRecord = {
      id: candidate.credential.id,
      credentialDigest: await sha256Hex(candidate.credential.secret),
      label: normalizeLabel(candidate.label),
      scopes: [...STANDARD_AUTH_SCOPES],
      createdAt: now,
      expiresAt: toIso(nowMillis + candidate.ttlMillis),
      lastSeenAt: now,
      ...(candidate.userAgent === undefined
        ? {}
        : { userAgent: candidate.userAgent.slice(0, 512) }),
    };
    const next = { ...authority, clients: [...authority.clients, record] };
    return Result.succeed({
      record,
      issued: {
        credential: formatCredential(CLIENT_CREDENTIAL_PREFIX, candidate.credential),
        client: toClientView(record, next),
      },
    });
  };

  return AuthRegistry.of({
    authenticate: (credentialValue) =>
      transact(async (authority, nowMillis) => {
        const authenticated = await authenticateClient(
          authority,
          credentialValue,
          nowMillis,
          failure,
        );
        if (Result.isFailure(authenticated)) return Result.fail(authenticated.failure);
        const isOwner = ownerClientId(authority) === authenticated.success.id;
        const renewed =
          isOwner &&
          Date.parse(authenticated.success.expiresAt) - nowMillis <= OWNER_RENEWAL_WINDOW_MILLIS;
        const nextClients = authority.clients.map((client) =>
          client.id === authenticated.success.id
            ? {
                ...client,
                lastSeenAt: toIso(nowMillis),
                ...(renewed ? { expiresAt: toIso(nowMillis + OWNER_TTL_MILLIS) } : {}),
              }
            : client,
        );
        const nextAuthority = { ...authority, clients: nextClients };
        const current = nextClients.find((client) => client.id === authenticated.success.id);
        if (!current) return Result.fail(invalidAuthority());
        return Result.succeed({
          value: { client: toClientView(current, nextAuthority), renewed },
          authority: nextAuthority,
        });
      }),

    issuePairing: (ownerCredential, candidateValue) =>
      transact(async (authority, nowMillis) => {
        const owner = await authenticateOwner(authority, ownerCredential, nowMillis, failure);
        if (Result.isFailure(owner)) return Result.fail(owner.failure);
        const decoded = Result.mapError(decodePairingCandidate(candidateValue), invalidInput);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const candidate = decoded.success;
        if (!validCandidate(candidate.credential) || !validTtl(candidate.ttlMillis))
          return Result.fail(invalidInput());
        if (authority.pairings.length >= MAX_PAIRINGS)
          return Result.fail(failure("capacity", "Active pairing link limit reached"));
        if (authority.pairings.some((pairing) => pairing.id === candidate.credential.id))
          return Result.fail(invalidInput());
        const record: PairingGrantRecord = {
          id: candidate.credential.id,
          credentialDigest: await sha256Hex(candidate.credential.secret),
          createdAt: toIso(nowMillis),
          expiresAt: toIso(nowMillis + candidate.ttlMillis),
          ...(candidate.label === undefined ? {} : { label: normalizeLabel(candidate.label) }),
        };
        return Result.succeed({
          value: {
            id: record.id,
            credential: formatCredential(PAIRING_CREDENTIAL_PREFIX, candidate.credential),
            expiresAt: record.expiresAt,
          },
          authority: { ...authority, pairings: [...authority.pairings, record] },
        });
      }),

    consumePairing: (credentialValue, clientValue) =>
      transact(async (authority, nowMillis) => {
        const parsed = parseCredential(credentialValue, PAIRING_CREDENTIAL_PREFIX, () =>
          pairingInvalid(failure),
        );
        if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
        const pairingIndex = authority.pairings.findIndex(
          (pairing) => pairing.id === parsed.success.id,
        );
        if (pairingIndex < 0) return Result.fail(pairingInvalid(failure));
        const pairing = authority.pairings[pairingIndex];
        const digest = await sha256Hex(parsed.success.secret);
        if (!safeDigestEqual(digest, pairing.credentialDigest))
          return Result.fail(pairingInvalid(failure));
        const decodedClient = decodeClientCandidate(clientValue);
        if (Result.isFailure(decodedClient)) return Result.fail(invalidInput());
        const preparedClient = {
          ...decodedClient.success,
          label: normalizeLabel(decodedClient.success.label || pairing.label || "Paired browser"),
        };
        const client = await makeClient(authority, preparedClient, nowMillis);
        if (Result.isFailure(client)) return Result.fail(client.failure);
        const nextAuthority = {
          ...authority,
          clients: [...authority.clients, client.success.record],
          pairings: authority.pairings.filter((_, index) => index !== pairingIndex),
        };
        return Result.succeed({
          value: {
            ...client.success.issued,
            client: toClientView(client.success.record, nextAuthority),
          },
          authority: nextAuthority,
        });
      }),

    listClients: (ownerCredential) =>
      transact(async (authority, nowMillis) => {
        const owner = await authenticateOwner(authority, ownerCredential, nowMillis, failure);
        if (Result.isFailure(owner)) return Result.fail(owner.failure);
        return Result.succeed({
          value: activeClients(authority, nowMillis)
            .map((client) => toClientView(client, authority, owner.success.id))
            .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
          authority,
        });
      }),

    revokeClient: (ownerCredential, clientId) =>
      transact(async (authority, nowMillis) => {
        const owner = await authenticateOwner(authority, ownerCredential, nowMillis, failure);
        if (Result.isFailure(owner)) return Result.fail(owner.failure);
        if (clientId === owner.success.id)
          return Result.fail(
            failure("self_revoke", "Transfer ownership before revoking the primary device"),
          );
        const client = activeClients(authority, nowMillis).find(
          (candidate) => candidate.id === clientId,
        );
        if (!client)
          return Result.fail(failure("client_missing", "Registered client was not found"));
        const nextAuthority: AuthAuthority = {
          version: 2,
          ownership: authority.ownership,
          clients: authority.clients.map((candidate) =>
            candidate.id === clientId ? { ...candidate, revokedAt: toIso(nowMillis) } : candidate,
          ),
          pairings: authority.pairings,
          ...(authority.ownerTransfer === undefined ||
          authority.ownerTransfer.targetClientId === clientId
            ? {}
            : { ownerTransfer: authority.ownerTransfer }),
          ...(authority.recoveryGrant === undefined
            ? {}
            : { recoveryGrant: authority.recoveryGrant }),
        };
        return Result.succeed({ value: undefined, authority: nextAuthority });
      }),

    logoutClient: (credentialValue) =>
      transact(async (authority, nowMillis) => {
        const client = await authenticateClient(authority, credentialValue, nowMillis, failure);
        if (Result.isFailure(client)) return Result.fail(client.failure);
        if (client.success.id === ownerClientId(authority))
          return Result.fail(
            failure("self_revoke", "Transfer ownership or use recovery before signing out"),
          );
        const nextAuthority: AuthAuthority = {
          version: 2,
          ownership: authority.ownership,
          clients: authority.clients.map((candidate) =>
            candidate.id === client.success.id
              ? { ...candidate, revokedAt: toIso(nowMillis) }
              : candidate,
          ),
          pairings: authority.pairings,
          ...(authority.ownerTransfer === undefined ||
          authority.ownerTransfer.targetClientId === client.success.id
            ? {}
            : { ownerTransfer: authority.ownerTransfer }),
          ...(authority.recoveryGrant === undefined
            ? {}
            : { recoveryGrant: authority.recoveryGrant }),
        };
        return Result.succeed({ value: undefined, authority: nextAuthority });
      }),

    startOwnerTransfer: (ownerCredential, candidateValue) =>
      transact(async (authority, nowMillis) => {
        const owner = await authenticateOwner(authority, ownerCredential, nowMillis, failure);
        if (Result.isFailure(owner)) return Result.fail(owner.failure);
        const decoded = Result.mapError(decodeOwnerTransferCandidate(candidateValue), invalidInput);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const candidate = decoded.success;
        if (
          !validCandidate(candidate.credential) ||
          !validTtl(candidate.ttlMillis) ||
          !validClientId(candidate.targetClientId) ||
          !validIdempotencyKey(candidate.idempotencyKey)
        )
          return Result.fail(invalidInput());
        const target = activeClients(authority, nowMillis).find(
          (client) => client.id === candidate.targetClientId && client.id !== owner.success.id,
        );
        if (!target)
          return Result.fail(failure("client_missing", "Registered client was not found"));
        const idempotencyKeyDigest =
          candidate.idempotencyKey === undefined
            ? undefined
            : await sha256Hex(candidate.idempotencyKey);
        if (authority.ownerTransfer) {
          if (
            idempotencyKeyDigest &&
            authority.ownerTransfer.idempotencyKeyDigest === idempotencyKeyDigest
          )
            return Result.fail(
              failure(
                "outcome_unknown",
                "Owner transfer was already issued; use its original link",
              ),
            );
          return Result.fail(
            failure(
              "transfer_pending",
              "Cancel the current owner transfer before starting another",
            ),
          );
        }
        if (authority.ownership.state !== "claimed") return Result.fail(ownerRequired(failure));
        const record: OwnerTransferRecord = {
          id: candidate.credential.id,
          credentialDigest: await sha256Hex(candidate.credential.secret),
          sourceOwnerClientId: owner.success.id,
          targetClientId: target.id,
          ownerEpoch: authority.ownership.epoch,
          createdAt: toIso(nowMillis),
          expiresAt: toIso(nowMillis + candidate.ttlMillis),
          ...(idempotencyKeyDigest === undefined ? {} : { idempotencyKeyDigest }),
        };
        return Result.succeed({
          value: {
            id: record.id,
            credential: formatCredential(OWNER_TRANSFER_CREDENTIAL_PREFIX, candidate.credential),
            transfer: toOwnerTransferView(record),
          },
          authority: { ...authority, ownerTransfer: record },
        });
      }),

    currentOwnerTransfer: (ownerCredential) =>
      transact(async (authority, nowMillis) => {
        const owner = await authenticateOwner(authority, ownerCredential, nowMillis, failure);
        if (Result.isFailure(owner)) return Result.fail(owner.failure);
        return Result.succeed({
          value: authority.ownerTransfer ? toOwnerTransferView(authority.ownerTransfer) : null,
          authority,
        });
      }),

    cancelOwnerTransfer: (ownerCredential, transferId) =>
      transact(async (authority, nowMillis) => {
        const owner = await authenticateOwner(authority, ownerCredential, nowMillis, failure);
        if (Result.isFailure(owner)) return Result.fail(owner.failure);
        if (!validClientId(transferId) || authority.ownerTransfer?.id !== transferId)
          return Result.fail(transferInvalid(failure));
        return Result.succeed({
          value: undefined,
          authority: {
            version: 2,
            ownership: authority.ownership,
            clients: authority.clients,
            pairings: authority.pairings,
            ...(authority.recoveryGrant === undefined
              ? {}
              : { recoveryGrant: authority.recoveryGrant }),
          },
        });
      }),

    acceptOwnerTransfer: (targetCredential, transferCredential, replacementValue) =>
      transact(async (authority, nowMillis) => {
        const invalid = transferInvalid(failure);
        const target = await authenticateClient(authority, targetCredential, nowMillis, failure);
        if (Result.isFailure(target)) return Result.fail(invalid);
        const parsed = parseCredential(
          transferCredential,
          OWNER_TRANSFER_CREDENTIAL_PREFIX,
          () => invalid,
        );
        if (Result.isFailure(parsed)) return Result.fail(invalid);
        const transfer = authority.ownerTransfer;
        if (!transfer || transfer.id !== parsed.success.id) return Result.fail(invalid);
        const digest = await sha256Hex(parsed.success.secret);
        const source = authority.clients.find(
          (client) =>
            client.id === transfer.sourceOwnerClientId &&
            !client.revokedAt &&
            Date.parse(client.expiresAt) > nowMillis,
        );
        if (
          !safeDigestEqual(digest, transfer.credentialDigest) ||
          target.success.id !== transfer.targetClientId ||
          authority.ownership.state !== "claimed" ||
          authority.ownership.ownerClientId !== transfer.sourceOwnerClientId ||
          authority.ownership.epoch !== transfer.ownerEpoch ||
          !source ||
          !canIncrementEpoch(authority.ownership.epoch)
        )
          return Result.fail(invalid);
        const replacement = decodeReplacementCredentialCandidate(replacementValue);
        if (
          Result.isFailure(replacement) ||
          !validSecret(replacement.success.secret) ||
          !validTtl(replacement.success.ttlMillis)
        )
          return Result.fail(invalidInput());
        const nextEpoch = authority.ownership.epoch + 1;
        const now = toIso(nowMillis);
        const replacementDigest = await sha256Hex(replacement.success.secret);
        const nextClients = authority.clients.map((client) => {
          if (client.id === target.success.id)
            return {
              ...client,
              credentialDigest: replacementDigest,
              expiresAt: toIso(nowMillis + replacement.success.ttlMillis),
              lastSeenAt: now,
            };
          return client.id === source.id ? { ...client, revokedAt: now } : client;
        });
        const targetIndex = nextClients.findIndex((client) => client.id === target.success.id);
        if (targetIndex < 0) return Result.fail(invalidAuthority());
        const nextAuthority: AuthAuthority = {
          version: 2,
          ownership: {
            state: "claimed",
            ownerClientId: target.success.id,
            epoch: nextEpoch,
          },
          clients: nextClients,
          pairings: [],
        };
        const nextTarget = nextClients[targetIndex];
        return Result.succeed({
          value: {
            credential: formatCredential(CLIENT_CREDENTIAL_PREFIX, {
              id: nextTarget.id,
              secret: replacement.success.secret,
            }),
            client: toClientView(nextTarget, nextAuthority, nextTarget.id),
          },
          authority: nextAuthority,
        });
      }),

    issueRecoveryGrant: (candidateValue) =>
      transact(async (authority, nowMillis) => {
        const decoded = Result.mapError(decodeRecoveryGrantCandidate(candidateValue), invalidInput);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const candidate = decoded.success;
        if (
          !validCandidate(candidate.credential) ||
          !validTtl(candidate.ttlMillis) ||
          !validIdempotencyKey(candidate.idempotencyKey)
        )
          return Result.fail(invalidInput());
        const idempotencyKeyDigest =
          candidate.idempotencyKey === undefined
            ? undefined
            : await sha256Hex(candidate.idempotencyKey);
        if (
          idempotencyKeyDigest &&
          authority.recoveryGrant?.idempotencyKeyDigest === idempotencyKeyDigest
        )
          return Result.fail(
            failure("outcome_unknown", "Recovery was already issued; use its original link"),
          );
        const record: RecoveryGrantRecord = {
          id: candidate.credential.id,
          credentialDigest: await sha256Hex(candidate.credential.secret),
          ownerEpoch: authority.ownership.epoch,
          createdAt: toIso(nowMillis),
          expiresAt: toIso(nowMillis + candidate.ttlMillis),
          ...(idempotencyKeyDigest === undefined ? {} : { idempotencyKeyDigest }),
        };
        return Result.succeed({
          value: {
            id: record.id,
            credential: formatCredential(RECOVERY_CREDENTIAL_PREFIX, candidate.credential),
            expiresAt: record.expiresAt,
          },
          authority: { ...authority, recoveryGrant: record },
        });
      }),

    consumeRecoveryGrant: (credentialValue, ownerClientValue) =>
      transact(async (authority, nowMillis) => {
        const invalid = recoveryInvalid(failure);
        const parsed = parseCredential(credentialValue, RECOVERY_CREDENTIAL_PREFIX, () => invalid);
        if (Result.isFailure(parsed)) return Result.fail(invalid);
        const grant = authority.recoveryGrant;
        if (!grant || grant.id !== parsed.success.id) return Result.fail(invalid);
        const digest = await sha256Hex(parsed.success.secret);
        if (
          !safeDigestEqual(digest, grant.credentialDigest) ||
          grant.ownerEpoch !== authority.ownership.epoch ||
          !canIncrementEpoch(authority.ownership.epoch)
        )
          return Result.fail(invalid);
        const client = await makeClient(authority, ownerClientValue, nowMillis, true);
        if (Result.isFailure(client)) return Result.fail(client.failure);
        const now = toIso(nowMillis);
        const nextClients = [
          ...authority.clients
            .filter((candidate) => candidate.revokedAt === undefined)
            .slice(0, MAX_CLIENTS * 2)
            .map((candidate) => ({ ...candidate, revokedAt: now })),
          client.success.record,
        ];
        const nextAuthority: AuthAuthority = {
          version: 2,
          ownership: {
            state: "claimed",
            ownerClientId: client.success.record.id,
            epoch: authority.ownership.epoch + 1,
          },
          clients: nextClients,
          pairings: [],
        };
        return Result.succeed({
          value: {
            ...client.success.issued,
            client: toClientView(client.success.record, nextAuthority, client.success.record.id),
          },
          authority: nextAuthority,
        });
      }),
  });
};

async function authenticateClient(
  authority: AuthAuthority,
  credentialValue: unknown,
  nowMillis: number,
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): Promise<Result.Result<AuthClientRecord, AuthRegistryFailure>> {
  const invalid = credentialInvalid(failure);
  const parsed = parseCredential(credentialValue, CLIENT_CREDENTIAL_PREFIX, () => invalid);
  if (Result.isFailure(parsed)) return Result.fail(invalid);
  const client = authority.clients.find(
    (candidate) =>
      candidate.id === parsed.success.id &&
      !candidate.revokedAt &&
      Date.parse(candidate.expiresAt) > nowMillis,
  );
  if (!client) return Result.fail(invalid);
  const digest = await sha256Hex(parsed.success.secret);
  return safeDigestEqual(digest, client.credentialDigest)
    ? Result.succeed(client)
    : Result.fail(invalid);
}

async function authenticateOwner(
  authority: AuthAuthority,
  credentialValue: unknown,
  nowMillis: number,
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): Promise<Result.Result<AuthClientRecord, AuthRegistryFailure>> {
  const client = await authenticateClient(authority, credentialValue, nowMillis, failure);
  if (
    Result.isFailure(client) ||
    authority.ownership.state !== "claimed" ||
    authority.ownership.ownerClientId !== client.success.id
  )
    return Result.fail(ownerRequired(failure));
  return client;
}

function parseCredential(
  value: unknown,
  prefix: string,
  onFailure: () => AuthRegistryFailure,
): Result.Result<CredentialCandidate, AuthRegistryFailure> {
  if (typeof value !== "string") return Result.fail(onFailure());
  const match = new RegExp(`^${prefix}\\.([0-9a-f]{12})\\.([A-Za-z0-9_-]{32,128})$`, "u").exec(
    value,
  );
  if (!match?.[1] || !match[2]) return Result.fail(onFailure());
  return Result.mapError(decodeCredentialCandidate({ id: match[1], secret: match[2] }), onFailure);
}

function formatCredential(prefix: string, candidate: CredentialCandidate): string {
  return `${prefix}.${candidate.id}.${candidate.secret}`;
}

function validCandidate(candidate: CredentialCandidate): boolean {
  return validClientId(candidate.id) && validSecret(candidate.secret);
}

function validClientId(value: string): boolean {
  return /^[0-9a-f]{12}$/u.test(value);
}

function validSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}

function validTtl(ttlMillis: number): boolean {
  return (
    Number.isInteger(ttlMillis) && ttlMillis >= 1_000 && ttlMillis <= 90 * 24 * 60 * 60 * 1_000
  );
}

function validIdempotencyKey(value: string | undefined): boolean {
  return value === undefined || /^[A-Za-z0-9._:-]{16,128}$/u.test(value);
}

function validAuthorityV1(authority: AuthAuthorityV1): boolean {
  return (
    authority.clients.length <= MAX_CLIENTS * 2 &&
    authority.pairings.length <= MAX_PAIRINGS &&
    uniqueIds(authority.clients) &&
    uniqueIds(authority.pairings) &&
    authority.clients.every(validClientRecordV1) &&
    authority.pairings.every(validPairingRecordV1)
  );
}

function validAuthority(authority: AuthAuthority): boolean {
  const ownerId = ownerClientId(authority);
  const owner =
    ownerId === undefined ? undefined : authority.clients.find((client) => client.id === ownerId);
  const transfer = authority.ownerTransfer;
  const recovery = authority.recoveryGrant;
  return (
    authority.clients.length <= MAX_CLIENTS * 2 + 1 &&
    authority.pairings.length <= MAX_PAIRINGS &&
    validEpoch(authority.ownership.epoch) &&
    (authority.ownership.state === "unclaimed" || Boolean(owner && !owner.revokedAt)) &&
    uniqueIds(authority.clients) &&
    uniqueIds(authority.pairings) &&
    authority.clients.every(validClientRecord) &&
    authority.pairings.every(validPairingRecord) &&
    (transfer === undefined ||
      (validOwnerTransferRecord(transfer) &&
        authority.ownership.state === "claimed" &&
        transfer.sourceOwnerClientId === authority.ownership.ownerClientId &&
        transfer.ownerEpoch === authority.ownership.epoch &&
        transfer.targetClientId !== transfer.sourceOwnerClientId &&
        authority.clients.some(
          (client) => client.id === transfer.targetClientId && client.revokedAt === undefined,
        ))) &&
    (recovery === undefined ||
      (validRecoveryGrantRecord(recovery) && recovery.ownerEpoch === authority.ownership.epoch))
  );
}

function validClientRecordV1(client: AuthClientRecordV1): boolean {
  return (
    validStoredCredential(client.id, client.credentialDigest) &&
    validLabel(client.label) &&
    validLegacyScopes(client.scopes) &&
    validRecordTimestamps(client) &&
    validClientMetadata(client)
  );
}

function validClientRecord(client: AuthClientRecord): boolean {
  return (
    validStoredCredential(client.id, client.credentialDigest) &&
    validLabel(client.label) &&
    exactStandardScopes(client.scopes) &&
    validRecordTimestamps(client) &&
    validClientMetadata(client)
  );
}

function validClientMetadata(client: {
  readonly lastSeenAt: string;
  readonly userAgent?: string;
  readonly revokedAt?: string;
}): boolean {
  return (
    Number.isFinite(Date.parse(client.lastSeenAt)) &&
    (client.userAgent === undefined || client.userAgent.length <= 512) &&
    (client.revokedAt === undefined || Number.isFinite(Date.parse(client.revokedAt)))
  );
}

function validPairingRecordV1(pairing: PairingGrantRecordV1): boolean {
  return (
    validStoredCredential(pairing.id, pairing.credentialDigest) &&
    validLegacyScopes(pairing.scopes) &&
    validRecordTimestamps(pairing) &&
    (pairing.label === undefined || validLabel(pairing.label))
  );
}

function validPairingRecord(pairing: PairingGrantRecord): boolean {
  return (
    validStoredCredential(pairing.id, pairing.credentialDigest) &&
    validRecordTimestamps(pairing) &&
    (pairing.label === undefined || validLabel(pairing.label))
  );
}

function validOwnerTransferRecord(transfer: OwnerTransferRecord): boolean {
  return (
    validStoredCredential(transfer.id, transfer.credentialDigest) &&
    validClientId(transfer.sourceOwnerClientId) &&
    validClientId(transfer.targetClientId) &&
    validEpoch(transfer.ownerEpoch) &&
    validRecordTimestamps(transfer) &&
    validOptionalDigest(transfer.idempotencyKeyDigest)
  );
}

function validRecoveryGrantRecord(grant: RecoveryGrantRecord): boolean {
  return (
    validStoredCredential(grant.id, grant.credentialDigest) &&
    validEpoch(grant.ownerEpoch) &&
    validRecordTimestamps(grant) &&
    validOptionalDigest(grant.idempotencyKeyDigest)
  );
}

function validStoredCredential(id: string, digest: string): boolean {
  return validClientId(id) && /^[0-9a-f]{64}$/u.test(digest);
}

function validOptionalDigest(value: string | undefined): boolean {
  return value === undefined || /^[0-9a-f]{64}$/u.test(value);
}

function validLegacyScopes(scopes: ReadonlyArray<AuthScope>): boolean {
  return scopes.length > 0 && new Set(scopes).size === scopes.length;
}

function exactStandardScopes(scopes: ReadonlyArray<StandardAuthScope>): boolean {
  return (
    scopes.length === STANDARD_AUTH_SCOPES.length &&
    STANDARD_AUTH_SCOPES.every((scope, index) => scopes[index] === scope)
  );
}

function validEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function canIncrementEpoch(value: number): boolean {
  return validEpoch(value) && value < Number.MAX_SAFE_INTEGER;
}

function validLabel(value: string): boolean {
  return value.length >= 1 && value.length <= 80;
}

function uniqueIds(records: ReadonlyArray<{ readonly id: string }>): boolean {
  return new Set(records.map((record) => record.id)).size === records.length;
}

function validRecordTimestamps(record: {
  readonly createdAt: string;
  readonly expiresAt: string;
}): boolean {
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt > createdAt;
}

function migrateAuthority(authority: AuthAuthorityV1, nowMillis: number): AuthAuthority {
  return {
    version: 2,
    ownership: { state: "unclaimed", epoch: 0 },
    clients: authority.clients
      .filter((client) => !client.revokedAt && Date.parse(client.expiresAt) > nowMillis)
      .map((client) => ({
        id: client.id,
        credentialDigest: client.credentialDigest,
        label: client.label,
        scopes: [...STANDARD_AUTH_SCOPES],
        createdAt: client.createdAt,
        expiresAt: client.expiresAt,
        lastSeenAt: client.lastSeenAt,
        ...(client.userAgent === undefined ? {} : { userAgent: client.userAgent }),
      })),
    pairings: [],
  };
}

function purgeExpired(authority: AuthAuthority, nowMillis: number): AuthAuthority {
  const ownerId = ownerClientId(authority);
  const clients = authority.clients.filter(
    (client) =>
      client.id === ownerId || (!client.revokedAt && Date.parse(client.expiresAt) > nowMillis),
  );
  const activeIds = new Set(
    clients
      .filter((client) => !client.revokedAt && Date.parse(client.expiresAt) > nowMillis)
      .map((client) => client.id),
  );
  const pairings = authority.pairings.filter(
    (pairing) => Date.parse(pairing.expiresAt) > nowMillis,
  );
  const ownerTransfer =
    authority.ownerTransfer &&
    Date.parse(authority.ownerTransfer.expiresAt) > nowMillis &&
    activeIds.has(authority.ownerTransfer.sourceOwnerClientId) &&
    activeIds.has(authority.ownerTransfer.targetClientId)
      ? authority.ownerTransfer
      : undefined;
  const recoveryGrant =
    authority.recoveryGrant &&
    Date.parse(authority.recoveryGrant.expiresAt) > nowMillis &&
    authority.recoveryGrant.ownerEpoch === authority.ownership.epoch
      ? authority.recoveryGrant
      : undefined;
  if (
    clients.length === authority.clients.length &&
    pairings.length === authority.pairings.length &&
    ownerTransfer === authority.ownerTransfer &&
    recoveryGrant === authority.recoveryGrant
  )
    return authority;
  return {
    version: 2,
    ownership: authority.ownership,
    clients,
    pairings,
    ...(ownerTransfer === undefined ? {} : { ownerTransfer }),
    ...(recoveryGrant === undefined ? {} : { recoveryGrant }),
  };
}

function activeClients(
  authority: AuthAuthority,
  nowMillis: number,
): ReadonlyArray<AuthClientRecord> {
  return authority.clients.filter(
    (client) => !client.revokedAt && Date.parse(client.expiresAt) > nowMillis,
  );
}

function ownerClientId(authority: AuthAuthority): string | undefined {
  return authority.ownership.state === "claimed" ? authority.ownership.ownerClientId : undefined;
}

function toClientView(
  client: AuthClientRecord,
  authority: AuthAuthority,
  currentClientId?: string,
): AuthClientView {
  const role = client.id === ownerClientId(authority) ? "owner" : "standard";
  return {
    id: client.id,
    label: client.label,
    scopes: role === "owner" ? [...ADMIN_AUTH_SCOPES] : [...STANDARD_AUTH_SCOPES],
    role,
    createdAt: client.createdAt,
    expiresAt: client.expiresAt,
    lastSeenAt: client.lastSeenAt,
    ...(client.userAgent === undefined ? {} : { userAgent: client.userAgent }),
    ...(client.id === currentClientId ? { current: true } : {}),
  };
}

function toOwnerTransferView(transfer: OwnerTransferRecord): OwnerTransferView {
  return {
    id: transfer.id,
    sourceOwnerClientId: transfer.sourceOwnerClientId,
    targetClientId: transfer.targetClientId,
    ownerEpoch: transfer.ownerEpoch,
    createdAt: transfer.createdAt,
    expiresAt: transfer.expiresAt,
  };
}

function normalizeLabel(value: string): string {
  const label = value.trim().replace(/\s+/gu, " ").slice(0, 80);
  return label || "Browser";
}

function toIso(millis: number): string {
  return new Date(millis).toISOString();
}

function safeDigestEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function credentialInvalid(
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): AuthRegistryFailure {
  return failure("credential_invalid", "Client credential is invalid or expired");
}

function ownerRequired(
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): AuthRegistryFailure {
  return failure("owner_required", "The current owner credential is required");
}

function pairingInvalid(
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): AuthRegistryFailure {
  return failure("pairing_invalid", "Pairing link is invalid or expired");
}

function transferInvalid(
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): AuthRegistryFailure {
  return failure("transfer_invalid", "Owner transfer is invalid or expired");
}

function recoveryInvalid(
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): AuthRegistryFailure {
  return failure("recovery_invalid", "Recovery link is invalid or expired");
}
