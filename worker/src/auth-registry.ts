import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";

const AUTHORITY_KEY = "scotty:auth-authority";
const CLIENT_CREDENTIAL_PREFIX = "scotty_client";
const PAIRING_CREDENTIAL_PREFIX = "scotty_pair";
const TERMINAL_TICKET_PREFIX = "scotty_pty";
const MAX_CLIENTS = 64;
const MAX_PAIRINGS = 32;
const MAX_TERMINAL_TICKETS = 128;

export const STANDARD_AUTH_SCOPES = [
  "sessions:read",
  "sessions:write",
  "terminal:connect",
] as const;

export const ADMIN_AUTH_SCOPES = [...STANDARD_AUTH_SCOPES, "access:read", "access:write"] as const;

export const AuthScopeSchema = Schema.Literals([
  "sessions:read",
  "sessions:write",
  "terminal:connect",
  "access:read",
  "access:write",
]);
export type AuthScope = typeof AuthScopeSchema.Type;

const AuthClientRecordSchema = Schema.Struct({
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
export type AuthClientRecord = typeof AuthClientRecordSchema.Type;

const PairingGrantRecordSchema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  label: Schema.optionalKey(Schema.String),
  scopes: Schema.Array(AuthScopeSchema),
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
type PairingGrantRecord = typeof PairingGrantRecordSchema.Type;

const TerminalTicketRecordSchema = Schema.Struct({
  id: Schema.String,
  credentialDigest: Schema.String,
  clientId: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
type TerminalTicketRecord = typeof TerminalTicketRecordSchema.Type;

export const AuthAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  clients: Schema.Array(AuthClientRecordSchema),
  pairings: Schema.Array(PairingGrantRecordSchema),
  terminalTickets: Schema.Array(TerminalTicketRecordSchema),
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
  scopes: Schema.Array(AuthScopeSchema),
  ttlMillis: Schema.Number,
  userAgent: Schema.optionalKey(Schema.String),
});
export type ClientCandidate = typeof ClientCandidateSchema.Type;

const PairingCandidateSchema = Schema.Struct({
  credential: CredentialCandidateSchema,
  label: Schema.optionalKey(Schema.String),
  scopes: Schema.Array(AuthScopeSchema),
  ttlMillis: Schema.Number,
});
export type PairingCandidate = typeof PairingCandidateSchema.Type;

const TerminalTicketCandidateSchema = Schema.Struct({
  credential: CredentialCandidateSchema,
  sessionId: Schema.String,
  ttlMillis: Schema.Number,
});
export type TerminalTicketCandidate = typeof TerminalTicketCandidateSchema.Type;

export interface AuthClientView {
  readonly id: string;
  readonly label: string;
  readonly scopes: ReadonlyArray<AuthScope>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly userAgent?: string;
  readonly current?: boolean;
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

export interface IssuedTerminalTicket {
  readonly credential: string;
  readonly expiresAt: string;
}

type AuthRegistryFailureReason =
  | "capacity"
  | "client_missing"
  | "credential_invalid"
  | "forbidden"
  | "invalid_authority"
  | "invalid_input"
  | "pairing_invalid"
  | "self_revoke"
  | "storage"
  | "ticket_invalid";

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
  readonly issuePairing: (
    candidate: unknown,
  ) => Effect.Effect<IssuedPairingGrant, AuthRegistryFailure>;
  readonly consumePairing: (
    credential: unknown,
    client: unknown,
  ) => Effect.Effect<IssuedClientCredential, AuthRegistryFailure>;
  readonly registerBootstrapClient: (
    client: unknown,
  ) => Effect.Effect<IssuedClientCredential, AuthRegistryFailure>;
  readonly authenticate: (
    credential: unknown,
  ) => Effect.Effect<AuthClientView, AuthRegistryFailure>;
  readonly listClients: (
    currentClientId?: string,
  ) => Effect.Effect<ReadonlyArray<AuthClientView>, AuthRegistryFailure>;
  readonly revokeClient: (
    clientId: string,
    currentClientId?: string,
  ) => Effect.Effect<void, AuthRegistryFailure>;
  readonly issueTerminalTicket: (
    parentCredential: unknown,
    candidate: unknown,
  ) => Effect.Effect<IssuedTerminalTicket, AuthRegistryFailure>;
  readonly consumeTerminalTicket: (
    credential: unknown,
    sessionId: string,
  ) => Effect.Effect<AuthClientView, AuthRegistryFailure>;
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

const decodeAuthority = Schema.decodeUnknownResult(AuthAuthoritySchema, {
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
const decodeTerminalTicketCandidate = Schema.decodeUnknownResult(TerminalTicketCandidateSchema, {
  onExcessProperty: "error",
});

const emptyAuthority = (): AuthAuthority => ({
  version: 1,
  clients: [],
  pairings: [],
  terminalTickets: [],
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
  ): Result.Result<AuthAuthority, AuthRegistryFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    return Result.mapError(decodeAuthority(value), invalidAuthority).pipe(
      Result.flatMap((authority) =>
        validAuthority(authority) ? Result.succeed(authority) : Result.fail(invalidAuthority()),
      ),
    );
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
            const decoded = parseAuthority(await transaction.get());
            if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
            const authority = purgeExpired(decoded.success, nowMillis);
            const result = await operation(authority, nowMillis);
            if (Result.isSuccess(result)) await transaction.put(result.success.authority);
            else if (authority !== decoded.success) await transaction.put(authority);
            return Result.map(result, ({ value }) => value);
          }),
        catch: storageFailure,
      }).pipe(Effect.flatMap(Effect.fromResult));
    });

  const makeClient = async (
    authority: AuthAuthority,
    candidateValue: unknown,
    nowMillis: number,
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
    if (activeClients(authority).length >= MAX_CLIENTS)
      return Result.fail(failure("capacity", "Registered client limit reached"));
    if (authority.clients.some((client) => client.id === candidate.credential.id))
      return Result.fail(invalidInput());
    const now = new Date(nowMillis).toISOString();
    const record: AuthClientRecord = {
      id: candidate.credential.id,
      credentialDigest: await runDigest(candidate.credential.secret),
      label: normalizeLabel(candidate.label),
      scopes: [...candidate.scopes],
      createdAt: now,
      expiresAt: new Date(nowMillis + candidate.ttlMillis).toISOString(),
      lastSeenAt: now,
      ...(candidate.userAgent === undefined
        ? {}
        : { userAgent: candidate.userAgent.slice(0, 512) }),
    };
    return Result.succeed({
      record,
      issued: {
        credential: formatCredential(CLIENT_CREDENTIAL_PREFIX, candidate.credential),
        client: toClientView(record),
      },
    });
  };

  return AuthRegistry.of({
    issuePairing: (candidateValue) =>
      transact(async (authority, nowMillis) => {
        const decoded = Result.mapError(decodePairingCandidate(candidateValue), invalidInput);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const candidate = decoded.success;
        if (!validCandidate(candidate.credential) || !validTtl(candidate.ttlMillis))
          return Result.fail(invalidInput());
        if (authority.pairings.length >= MAX_PAIRINGS)
          return Result.fail(failure("capacity", "Active pairing link limit reached"));
        if (authority.pairings.some((pairing) => pairing.id === candidate.credential.id))
          return Result.fail(invalidInput());
        const createdAt = new Date(nowMillis).toISOString();
        const expiresAt = new Date(nowMillis + candidate.ttlMillis).toISOString();
        const credentialDigest = await runDigest(candidate.credential.secret);
        const record: PairingGrantRecord = {
          id: candidate.credential.id,
          credentialDigest,
          scopes: [...candidate.scopes],
          createdAt,
          expiresAt,
          ...(candidate.label === undefined ? {} : { label: normalizeLabel(candidate.label) }),
        };
        return Result.succeed({
          value: {
            id: record.id,
            credential: formatCredential(PAIRING_CREDENTIAL_PREFIX, candidate.credential),
            expiresAt,
          },
          authority: { ...authority, pairings: [...authority.pairings, record] },
        });
      }),

    consumePairing: (credentialValue, clientValue) =>
      transact(async (authority, nowMillis) => {
        const parsed = parseCredential(credentialValue, PAIRING_CREDENTIAL_PREFIX, invalidInput);
        if (Result.isFailure(parsed)) return Result.fail(pairingInvalid(failure));
        const pairingIndex = authority.pairings.findIndex(
          (pairing) => pairing.id === parsed.success.id,
        );
        if (pairingIndex < 0) return Result.fail(pairingInvalid(failure));
        const pairing = authority.pairings[pairingIndex];
        const digest = await runDigest(parsed.success.secret);
        if (!safeDigestEqual(digest, pairing.credentialDigest))
          return Result.fail(pairingInvalid(failure));
        const decodedClient = decodeClientCandidate(clientValue);
        if (Result.isFailure(decodedClient)) return Result.fail(invalidInput());
        const preparedClient = {
          ...decodedClient.success,
          scopes: [...pairing.scopes],
          label: normalizeLabel(decodedClient.success.label || pairing.label || "Paired browser"),
        };
        const client = await makeClient(authority, preparedClient, nowMillis);
        if (Result.isFailure(client)) return Result.fail(client.failure);
        return Result.succeed({
          value: client.success.issued,
          authority: {
            ...authority,
            clients: [...authority.clients, client.success.record],
            pairings: authority.pairings.filter((_, index) => index !== pairingIndex),
          },
        });
      }),

    registerBootstrapClient: (clientValue) =>
      transact(async (authority, nowMillis) => {
        const client = await makeClient(authority, clientValue, nowMillis);
        if (Result.isFailure(client)) return Result.fail(client.failure);
        return Result.succeed({
          value: client.success.issued,
          authority: { ...authority, clients: [...authority.clients, client.success.record] },
        });
      }),

    authenticate: (credentialValue) =>
      transact(async (authority, nowMillis) => {
        const authenticated = await authenticateClient(
          authority,
          credentialValue,
          nowMillis,
          failure,
        );
        if (Result.isFailure(authenticated)) return Result.fail(authenticated.failure);
        const next = authority.clients.map((client) =>
          client.id === authenticated.success.id
            ? { ...client, lastSeenAt: new Date(nowMillis).toISOString() }
            : client,
        );
        const current = next.find((client) => client.id === authenticated.success.id);
        if (!current) return Result.fail(invalidAuthority());
        return Result.succeed({
          value: toClientView(current),
          authority: { ...authority, clients: next },
        });
      }),

    listClients: (currentClientId) =>
      transact(async (authority) =>
        Result.succeed({
          value: activeClients(authority)
            .map((client) => ({
              ...toClientView(client),
              ...(client.id === currentClientId ? { current: true } : {}),
            }))
            .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
          authority,
        }),
      ),

    revokeClient: (clientId, currentClientId) =>
      transact(async (authority, nowMillis) => {
        if (clientId === currentClientId)
          return Result.fail(failure("self_revoke", "Use sign out to revoke this browser"));
        const client = authority.clients.find((candidate) => candidate.id === clientId);
        if (!client || client.revokedAt)
          return Result.fail(failure("client_missing", "Registered client was not found"));
        const revokedAt = new Date(nowMillis).toISOString();
        return Result.succeed({
          value: undefined,
          authority: {
            ...authority,
            clients: authority.clients.map((candidate) =>
              candidate.id === clientId ? { ...candidate, revokedAt } : candidate,
            ),
            terminalTickets: authority.terminalTickets.filter(
              (ticket) => ticket.clientId !== clientId,
            ),
          },
        });
      }),

    issueTerminalTicket: (parentCredential, candidateValue) =>
      transact(async (authority, nowMillis) => {
        const authenticated = await authenticateClient(
          authority,
          parentCredential,
          nowMillis,
          failure,
        );
        if (Result.isFailure(authenticated)) return Result.fail(authenticated.failure);
        if (!authenticated.success.scopes.includes("terminal:connect"))
          return Result.fail(failure("forbidden", "Client cannot open terminals"));
        const decoded = Result.mapError(
          decodeTerminalTicketCandidate(candidateValue),
          invalidInput,
        );
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const candidate = decoded.success;
        if (!validCandidate(candidate.credential) || !validTtl(candidate.ttlMillis))
          return Result.fail(invalidInput());
        if (authority.terminalTickets.length >= MAX_TERMINAL_TICKETS)
          return Result.fail(failure("capacity", "Active terminal ticket limit reached"));
        const createdAt = new Date(nowMillis).toISOString();
        const expiresAt = new Date(nowMillis + candidate.ttlMillis).toISOString();
        const record: TerminalTicketRecord = {
          id: candidate.credential.id,
          credentialDigest: await runDigest(candidate.credential.secret),
          clientId: authenticated.success.id,
          sessionId: candidate.sessionId,
          createdAt,
          expiresAt,
        };
        return Result.succeed({
          value: {
            credential: formatCredential(TERMINAL_TICKET_PREFIX, candidate.credential),
            expiresAt,
          },
          authority: {
            ...authority,
            terminalTickets: [...authority.terminalTickets, record],
          },
        });
      }),

    consumeTerminalTicket: (credentialValue, sessionId) =>
      transact(async (authority) => {
        const parsed = parseCredential(credentialValue, TERMINAL_TICKET_PREFIX, invalidInput);
        if (Result.isFailure(parsed)) return Result.fail(ticketInvalid(failure));
        const ticketIndex = authority.terminalTickets.findIndex(
          (ticket) => ticket.id === parsed.success.id && ticket.sessionId === sessionId,
        );
        if (ticketIndex < 0) return Result.fail(ticketInvalid(failure));
        const ticket = authority.terminalTickets[ticketIndex];
        const digest = await runDigest(parsed.success.secret);
        if (!safeDigestEqual(digest, ticket.credentialDigest))
          return Result.fail(ticketInvalid(failure));
        const client = authority.clients.find(
          (candidate) => candidate.id === ticket.clientId && !candidate.revokedAt,
        );
        if (!client) return Result.fail(ticketInvalid(failure));
        return Result.succeed({
          value: toClientView(client),
          authority: {
            ...authority,
            terminalTickets: authority.terminalTickets.filter((_, index) => index !== ticketIndex),
          },
        });
      }),
  });
};

