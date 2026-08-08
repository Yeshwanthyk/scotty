import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  ADMIN_AUTH_SCOPES,
  AuthRegistry,
  AuthRegistryFailure,
  authRegistryLayer,
  STANDARD_AUTH_SCOPES,
  type AuthAuthority,
  type AuthAuthorityStorage,
  type AuthAuthorityTransaction,
  type ClientCandidate,
  type IssuedClientCredential,
} from "../src/auth-registry";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const FIVE_MINUTES = 5 * 60 * 1_000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;

const secret = (character: string): string => character.repeat(43);

const clientCandidate = (
  id: string,
  secretValue: string,
  label = "Test browser",
  ttlMillis = THIRTY_DAYS,
): ClientCandidate => ({
  credential: { id, secret: secretValue },
  label,
  ttlMillis,
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

const recoverOwner = (
  storage: AuthAuthorityStorage,
  id = "111111111111",
  secretValue = secret("a"),
  label = "Primary browser",
): Effect.Effect<IssuedClientCredential, AuthRegistryFailure> =>
  withRegistry(
    storage,
    Effect.gen(function* () {
      const registry = yield* AuthRegistry;
      const grant = yield* registry.issueRecoveryGrant({
        credential: { id: "aaaaaaaaaaaa", secret: secret("r") },
        ttlMillis: FIVE_MINUTES,
      });
      return yield* registry.consumeRecoveryGrant(
        grant.credential,
        clientCandidate(id, secretValue, label),
      );
    }),
  );

const pairClient = (
  storage: AuthAuthorityStorage,
  ownerCredential: string,
  id: string,
  secretValue: string,
  label: string,
): Effect.Effect<IssuedClientCredential, AuthRegistryFailure> =>
  withRegistry(
    storage,
    Effect.gen(function* () {
      const registry = yield* AuthRegistry;
      const pairing = yield* registry.issuePairing(ownerCredential, {
        credential: { id: id.replaceAll(/[1-9]/gu, "e"), secret: secret("p") },
        label,
        ttlMillis: FIVE_MINUTES,
      });
      return yield* registry.consumePairing(
        pairing.credential,
        clientCandidate(id, secretValue, label),
      );
    }),
  );

const failure = <A>(result: Result.Result<A, AuthRegistryFailure>): AuthRegistryFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("AuthRegistry ownership authority", () => {
  it.effect("creates the first owner only through recovery and stores standard scopes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);

      assert.strictEqual(owner.credential, `scotty_client.111111111111.${secret("a")}`);
      assert.deepInclude(owner.client, {
        id: "111111111111",
        role: "owner",
        scopes: [...ADMIN_AUTH_SCOPES],
        current: true,
      });

      const authority = storage.snapshot() as AuthAuthority;
      assert.deepStrictEqual(authority.ownership, {
        state: "claimed",
        ownerClientId: "111111111111",
        epoch: 1,
      });
      assert.deepStrictEqual(authority.clients[0]?.scopes, [...STANDARD_AUTH_SCOPES]);
      assert.notProperty(authority, "recoveryGrant");
      const persisted = JSON.stringify(authority);
      assert.notInclude(persisted, secret("a"));
      assert.notInclude(persisted, secret("r"));
      assert.notInclude(persisted, "scotty_client");
      assert.notInclude(persisted, "scotty_recovery");
    }),
  );

  it.effect("rejects non-current authority records", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage({
        version: 1,
        clients: [],
        pairings: [],
      });

      const result = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issueRecoveryGrant({
            credential: { id: "aaaaaaaaaaaa", secret: secret("r") },
            ttlMillis: FIVE_MINUTES,
          }),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(result), { reason: "invalid_authority" });
      assert.deepStrictEqual(storage.snapshot(), {
        version: 1,
        clients: [],
        pairings: [],
      });
    }),
  );

  it.effect(
    "renews the owner inside the final seven days and retains an expired owner record",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const storage = new MemoryAuthAuthorityStorage();
        const owner = yield* recoverOwner(storage);

        yield* TestClock.setTime(NOW + 24 * 24 * 60 * 60 * 1_000);
        const renewed = yield* withRegistry(
          storage,
          Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(owner.credential)),
        );
        assert.isTrue(renewed.renewed);
        assert.strictEqual(
          renewed.client.expiresAt,
          new Date(NOW + 54 * 24 * 60 * 60 * 1_000).toISOString(),
        );

        yield* TestClock.setTime(NOW + 54 * 24 * 60 * 60 * 1_000);
        const expired = yield* withRegistry(
          storage,
          Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(owner.credential)).pipe(
            Effect.result,
          ),
        );
        assert.deepInclude(failure(expired), { reason: "credential_invalid" });
        const authority = storage.snapshot() as AuthAuthority;
        assert.strictEqual(authority.clients[0]?.id, owner.client.id);
        assert.deepStrictEqual(authority.ownership, {
          state: "claimed",
          ownerClientId: owner.client.id,
          epoch: 1,
        });

        const replacement = yield* recoverOwner(
          storage,
          "222222222222",
          secret("b"),
          "Replacement primary",
        );
        assert.strictEqual(replacement.client.role, "owner");
        assert.strictEqual((storage.snapshot() as AuthAuthority).ownership.epoch, 2);
      }),
  );

  it.effect("requires the owner for pairing and consumes a pairing exactly once under a race", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);
      const standard = yield* pairClient(
        storage,
        owner.credential,
        "222222222222",
        secret("b"),
        "Phone",
      );

      const forbidden = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issuePairing(standard.credential, {
            credential: { id: "bbbbbbbbbbbb", secret: secret("q") },
            ttlMillis: FIVE_MINUTES,
          }),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(forbidden), { reason: "owner_required" });

      const pairing = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issuePairing(owner.credential, {
            credential: { id: "cccccccccccc", secret: secret("s") },
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
                clientCandidate("333333333333", secret("c"), "Tablet"),
              ),
            ).pipe(Effect.result),
          ),
          withRegistry(
            storage,
            Effect.flatMap(AuthRegistry, (registry) =>
              registry.consumePairing(
                pairing.credential,
                clientCandidate("444444444444", secret("d"), "Laptop"),
              ),
            ).pipe(Effect.result),
          ),
        ],
        { concurrency: "unbounded" },
      );

      assert.strictEqual(results.filter(Result.isSuccess).length, 1);
      assert.strictEqual(results.filter(Result.isFailure).length, 1);
      assert.deepInclude(
        failure(
          results.find(Result.isFailure) ??
            Result.fail(new AuthRegistryFailure({ reason: "storage", message: "missing" })),
        ),
        { reason: "pairing_invalid" },
      );
    }),
  );

  it.effect("prevents owner self-revocation and revokes standard clients", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);
      const standard = yield* pairClient(
        storage,
        owner.credential,
        "222222222222",
        secret("b"),
        "Phone",
      );
      const listed = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.listClients(owner.credential)),
      );
      assert.strictEqual(listed.find((client) => client.id === owner.client.id)?.role, "owner");
      assert.strictEqual(
        listed.find((client) => client.id === standard.client.id)?.role,
        "standard",
      );

      const selfRevoke = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.revokeClient(owner.credential, owner.client.id),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(selfRevoke), { reason: "self_revoke" });
      const ownerLogout = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.logoutClient(owner.credential)).pipe(
          Effect.result,
        ),
      );
      assert.deepInclude(failure(ownerLogout), { reason: "self_revoke" });

      yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.revokeClient(owner.credential, standard.client.id),
        ),
      );
      const standardAuth = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(standard.credential)).pipe(
          Effect.result,
        ),
      );
      assert.deepInclude(failure(standardAuth), { reason: "credential_invalid" });
    }),
  );

  it.effect("transfers ownership only to the bound target and rotates its credential", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);
      const target = yield* pairClient(
        storage,
        owner.credential,
        "222222222222",
        secret("b"),
        "New laptop",
      );
      const bystander = yield* pairClient(
        storage,
        owner.credential,
        "333333333333",
        secret("c"),
        "Phone",
      );
      yield* withRegistry(
        storage,
        Effect.gen(function* () {
          const registry = yield* AuthRegistry;
          yield* registry.issuePairing(owner.credential, {
            credential: { id: "444444444444", secret: secret("d") },
            ttlMillis: FIVE_MINUTES,
          });
          yield* registry.issueRecoveryGrant({
            credential: { id: "555555555555", secret: secret("e") },
            ttlMillis: FIVE_MINUTES,
          });
        }),
      );
      const transfer = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.startOwnerTransfer(owner.credential, {
            credential: { id: "777777777777", secret: secret("g") },
            targetClientId: target.client.id,
            ttlMillis: FIVE_MINUTES,
            idempotencyKey: "transfer-test-key-0001",
          }),
        ),
      );

      const wrongTarget = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.acceptOwnerTransfer(bystander.credential, transfer.credential, {
            secret: secret("h"),
            ttlMillis: THIRTY_DAYS,
          }),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(wrongTarget), {
        reason: "transfer_invalid",
        message: "Owner transfer is invalid or expired",
      });

      const accepted = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.acceptOwnerTransfer(target.credential, transfer.credential, {
            secret: secret("i"),
            ttlMillis: THIRTY_DAYS,
          }),
        ),
      );
      assert.strictEqual(accepted.credential, `scotty_client.${target.client.id}.${secret("i")}`);
      assert.strictEqual(accepted.client.role, "owner");

      const authority = storage.snapshot() as AuthAuthority;
      assert.deepStrictEqual(authority.ownership, {
        state: "claimed",
        ownerClientId: target.client.id,
        epoch: 2,
      });
      assert.lengthOf(authority.pairings, 0);
      assert.notProperty(authority, "ownerTransfer");
      assert.notProperty(authority, "recoveryGrant");

      for (const oldCredential of [owner.credential, target.credential]) {
        const oldAuth = yield* withRegistry(
          storage,
          Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(oldCredential)).pipe(
            Effect.result,
          ),
        );
        assert.deepInclude(failure(oldAuth), { reason: "credential_invalid" });
      }
      const bystanderAuth = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(bystander.credential)),
      );
      assert.strictEqual(bystanderAuth.client.role, "standard");

      const replay = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.acceptOwnerTransfer(accepted.credential, transfer.credential, {
            secret: secret("j"),
            ttlMillis: THIRTY_DAYS,
          }),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(replay), { reason: "transfer_invalid" });
    }),
  );

  it.effect("serializes transfer acceptance against cancellation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);
      const target = yield* pairClient(
        storage,
        owner.credential,
        "222222222222",
        secret("b"),
        "New laptop",
      );
      const transfer = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.startOwnerTransfer(owner.credential, {
            credential: { id: "333333333333", secret: secret("c") },
            targetClientId: target.client.id,
            ttlMillis: FIVE_MINUTES,
          }),
        ),
      );

      const outcomes = yield* Effect.all(
        [
          withRegistry(
            storage,
            Effect.flatMap(AuthRegistry, (registry) =>
              registry.cancelOwnerTransfer(owner.credential, transfer.id),
            ).pipe(Effect.result),
          ),
          withRegistry(
            storage,
            Effect.flatMap(AuthRegistry, (registry) =>
              registry.acceptOwnerTransfer(target.credential, transfer.credential, {
                secret: secret("d"),
                ttlMillis: THIRTY_DAYS,
              }),
            ).pipe(Effect.result),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const successCount =
        Number(Result.isSuccess(outcomes[0])) + Number(Result.isSuccess(outcomes[1]));
      assert.strictEqual(successCount, 1);

      const authority = storage.snapshot() as AuthAuthority;
      assert.notProperty(authority, "ownerTransfer");
      assert.isTrue(
        authority.ownership.state === "claimed" &&
          (authority.ownership.ownerClientId === owner.client.id ||
            authority.ownership.ownerClientId === target.client.id),
      );
    }),
  );

  it.effect("recovers by revoking every previous client and clearing transient authority", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);
      const standard = yield* pairClient(
        storage,
        owner.credential,
        "222222222222",
        secret("b"),
        "Phone",
      );
      const recovery = yield* withRegistry(
        storage,
        Effect.gen(function* () {
          const registry = yield* AuthRegistry;
          yield* registry.issuePairing(owner.credential, {
            credential: { id: "333333333333", secret: secret("c") },
            ttlMillis: FIVE_MINUTES,
          });
          return yield* registry.issueRecoveryGrant({
            credential: { id: "555555555555", secret: secret("e") },
            ttlMillis: FIVE_MINUTES,
          });
        }),
      );

      const replacement = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.consumeRecoveryGrant(
            recovery.credential,
            clientCandidate("666666666666", secret("f"), "Recovered laptop"),
          ),
        ),
      );
      assert.strictEqual(replacement.client.role, "owner");

      const authority = storage.snapshot() as AuthAuthority;
      assert.deepStrictEqual(authority.ownership, {
        state: "claimed",
        ownerClientId: replacement.client.id,
        epoch: 2,
      });
      assert.lengthOf(authority.pairings, 0);
      assert.notProperty(authority, "ownerTransfer");
      assert.notProperty(authority, "recoveryGrant");
      assert.isTrue(
        authority.clients
          .filter((client) => client.id !== replacement.client.id)
          .every((client) => client.revokedAt !== undefined),
      );

      for (const oldCredential of [owner.credential, standard.credential]) {
        const oldAuth = yield* withRegistry(
          storage,
          Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(oldCredential)).pipe(
            Effect.result,
          ),
        );
        assert.deepInclude(failure(oldAuth), { reason: "credential_invalid" });
      }
    }),
  );

  it.effect("expires pairings, transfers, recovery grants, and clients at the exact boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);
      const target = yield* pairClient(
        storage,
        owner.credential,
        "222222222222",
        secret("b"),
        "Target",
      );
      const transfer = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.startOwnerTransfer(owner.credential, {
            credential: { id: "333333333333", secret: secret("c") },
            targetClientId: target.client.id,
            ttlMillis: FIVE_MINUTES,
          }),
        ),
      );
      yield* TestClock.setTime(NOW + FIVE_MINUTES);
      const expiredTransfer = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.acceptOwnerTransfer(target.credential, transfer.credential, {
            secret: secret("d"),
            ttlMillis: THIRTY_DAYS,
          }),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(expiredTransfer), { reason: "transfer_invalid" });

      const recovery = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issueRecoveryGrant({
            credential: { id: "444444444444", secret: secret("e") },
            ttlMillis: FIVE_MINUTES,
          }),
        ),
      );
      yield* TestClock.setTime(NOW + 2 * FIVE_MINUTES);
      const expiredRecovery = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.consumeRecoveryGrant(
            recovery.credential,
            clientCandidate("555555555555", secret("f"), "Replacement"),
          ),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(expiredRecovery), { reason: "recovery_invalid" });
    }),
  );

  it.effect("keeps destructive recovery available at the stored-client ceiling", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const clients = Array.from({ length: 129 }, (_, index) => {
        const id = index.toString(16).padStart(12, "0");
        return {
          id,
          credentialDigest: "0".repeat(64),
          label: `Browser ${index}`,
          scopes: [...STANDARD_AUTH_SCOPES],
          createdAt: "2026-07-01T00:00:00.000Z",
          expiresAt: "2026-08-21T00:00:00.000Z",
          lastSeenAt: "2026-07-21T00:00:00.000Z",
        };
      });
      const storage = new MemoryAuthAuthorityStorage({
        version: 2,
        ownership: {
          state: "claimed",
          ownerClientId: "000000000000",
          epoch: 12,
        },
        clients,
        pairings: [],
      });
      const replacement = yield* withRegistry(
        storage,
        Effect.gen(function* () {
          const registry = yield* AuthRegistry;
          const recovery = yield* registry.issueRecoveryGrant({
            credential: { id: "eeeeeeeeeeee", secret: secret("e") },
            ttlMillis: FIVE_MINUTES,
          });
          return yield* registry.consumeRecoveryGrant(
            recovery.credential,
            clientCandidate("ffffffffffff", secret("f"), "Replacement"),
          );
        }),
      );

      assert.strictEqual(replacement.client.role, "owner");
      const authority = storage.snapshot() as AuthAuthority;
      assert.lengthOf(authority.clients, 129);
      assert.deepStrictEqual(authority.ownership, {
        state: "claimed",
        ownerClientId: "ffffffffffff",
        epoch: 13,
      });
      assert.isTrue(
        authority.clients
          .filter((client) => client.id !== replacement.client.id)
          .every((client) => client.revokedAt !== undefined),
      );
    }),
  );

  it.effect("issues a browser-bound Hatch handoff and consumes its digest exactly once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage();
      const owner = yield* recoverOwner(storage);
      const handoff = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.issueHatchHandoff(owner.credential, {
            credential: { id: "bbbbbbbbbbbb", secret: secret("h") },
            sessionId: "a0b1c2d3e4f5",
            hatchId: "hatch-primary",
            ttlMillis: 60_000,
          }),
        ),
      );
      const authority = storage.snapshot() as AuthAuthority;
      assert.lengthOf(authority.hatchHandoffs ?? [], 1);
      assert.notInclude(JSON.stringify(authority), handoff.credential);
      assert.notInclude(JSON.stringify(authority), secret("h"));

      const [first, second] = yield* Effect.all(
        [
          withRegistry(
            storage,
            Effect.flatMap(AuthRegistry, (registry) =>
              registry.consumeHatchHandoff(handoff.credential, "a0b1c2d3e4f5", "hatch-primary"),
            ).pipe(Effect.result),
          ),
          withRegistry(
            storage,
            Effect.flatMap(AuthRegistry, (registry) =>
              registry.consumeHatchHandoff(handoff.credential, "a0b1c2d3e4f5", "hatch-primary"),
            ).pipe(Effect.result),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const outcomes = [first, second];
      assert.strictEqual(outcomes.filter(Result.isSuccess).length, 1);
      assert.strictEqual(outcomes.filter(Result.isFailure).length, 1);
      const consumed = outcomes.find(Result.isSuccess);
      assert.ok(consumed);
      assert.deepStrictEqual(consumed.success, {
        browserClientId: owner.client.id,
        sessionId: "a0b1c2d3e4f5",
        hatchId: "hatch-primary",
      });
      const rejected = outcomes.find(Result.isFailure);
      assert.ok(rejected);
      assert.strictEqual(rejected.failure.reason, "handoff_invalid");
    }),
  );

  it.effect("fails closed for malformed V2 authority", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = new MemoryAuthAuthorityStorage({
        version: 2,
        ownership: {
          state: "claimed",
          ownerClientId: "111111111111",
          epoch: 9,
        },
        clients: [],
        pairings: [],
      });
      const result = yield* withRegistry(
        storage,
        Effect.flatMap(AuthRegistry, (registry) =>
          registry.authenticate(`scotty_client.111111111111.${secret("a")}`),
        ).pipe(Effect.result),
      );
      assert.deepInclude(failure(result), {
        reason: "invalid_authority",
        message: "Stored authentication authority is invalid",
      });
    }),
  );
});
