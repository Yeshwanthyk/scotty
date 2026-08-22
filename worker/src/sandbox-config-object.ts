import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Result, Schema } from "effect";
import type { Bindings } from "./bindings";
import type { RepositoryRegistryEntry } from "../../protocol/repository";
import type {
  EnvironmentCredentialBinding,
  EnvironmentMaterialization,
  EnvironmentMutationResponse,
  EnvironmentVariablesView,
} from "./environment-contracts";
import {
  durableObjectEnvironmentStorage,
  EnvironmentStore,
  type EnvironmentFailure,
  environmentStoreLayer,
} from "./environment-store";
import type { SandboxActivateInput, SandboxConfigStatus } from "./sandbox-config-contracts";
import {
  SandboxConfigStore,
  type SandboxConfigFailure,
  durableObjectSandboxConfigAuthorityStorage,
  sandboxConfigStoreLayer,
} from "./sandbox-config-store";
import {
  InstallationRepoStore,
  type InstallationRepoFailure,
  durableObjectInstallationRepoStorage,
  installationRepoStoreLayer,
} from "./installation-repo-store";

export const SANDBOX_CONFIG_OBJECT_NAME = "account";

const decodeGlobalSecretName = Schema.decodeUnknownOption(Schema.NonEmptyString);

export interface SandboxConfigRpcError {
  readonly reason:
    | SandboxConfigFailure["reason"]
    | InstallationRepoFailure["reason"]
    | EnvironmentFailure["reason"];
  readonly message: string;
}

export type SandboxConfigRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: SandboxConfigRpcError };

const sandboxConfigRpcError = ({
  reason,
  message,
}: SandboxConfigFailure | InstallationRepoFailure | EnvironmentFailure): SandboxConfigRpcError => ({
  reason,
  message,
});

export class ScottySandboxConfig extends DurableObject<Bindings> {
  private readonly configLayer;
  private readonly repoLayer;
  private readonly environmentLayer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.configLayer = sandboxConfigStoreLayer(
      durableObjectSandboxConfigAuthorityStorage(ctx.storage),
    );
    this.repoLayer = installationRepoStoreLayer(durableObjectInstallationRepoStorage(ctx.storage));
    this.environmentLayer = environmentStoreLayer(durableObjectEnvironmentStorage(ctx.storage));
  }

  status(): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#runConfig(Effect.flatMap(SandboxConfigStore, (store) => store.status()));
  }
  /** Internal Worker/DO use only; this secret never crosses a public route. */
  resolveGlobalSecret(name: unknown): Promise<SandboxConfigRpcResult<string>> {
    const decoded = decodeGlobalSecretName(name);
    if (Option.isNone(decoded)) {
      return Promise.resolve({
        ok: false,
        error: { reason: "invalid_input", message: "Global secret name is invalid" },
      });
    }
    return this.#runEnvironment(
      Effect.flatMap(EnvironmentStore, (store) => store.resolveGlobalSecret(decoded.value)),
    );
  }

  activate(input: SandboxActivateInput): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#runConfig(Effect.flatMap(SandboxConfigStore, (store) => store.activate(input)));
  }

  listRepos(): Promise<SandboxConfigRpcResult<ReadonlyArray<RepositoryRegistryEntry>>> {
    return this.#runRepo(Effect.flatMap(InstallationRepoStore, (store) => store.list));
  }

  addRepo(input: unknown): Promise<SandboxConfigRpcResult<RepositoryRegistryEntry>> {
    return this.#runRepo(Effect.flatMap(InstallationRepoStore, (store) => store.upsert(input)));
  }

  removeRepo(repo: unknown): Promise<SandboxConfigRpcResult<boolean>> {
    return this.#runRepo(Effect.flatMap(InstallationRepoStore, (store) => store.remove(repo)));
  }
  listEnvironment(repo?: unknown): Promise<SandboxConfigRpcResult<EnvironmentVariablesView>> {
    return this.#runEnvironment(Effect.flatMap(EnvironmentStore, (store) => store.list(repo)));
  }
  materializeEnvironment(
    repo?: unknown,
  ): Promise<SandboxConfigRpcResult<EnvironmentMaterialization>> {
    return this.#runEnvironment(
      Effect.flatMap(EnvironmentStore, (store) => store.materialize(repo)),
    );
  }

  /**
   * Egress-boundary credential resolution: exact-origin lookup returning the declared
   * credential binding, or null when the origin is unmapped (deny-by-default).
   */
  resolveCredentialForOrigin(
    input: unknown,
  ): Promise<SandboxConfigRpcResult<EnvironmentCredentialBinding | null>> {
    return this.#runEnvironment(
      Effect.flatMap(EnvironmentStore, (store) => store.resolveCredentialForOrigin(input)),
    );
  }

  putEnvironment(
    name: unknown,
    input: unknown,
    repo?: unknown,
  ): Promise<SandboxConfigRpcResult<EnvironmentMutationResponse>> {
    return this.#runEnvironment(
      Effect.flatMap(EnvironmentStore, (store) => store.put(name, input, repo)),
    );
  }

  removeEnvironment(
    name: unknown,
    repo?: unknown,
  ): Promise<SandboxConfigRpcResult<EnvironmentMutationResponse>> {
    return this.#runEnvironment(
      Effect.flatMap(EnvironmentStore, (store) => store.remove(name, repo)),
    );
  }

  async #runConfig<A>(
    operation: Effect.Effect<A, SandboxConfigFailure, SandboxConfigStore>,
  ): Promise<SandboxConfigRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.configLayer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({ ok: false, error: sandboxConfigRpcError(error) }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }

  async #runEnvironment<A>(
    operation: Effect.Effect<A, EnvironmentFailure, EnvironmentStore>,
  ): Promise<SandboxConfigRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.environmentLayer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({ ok: false, error: sandboxConfigRpcError(error) }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }

  async #runRepo<A>(
    operation: Effect.Effect<A, InstallationRepoFailure, InstallationRepoStore>,
  ): Promise<SandboxConfigRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.repoLayer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({ ok: false, error: sandboxConfigRpcError(error) }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }
}