async function runDigest(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticateClient(
  authority: AuthAuthority,
  credentialValue: unknown,
  nowMillis: number,
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): Promise<Result.Result<AuthClientRecord, AuthRegistryFailure>> {
  const parsed = parseCredential(credentialValue, CLIENT_CREDENTIAL_PREFIX, () =>
    failure("credential_invalid", "Client credential is invalid or expired"),
  );
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const client = authority.clients.find(
    (candidate) =>
      candidate.id === parsed.success.id &&
      !candidate.revokedAt &&
      Date.parse(candidate.expiresAt) > nowMillis,
  );
  if (!client)
    return Result.fail(failure("credential_invalid", "Client credential is invalid or expired"));
  const digest = await runDigest(parsed.success.secret);
  return safeDigestEqual(digest, client.credentialDigest)
    ? Result.succeed(client)
    : Result.fail(failure("credential_invalid", "Client credential is invalid or expired"));
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
  const decoded = decodeCredentialCandidate({ id: match[1], secret: match[2] });
  return Result.mapError(decoded, onFailure);
}

function formatCredential(prefix: string, candidate: CredentialCandidate): string {
  return `${prefix}.${candidate.id}.${candidate.secret}`;
}

function validCandidate(candidate: CredentialCandidate): boolean {
  return /^[0-9a-f]{12}$/u.test(candidate.id) && /^[A-Za-z0-9_-]{32,128}$/u.test(candidate.secret);
}

function validTtl(ttlMillis: number): boolean {
  return (
    Number.isInteger(ttlMillis) && ttlMillis >= 1_000 && ttlMillis <= 90 * 24 * 60 * 60 * 1_000
  );
}

function validAuthority(authority: AuthAuthority): boolean {
  return (
    authority.clients.length <= MAX_CLIENTS * 2 &&
    authority.pairings.length <= MAX_PAIRINGS &&
    authority.terminalTickets.length <= MAX_TERMINAL_TICKETS &&
    uniqueIds(authority.clients) &&
    uniqueIds(authority.pairings) &&
    uniqueIds(authority.terminalTickets) &&
    authority.clients.every(validClientRecord) &&
    authority.pairings.every(validPairingRecord) &&
    authority.terminalTickets.every(validTerminalTicketRecord)
  );
}

function validClientRecord(client: AuthClientRecord): boolean {
  return (
    validStoredCredential(client.id, client.credentialDigest) &&
    client.label.length >= 1 &&
    client.label.length <= 80 &&
    validScopes(client.scopes) &&
    validRecordTimestamps(client) &&
    Number.isFinite(Date.parse(client.lastSeenAt)) &&
    (client.userAgent === undefined || client.userAgent.length <= 512) &&
    (client.revokedAt === undefined || Number.isFinite(Date.parse(client.revokedAt)))
  );
}

function validPairingRecord(pairing: PairingGrantRecord): boolean {
  return (
    validStoredCredential(pairing.id, pairing.credentialDigest) &&
    validScopes(pairing.scopes) &&
    validRecordTimestamps(pairing) &&
    (pairing.label === undefined || (pairing.label.length >= 1 && pairing.label.length <= 80))
  );
}

function validTerminalTicketRecord(ticket: TerminalTicketRecord): boolean {
  return (
    validStoredCredential(ticket.id, ticket.credentialDigest) &&
    /^[0-9a-f]{12}$/u.test(ticket.clientId) &&
    /^[a-z0-9][a-z0-9-]{5,31}$/u.test(ticket.sessionId) &&
    validRecordTimestamps(ticket)
  );
}

function validStoredCredential(id: string, digest: string): boolean {
  return /^[0-9a-f]{12}$/u.test(id) && /^[0-9a-f]{64}$/u.test(digest);
}

function validScopes(scopes: ReadonlyArray<AuthScope>): boolean {
  return scopes.length > 0 && new Set(scopes).size === scopes.length;
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

function purgeExpired(authority: AuthAuthority, nowMillis: number): AuthAuthority {
  const clients = authority.clients.filter(
    (client) => !client.revokedAt && Date.parse(client.expiresAt) > nowMillis,
  );
  const pairings = authority.pairings.filter(
    (pairing) => Date.parse(pairing.expiresAt) > nowMillis,
  );
  const terminalTickets = authority.terminalTickets.filter(
    (ticket) => Date.parse(ticket.expiresAt) > nowMillis,
  );
  if (
    clients.length === authority.clients.length &&
    pairings.length === authority.pairings.length &&
    terminalTickets.length === authority.terminalTickets.length
  )
    return authority;
  return {
    ...authority,
    clients,
    pairings,
    terminalTickets,
  };
}

function activeClients(authority: AuthAuthority): ReadonlyArray<AuthClientRecord> {
  return authority.clients.filter((client) => !client.revokedAt);
}

function toClientView(client: AuthClientRecord): AuthClientView {
  return {
    id: client.id,
    label: client.label,
    scopes: [...client.scopes],
    createdAt: client.createdAt,
    expiresAt: client.expiresAt,
    lastSeenAt: client.lastSeenAt,
    ...(client.userAgent === undefined ? {} : { userAgent: client.userAgent }),
  };
}

function normalizeLabel(value: string): string {
  const label = value.trim().replace(/\s+/gu, " ").slice(0, 80);
  return label || "Browser";
}

function safeDigestEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function pairingInvalid(
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): AuthRegistryFailure {
  return failure("pairing_invalid", "Pairing link is invalid or expired");
}

function ticketInvalid(
  failure: (reason: AuthRegistryFailureReason, message: string) => AuthRegistryFailure,
): AuthRegistryFailure {
  return failure("ticket_invalid", "Terminal ticket is invalid or expired");
}
