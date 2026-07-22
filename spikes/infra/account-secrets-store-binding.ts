import type { WorkerBinding } from "alchemy/Cloudflare";
import type { Input } from "alchemy/Input";
import type { WriteOnlySecretAttributes } from "./write-only-secret.ts";

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
