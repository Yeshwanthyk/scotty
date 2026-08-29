import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Redacted, Result } from "effect";
import type { Bindings } from "./bindings";
import {
  CredentialRegistryFailure,
  CredentialStore,
  credentialStoreLayer,
  durableObjectCredentialRegistryStorage,
} from "./credential-store";
import {
  credentialCryptoLayer,
  directWorkerSecretInstallationWrappingKeyLayer,
} from "./credential-crypto";
import {
  decodeCredentialRegistryResolvedCredentialResult,
  type CredentialRegistryGrantInput,
  type CredentialRegistryGrantResult,
  type CredentialRegistryReleaseInput,
  type CredentialRegistryReleaseResult,
  type CredentialRegistryResolvedCredential,
  type CredentialRegistryResolveInput,
  type CredentialRegistryGithubCliResolveInput,
  type CredentialRegistrySyncInput,
  type CredentialRegistrySyncResult,
} from "./credential-contracts";
import type { CredentialRedactedMetadata } from "../../protocol/credentials";

export const CREDENTIAL_REGISTRY_OBJECT_NAME = "credential-registry";
const toResolvedCredentialWire = (
  resolved: Redacted.Redacted<string>,
): Effect.Effect<CredentialRegistryResolvedCredential, CredentialRegistryFailure> => {
  const value = Redacted.value(resolved);
  Redacted.wipeUnsafe(resolved);
  const decoded = decodeCredentialRegistryResolvedCredentialResult({ version: 1, value });
  return Result.isFailure(decoded)
    ? Effect.fail(
        new CredentialRegistryFailure({
          reason: "crypto_failed",
          message: "Credential cryptographic operation failed",
        }),
      )
    : Effect.succeed(decoded.success);
};

export interface CredentialRegistryRpcError {
  readonly reason: CredentialRegistryFailure["reason"];
  readonly message: string;
}

export type CredentialRegistryRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: CredentialRegistryRpcError };

export class ScottyCredentialRegistry extends DurableObject<Bindings> {
  private readonly layer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const cryptoLayer = credentialCryptoLayer.pipe(
      Layer.provide(directWorkerSecretInstallationWrappingKeyLayer(env.CREDENTIAL_WRAPPING_KEY)),
    );
    this.layer = credentialStoreLayer(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into the registry store
      durableObjectCredentialRegistryStorage(ctx.storage),
      env.SCOTTY_INSTALLATION_NAME ?? "",
    ).pipe(Layer.provide(cryptoLayer));
  }

  sync(
    input: CredentialRegistrySyncInput | unknown,
  ): Promise<CredentialRegistryRpcResult<CredentialRegistrySyncResult>> {
    return this.#run(Effect.flatMap(CredentialStore, (store) => store.sync(input)));
  }

  list(): Promise<CredentialRegistryRpcResult<ReadonlyArray<CredentialRedactedMetadata>>> {
    return this.#run(Effect.flatMap(CredentialStore, (store) => store.list));
  }

  issueGrants(
    input: CredentialRegistryGrantInput | unknown,
  ): Promise<CredentialRegistryRpcResult<CredentialRegistryGrantResult>> {
    return this.#run(Effect.flatMap(CredentialStore, (store) => store.issueGrants(input)));
  }

  resolve(
    input: CredentialRegistryResolveInput | unknown,
  ): Promise<CredentialRegistryRpcResult<CredentialRegistryResolvedCredential>> {
    return this.#run(
      Effect.flatMap(CredentialStore, (store) =>
        store.resolve(input).pipe(Effect.flatMap(toResolvedCredentialWire)),
      ),
    );
  }

  resolveGithubCliCredential(
    input: CredentialRegistryGithubCliResolveInput | unknown,
  ): Promise<CredentialRegistryRpcResult<CredentialRegistryResolvedCredential>> {
    return this.#run(
      Effect.flatMap(CredentialStore, (store) =>
        store.resolveGithubCliCredential(input).pipe(Effect.flatMap(toResolvedCredentialWire)),
      ),
    );
  }

  release(
    input: CredentialRegistryReleaseInput | unknown,
  ): Promise<CredentialRegistryRpcResult<CredentialRegistryReleaseResult>> {
    return this.#run(Effect.flatMap(CredentialStore, (store) => store.release(input)));
  }

  async #run<A>(
    operation: Effect.Effect<A, CredentialRegistryFailure, CredentialStore>,
  ): Promise<CredentialRegistryRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.layer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({
        ok: false,
        // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: Effect.Result has narrowed this value to CredentialRegistryFailure
        error: { reason: error.reason, message: error.message },
      }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }
}

export type ScottyCredentialRegistryStub = Pick<
  ScottyCredentialRegistry,
  "issueGrants" | "list" | "release" | "resolve" | "resolveGithubCliCredential" | "sync"
>;

export interface ScottyCredentialRegistryNamespace {
  readonly getByName: (name: string) => ScottyCredentialRegistryStub;
}