export type ScottySandboxConfigStub = {
  readonly status: () => Promise<SandboxConfigRpcResult<SandboxConfigStatus>>;
  /** Internal Worker/DO use only; never expose this result through a public API. */
  readonly resolveGlobalSecret: (name: unknown) => Promise<SandboxConfigRpcResult<string>>;
  readonly activate: (
    input: SandboxActivateInput,
  ) => Promise<SandboxConfigRpcResult<SandboxConfigStatus>>;
  readonly listRepos: () => Promise<SandboxConfigRpcResult<ReadonlyArray<RepositoryRegistryEntry>>>;
  readonly addRepo: (input: unknown) => Promise<SandboxConfigRpcResult<RepositoryRegistryEntry>>;
  readonly removeRepo: (repo: unknown) => Promise<SandboxConfigRpcResult<boolean>>;
  readonly listEnvironment: (
    repo?: unknown,
  ) => Promise<SandboxConfigRpcResult<EnvironmentVariablesView>>;
  readonly materializeEnvironment?: (
    repo?: unknown,
  ) => Promise<SandboxConfigRpcResult<EnvironmentMaterialization>>;
  readonly resolveCredentialForOrigin?: (
    input: unknown,
  ) => Promise<SandboxConfigRpcResult<EnvironmentCredentialBinding | null>>;
  readonly putEnvironment: (
    name: unknown,
    input: unknown,
    repo?: unknown,
  ) => Promise<SandboxConfigRpcResult<EnvironmentMutationResponse>>;
  readonly removeEnvironment: (
    name: unknown,
    repo?: unknown,
  ) => Promise<SandboxConfigRpcResult<EnvironmentMutationResponse>>;
};

export interface ScottySandboxConfigNamespace {
  readonly getByName: (name: string) => ScottySandboxConfigStub;
}
