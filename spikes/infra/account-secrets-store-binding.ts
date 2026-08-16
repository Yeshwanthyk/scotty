import * as Binding from "alchemy/Binding";
import { WorkerEnvironment, type Worker, type WorkerBinding } from "alchemy/Cloudflare";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WriteOnlySecretAttributes, WriteOnlySecretResource } from "./write-only-secret.ts";

export type AccountSecretsStoreWorkerBinding = Extract<
  WorkerBinding,
  { readonly type: "secrets_store_secret" }
>;

type ResolvedAccountSecretsStoreBindingReference = Pick<
  WriteOnlySecretAttributes,
  "bindingName" | "storeId" | "secretName"
>;

type AccountSecretsStoreBindingReference = {
  readonly bindingName: Input<string>;
  readonly storeId: Input<string>;
  readonly secretName: Input<string>;
};

export type AccountSecretsStoreWorkerBindingInput = {
  readonly type: "secrets_store_secret";
  readonly name: Input<string>;
  readonly storeId: Input<string>;
  readonly secretName: Input<string>;
};

/** Projects managed-secret output into Alchemy's identifier-only Worker binding. */
export function accountSecretsStoreWorkerBinding(
  reference: ResolvedAccountSecretsStoreBindingReference,
): AccountSecretsStoreWorkerBinding;
export function accountSecretsStoreWorkerBinding(
  reference: AccountSecretsStoreBindingReference,
): AccountSecretsStoreWorkerBindingInput;
export function accountSecretsStoreWorkerBinding(
  reference: AccountSecretsStoreBindingReference,
): AccountSecretsStoreWorkerBindingInput {
  return {
    type: "secrets_store_secret",
    name: reference.bindingName,
    storeId: reference.storeId,
    secretName: reference.secretName,
  };
}

/** Appends the secret reference without dropping existing desired Worker bindings. */
export const appendAccountSecretsStoreWorkerBinding = (
  bindings: readonly WorkerBinding[],
  reference: ResolvedAccountSecretsStoreBindingReference,
): readonly WorkerBinding[] => [...bindings, accountSecretsStoreWorkerBinding(reference)];

/**
 * Presence-only runtime client for a Scotty-managed Account Secrets Store
 * secret bound to a Worker. `raw` lazily reads the deployed Worker
 * environment entry as `unknown`; the client itself resolves to boolean
 * presence. It never calls `.get()` and never exposes a secret value.
 */
export interface WriteOnlySecretBindingClient extends Effect.Effect<
  boolean,
  never,
  WorkerEnvironment
> {
  readonly raw: Effect.Effect<unknown, never, WorkerEnvironment>;
}

/**
 * Binds a managed WriteOnlySecret to a Worker at deploy time and yields a
 * presence-only client. The wire binding carries identifiers only; the
 * secret value never enters props, bindings, outputs, or state.
 */
export interface WriteOnlySecretBinding extends Binding.Service<
  WriteOnlySecretBinding,
  "Scotty.WriteOnlySecretBinding",
  (secret: WriteOnlySecretResource, worker: Worker) => Effect.Effect<WriteOnlySecretBindingClient>
> {}

export const WriteOnlySecretBinding = Binding.Service<WriteOnlySecretBinding>(
  "Scotty.WriteOnlySecretBinding",
);

export const WriteOnlySecretBindingLive = Layer.effect(
  WriteOnlySecretBinding,
  Effect.succeed(
    Effect.fn(function* (secret: WriteOnlySecretResource, worker: Worker) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* worker.bind(secret.Props.bindingName, {
          bindings: [accountSecretsStoreWorkerBinding(secret.Props)],
        });
      }
      const raw: Effect.Effect<unknown, never, WorkerEnvironment> = Effect.gen(function* () {
        const env = yield* WorkerEnvironment;
        return env[secret.Props.bindingName];
      });
      return Object.assign(raw.pipe(Effect.map((value) => value !== undefined)), { raw });
    }),
  ),
);
