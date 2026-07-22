import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import type { Bindings } from "./bindings";
import {
  ADMIN_AUTH_SCOPES,
  AuthRegistry,
  type AuthClientView,
  type AuthRegistryFailure,
  authRegistryLayer,
  durableObjectAuthAuthorityStorage,
  type IssuedClientCredential,
  type IssuedPairingGrant,
  type IssuedTerminalTicket,
  STANDARD_AUTH_SCOPES,
} from "./auth-registry";

const PAIRING_TTL_MILLIS = 5 * 60 * 1_000;
const CLIENT_TTL_MILLIS = 30 * 24 * 60 * 60 * 1_000;
const TERMINAL_TICKET_TTL_MILLIS = 5 * 60 * 1_000;

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

  issuePairing(label?: string): Promise<AuthRpcResult<IssuedPairingGrant>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.issuePairing({
          credential: randomCredentialCandidate(),
          scopes: [...STANDARD_AUTH_SCOPES],
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
          scopes: [...STANDARD_AUTH_SCOPES],
          ttlMillis: CLIENT_TTL_MILLIS,
          ...(userAgent === undefined ? {} : { userAgent }),
        }),
      ),
    );
  }

  registerBootstrapClient(
    label: string,
    userAgent?: string,
  ): Promise<AuthRpcResult<IssuedClientCredential>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.registerBootstrapClient({
          credential: randomCredentialCandidate(),
          label,
          scopes: [...ADMIN_AUTH_SCOPES],
          ttlMillis: CLIENT_TTL_MILLIS,
          ...(userAgent === undefined ? {} : { userAgent }),
        }),
      ),
    );
  }

  authenticate(credential: string): Promise<AuthRpcResult<AuthClientView>> {
    return this.#run(Effect.flatMap(AuthRegistry, (registry) => registry.authenticate(credential)));
  }

  listClients(currentClientId?: string): Promise<AuthRpcResult<ReadonlyArray<AuthClientView>>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) => registry.listClients(currentClientId)),
    );
  }

  revokeClient(clientId: string, currentClientId?: string): Promise<AuthRpcResult<void>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) => registry.revokeClient(clientId, currentClientId)),
    );
  }

  issueTerminalTicket(
    parentCredential: string,
    sessionId: string,
  ): Promise<AuthRpcResult<IssuedTerminalTicket>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.issueTerminalTicket(parentCredential, {
          credential: randomCredentialCandidate(),
          sessionId,
          ttlMillis: TERMINAL_TICKET_TTL_MILLIS,
        }),
      ),
    );
  }

  consumeTerminalTicket(
    credential: string,
    sessionId: string,
  ): Promise<AuthRpcResult<AuthClientView>> {
    return this.#run(
      Effect.flatMap(AuthRegistry, (registry) =>
        registry.consumeTerminalTicket(credential, sessionId),
      ),
    );
  }

  async #run<A>(
    operation: Effect.Effect<A, AuthRegistryFailure, AuthRegistry>,
  ): Promise<AuthRpcResult<A>> {
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.layer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({
        ok: false,
        error: { reason: error.reason, message: error.message },
      }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }
}

export type ScottyAuthRegistryStub = Pick<
  ScottyAuthRegistry,
  | "authenticate"
  | "consumePairing"
  | "consumeTerminalTicket"
  | "issuePairing"
  | "issueTerminalTicket"
  | "listClients"
  | "registerBootstrapClient"
  | "revokeClient"
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
