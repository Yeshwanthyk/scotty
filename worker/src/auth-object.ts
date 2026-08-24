import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import type { Bindings } from "./bindings";
import {
  AuthRegistry,
  type AuthenticatedClient,
  type AuthClientView,
  type AuthRegistryFailure,
  authRegistryLayer,
  durableObjectAuthAuthorityStorage,
  type ConsumedHatchHandoff,
  type IssuedClientCredential,
  type IssuedHatchHandoff,
  type IssuedOwnerTransfer,
  type IssuedPairingGrant,
  type IssuedRecoveryGrant,
  type OwnerTransferView,
  type RootAuthorityView,
} from "./auth-registry";

const PAIRING_TTL_MILLIS = 5 * 60 * 1_000;
const CLIENT_TTL_MILLIS = 30 * 24 * 60 * 60 * 1_000;
const OWNER_TRANSFER_TTL_MILLIS = 5 * 60 * 1_000;
const RECOVERY_TTL_MILLIS = 5 * 60 * 1_000;
const HATCH_HANDOFF_TTL_MILLIS = 60 * 1_000;

export interface AuthRpcError {
  readonly reason: AuthRegistryFailure["reason"];
  readonly message: string;
}

export type AuthRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: AuthRpcError };

export class ScottyAuthRegistry extends DurableObject<Bindings> {
  private readonly layer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.layer = authRegistryLayer(durableObjectAuthAuthorityStorage(ctx.storage));
  }

  initializeRoot(rootCredential: string): Promise<AuthRpcResult<RootAuthorityView>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.initializeRoot(rootCredential, this.env.SCOTTY_ROOT_VERIFIER_BOOTSTRAP),
      ),
    );
  }

  authenticateRoot(rootCredential: string): Promise<AuthRpcResult<RootAuthorityView>> {
    const bootstrapVerifier = this.env.SCOTTY_ROOT_VERIFIER_BOOTSTRAP;
    return this.#run(
      Effect.gen(function* () {
        const registry = yield* AuthRegistry;
        yield* registry.initializeRoot(rootCredential, bootstrapVerifier);
        return yield* registry.authenticateRoot(rootCredential);
      }),
    );
  }

  rotateRoot(
    rootCredential: string,
    replacementCredential: string,
  ): Promise<AuthRpcResult<RootAuthorityView>> {
    const bootstrapVerifier = this.env.SCOTTY_ROOT_VERIFIER_BOOTSTRAP;
    return this.#run(
      Effect.gen(function* () {
        const registry = yield* AuthRegistry;
        yield* registry.initializeRoot(rootCredential, bootstrapVerifier);
        return yield* registry.rotateRoot(rootCredential, replacementCredential);
      }),
    );
  }

  authenticate(credential: string): Promise<AuthRpcResult<AuthenticatedClient>> {
    return this.#run(Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(credential)));
  }

  issuePairing(
    ownerCredential: string,
    label?: string,
  ): Promise<AuthRpcResult<IssuedPairingGrant>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.issuePairing(ownerCredential, {
          credential: randomCredentialCandidate(),
          ttlMillis: PAIRING_TTL_MILLIS,
          ...(label === undefined ? {} : { label }),
        }),
      ),
    );
  }

  consumePairing(
    credential: string,
    label: string,
    userAgent?: string,
  ): Promise<AuthRpcResult<IssuedClientCredential>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.consumePairing(credential, {
          credential: randomCredentialCandidate(),
          label,
          ttlMillis: CLIENT_TTL_MILLIS,
          ...(userAgent === undefined ? {} : { userAgent }),
        }),
      ),
    );
  }

  listClients(ownerCredential: string): Promise<AuthRpcResult<ReadonlyArray<AuthClientView>>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) => registry.listClients(ownerCredential)),
    );
  }

  revokeClient(ownerCredential: string, clientId: string): Promise<AuthRpcResult<void>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) => registry.revokeClient(ownerCredential, clientId)),
    );
  }

  logoutClient(credential: string): Promise<AuthRpcResult<void>> {
    return this.#run(Effect.flatMap(AuthRegistry, (registry) => registry.logoutClient(credential)));
  }

  startOwnerTransfer(
    ownerCredential: string,
    targetClientId: string,
    idempotencyKey?: string,
  ): Promise<AuthRpcResult<IssuedOwnerTransfer>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.startOwnerTransfer(ownerCredential, {
          credential: randomCredentialCandidate(),
          targetClientId,
          ttlMillis: OWNER_TRANSFER_TTL_MILLIS,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        }),
      ),
    );
  }

  currentOwnerTransfer(ownerCredential: string): Promise<AuthRpcResult<OwnerTransferView | null>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) => registry.currentOwnerTransfer(ownerCredential)),
    );
  }

  cancelOwnerTransfer(ownerCredential: string, transferId: string): Promise<AuthRpcResult<void>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.cancelOwnerTransfer(ownerCredential, transferId),
      ),
    );
  }

  acceptOwnerTransfer(
    targetCredential: string,
    transferCredential: string,
  ): Promise<AuthRpcResult<IssuedClientCredential>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.acceptOwnerTransfer(targetCredential, transferCredential, {
          secret: randomBase64Url(32),
          ttlMillis: CLIENT_TTL_MILLIS,
        }),
      ),
    );
  }

  issueRecoveryGrant(
    rootCredential: string,
    idempotencyKey?: string,
  ): Promise<AuthRpcResult<IssuedRecoveryGrant>> {
    const bootstrapVerifier = this.env.SCOTTY_ROOT_VERIFIER_BOOTSTRAP;
    return this.#run(
      Effect.gen(function* () {
        const registry = yield* AuthRegistry;
        yield* registry.initializeRoot(rootCredential, bootstrapVerifier);
        return yield* registry.issueRecoveryGrant(rootCredential, {
          credential: randomCredentialCandidate(),
          ttlMillis: RECOVERY_TTL_MILLIS,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
      }),
    );
  }

  consumeRecoveryGrant(
    credential: string,
    label: string,
    userAgent?: string,
  ): Promise<AuthRpcResult<IssuedClientCredential>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.consumeRecoveryGrant(credential, {
          credential: randomCredentialCandidate(),
          label,
          ttlMillis: CLIENT_TTL_MILLIS,
          ...(userAgent === undefined ? {} : { userAgent }),
        }),
      ),
    );
  }

  issueHatchHandoff(
    browserCredential: string,
    sessionId: string,
    hatchId: string,
  ): Promise<AuthRpcResult<IssuedHatchHandoff>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.issueHatchHandoff(browserCredential, {
          credential: randomCredentialCandidate(),
          sessionId,
          hatchId,
          ttlMillis: HATCH_HANDOFF_TTL_MILLIS,
        }),
      ),
    );
  }

  consumeHatchHandoff(
    credential: string,
    sessionId: string,
    hatchId: string,
  ): Promise<AuthRpcResult<ConsumedHatchHandoff>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.consumeHatchHandoff(credential, sessionId, hatchId),
      ),
    );
  }

  async #run<A>(
    operation: Effect.Effect<A, AuthRegistryFailure, AuthRegistry>,
  ): Promise<AuthRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.layer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({
        ok: false,
        // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: Effect.Result has narrowed this value to AuthRegistryFailure
        error: { reason: error.reason, message: error.message },
      }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }
}

export type ScottyAuthRegistryStub = Pick<
  ScottyAuthRegistry,
  | "acceptOwnerTransfer"
  | "authenticate"
  | "authenticateRoot"
  | "cancelOwnerTransfer"
  | "consumeHatchHandoff"
  | "consumePairing"
  | "consumeRecoveryGrant"
  | "currentOwnerTransfer"
  | "issueHatchHandoff"
  | "issuePairing"
  | "issueRecoveryGrant"
  | "initializeRoot"
  | "listClients"
  | "logoutClient"
  | "revokeClient"
  | "rotateRoot"
  | "startOwnerTransfer"
>;

export interface ScottyAuthRegistryNamespace {
  readonly getByName: (name: string) => ScottyAuthRegistryStub;
}

function randomCredentialCandidate(): { readonly id: string; readonly secret: string } {
  return { id: randomHex(6), secret: randomBase64Url(32) };
}

function randomHex(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomBase64Url(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}
