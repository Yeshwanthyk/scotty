import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import type { Bindings } from "../shared/bindings";
import type { RepositoryRegistryEntry } from "../../../protocol/repository";
import type { SandboxActivateInput, SandboxConfigStatus } from "./config-contracts";
import {
  SandboxConfigStore,
  type SandboxConfigFailure,
  durableObjectSandboxConfigAuthorityStorage,
  sandboxConfigStoreLayer,
} from "./config-store";
import {
  InstallationRepoStore,
  type InstallationRepoFailure,
  durableObjectInstallationRepoStorage,
  installationRepoStoreLayer,
} from "../repos/installation-store";

export const SANDBOX_CONFIG_OBJECT_NAME = "account";

export interface SandboxConfigRpcError {
  readonly reason: SandboxConfigFailure["reason"] | InstallationRepoFailure["reason"];
  readonly message: string;
}

export type SandboxConfigRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: SandboxConfigRpcError };

const sandboxConfigRpcError = ({
  reason,
  message,
}: SandboxConfigFailure | InstallationRepoFailure): SandboxConfigRpcError => ({
  reason,
  message,
});

export class ScottySandboxConfig extends DurableObject<Bindings> {
  private readonly configLayer;
  private readonly repoLayer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.configLayer = sandboxConfigStoreLayer(
      durableObjectSandboxConfigAuthorityStorage(ctx.storage),
    );
    this.repoLayer = installationRepoStoreLayer(durableObjectInstallationRepoStorage(ctx.storage));
  }

  status(): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#runConfig(Effect.flatMap(SandboxConfigStore, (store) => store.status()));
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
  readonly activate: (
    input: SandboxActivateInput,
  ) => Promise<SandboxConfigRpcResult<SandboxConfigStatus>>;
  readonly listRepos: () => Promise<SandboxConfigRpcResult<ReadonlyArray<RepositoryRegistryEntry>>>;
  readonly addRepo: (input: unknown) => Promise<SandboxConfigRpcResult<RepositoryRegistryEntry>>;
  readonly removeRepo: (repo: unknown) => Promise<SandboxConfigRpcResult<boolean>>;
};

export interface ScottySandboxConfigNamespace {
  readonly getByName: (name: string) => ScottySandboxConfigStub;
}
