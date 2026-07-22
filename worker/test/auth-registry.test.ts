import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  ADMIN_AUTH_SCOPES,
  AuthRegistry,
  authRegistryLayer,
  STANDARD_AUTH_SCOPES,
  type AuthAuthority,
  type AuthAuthorityStorage,
  type AuthAuthorityTransaction,
  type ClientCandidate,
} from "../src/auth-registry";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const FIVE_MINUTES = 5 * 60 * 1_000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;

const secret = (character: string): string => character.repeat(43);

const clientCandidate = (
  id: string,
  secretValue: string,
  label = "Test browser",
): ClientCandidate => ({
  credential: { id, secret: secretValue },
  label,
  scopes: [...STANDARD_AUTH_SCOPES],
  ttlMillis: THIRTY_DAYS,
  userAgent: "Scotty test browser",
});

class MemoryAuthAuthorityStorage implements AuthAuthorityStorage {
  private value: unknown | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(value?: unknown) {
    this.value = value;
  }

  snapshot(): unknown | undefined {
    return structuredClone(this.value);
  }

  transaction = async <A>(
    operation: (transaction: AuthAuthorityTransaction) => Promise<A>,
  ): Promise<A> => {
    const preceding = this.tail;
    let unlock = (): void => undefined;
    this.tail = new Promise((resolve) => {
      unlock = resolve;
    });
    await preceding;
    let staged = structuredClone(this.value);
    try {
      const result = await operation({
        get: async () => structuredClone(staged),
        put: async (next) => {
          staged = structuredClone(next);
        },
      });
      this.value = staged;
      return result;
    } finally {
      unlock();
    }
  };
}

const withRegistry = <A, E>(
  storage: AuthAuthorityStorage,
  effect: Effect.Effect<A, E, AuthRegistry>,
): Effect.Effect<A, E> => Effect.provide(effect, authRegistryLayer(storage));

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("AuthRegistry", () => {
  it.effect("registers opaque clients while persisting only a digest", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const issued = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.registerBootstrapClient({
            ...clientCandidate("111111111111", secret("a"), "T3 Code"),
            scopes: [...ADMIN_AUTH_SCOPES],
          }),
        ),
      );

      assert.strictEqual(issued.credential, `scotty_client.111111111111.${secret("a")}`);
      assert.deepInclude(issued.client, {
        id: "111111111111",
        label: "T3 Code",
        scopes: [...ADMIN_AUTH_SCOPES],
        createdAt: "2026-07-22T12:00:00.000Z",
      });
      const persisted = JSON.stringify(storage.snapshot());
      assert.notInclude(persisted, secret("a"));
      assert.notInclude(persisted, "scotty_client");

      yield* TestClock.setTime(NOW + 10_000);
      const authenticated = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(issued.credential)),
      );
      assert.strictEqual(authenticated.id, "111111111111");
      assert.strictEqual(authenticated.lastSeenAt, "2026-07-22T12:00:10.000Z");
    }),
  );

  it.effect("consumes a pairing grant exactly once under a concurrent race", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const pairing = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issuePairing({
            credential: { id: "222222222222", secret: secret("b") },
            scopes: [...STANDARD_AUTH_SCOPES],
            ttlMillis: FIVE_MINUTES,
          }),
        ),
      );

      const results = yield* Effect.all(
        [
          withRegistry(
            storage,
            Effect.flatMap(AuthRegistry, (registry) =>
              registry.consumePairing(
                pairing.credential,
                clientCandidate("333333333333", secret("c"), "Helium"),
              ),
            ).pipe(Effect.result),
          ),
          withRegistry(
            storage,
            Effect.flatMap(AuthRegistry, (registry) =>
              registry.consumePairing(
                pairing.credential,
                clientCandidate("444444444444", secret("d"), "Phone"),
              ),
            ).pipe(Effect.result),
          ),
        ],
        { concurrency: "unbounded" },
      );

      assert.strictEqual(results.filter(Result.isSuccess).length, 1);
      assert.strictEqual(results.filter(Result.isFailure).length, 1);
      assert.deepInclude(failure(results.find(Result.isFailure) ?? Result.succeed(undefined)), {
        reason: "pairing_invalid",
        message: "Pairing link is invalid or expired",
      });
      const authority = storage.snapshot() as AuthAuthority;
      assert.strictEqual(authority.pairings.length, 0);
      assert.strictEqual(authority.clients.length, 1);
    }),
  );

  it.effect("expires pairing links and client credentials at the exact boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const pairing = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issuePairing({
            credential: { id: "555555555555", secret: secret("e") },
            scopes: [...STANDARD_AUTH_SCOPES],
            ttlMillis: FIVE_MINUTES,
          }),
        ),
      );
      const client = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.registerBootstrapClient({
            ...clientCandidate("666666666666", secret("f")),
            ttlMillis: 1_000,
          }),
        ),
      );

      yield* TestClock.setTime(NOW + 1_000);
      const expiredClient = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(client.credential)).pipe(
          Effect.result,
        ),
      );
      assert.deepInclude(failure(expiredClient), { reason: "credential_invalid" });

      yield* TestClock.setTime(NOW + FIVE_MINUTES);
      const expiredPairing = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.consumePairing(pairing.credential, clientCandidate("777777777777", secret("g"))),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(expiredPairing), { reason: "pairing_invalid" });
    }),
  );

  it.effect("revokes a client and all of its outstanding terminal tickets", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const client = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.registerBootstrapClient(
            clientCandidate("888888888888", secret("h"), "Disposable phone"),
          ),
        ),
      );
      const ticket = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issueTerminalTicket(client.credential, {
            credential: { id: "999999999999", secret: secret("i") },
            sessionId: "a0b1c2d3e4f5",
            ttlMillis: FIVE_MINUTES,
          }),
        ),
      );

      yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.revokeClient(client.client.id)),
      );

      const authResult = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(client.credential)).pipe(
          Effect.result,
        ),
      );
      assert.deepInclude(failure(authResult), { reason: "credential_invalid" });
      const ticketResult = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.consumeTerminalTicket(ticket.credential, "a0b1c2d3e4f5"),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(ticketResult), { reason: "ticket_invalid" });
    }),
  );

  it.effect("fails closed for malformed persisted authority", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage({
        version: 1,
        clients: [{ credentialDigest: "invented" }],
        pairings: [],
        terminalTickets: [],
      });
      const result = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.listClients()).pipe(Effect.result),
      );
      assert.deepInclude(failure(result), {
        reason: "invalid_authority",
        message: "Stored authentication authority is invalid",
      });
    }),
  );
});
