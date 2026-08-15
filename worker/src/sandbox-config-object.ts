import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import type { Bindings } from "./bindings";
import type { InstallationPiAuthRecord } from "../../protocol/pi-auth";
import type { RepositoryRegistryEntry } from "../../protocol/repository";
import {
  InstallationPiAuthStore,
  type InstallationPiAuthFailure,
  type InstallationPiAuthFailureReason,
  durableObjectInstallationPiAuthStorage,
  installationPiAuthStoreLayer,
} from "./installation-pi-auth-store";
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

export interface SandboxConfigRpcError {
  readonly reason:
    | SandboxConfigFailure["reason"]
    | InstallationPiAuthFailureReason
    | InstallationRepoFailure["reason"];
  readonly message: string;
}

export type SandboxConfigRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: SandboxConfigRpcError };

const sandboxConfigRpcError = ({
  reason,
  message,
}:
  | SandboxConfigFailure
  | InstallationPiAuthFailure
  | InstallationRepoFailure): SandboxConfigRpcError => ({
  reason,
  message,
});

export class ScottySandboxConfig extends DurableObject<Bindings> {
  private readonly configLayer;
  private readonly piAuthLayer;
  private readonly repoLayer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.configLayer = sandboxConfigStoreLayer(
      durableObjectSandboxConfigAuthorityStorage(ctx.storage),
    );
    this.piAuthLayer = installationPiAuthStoreLayer(
      durableObjectInstallationPiAuthStorage(ctx.storage),
    );
    this.repoLayer = installationRepoStoreLayer(durableObjectInstallationRepoStorage(ctx.storage));
  }

  status(): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#runConfig(Effect.flatMap(SandboxConfigStore, (store) => store.status()));
  }

  activate(input: SandboxActivateInput): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#runConfig(Effect.flatMap(SandboxConfigStore, (store) => store.activate(input)));
  }

  piAuth(): Promise<SandboxConfigRpcResult<InstallationPiAuthRecord | null>> {
    return this.#runPiAuth(Effect.flatMap(InstallationPiAuthStore, (store) => store.read));
  }

  writePiAuth(
    input: InstallationPiAuthRecord,
  ): Promise<SandboxConfigRpcResult<InstallationPiAuthRecord>> {
    return this.#runPiAuth(Effect.flatMap(InstallationPiAuthStore, (store) => store.write(input)));
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

  async #runPiAuth<A>(
    operation: Effect.Effect<A, InstallationPiAuthFailure, InstallationPiAuthStore>,
  ): Promise<SandboxConfigRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.piAuthLayer), Effect.result),
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
  readonly piAuth: () => Promise<SandboxConfigRpcResult<InstallationPiAuthRecord | null>>;
  readonly writePiAuth: (
    input: InstallationPiAuthRecord,
  ) => Promise<SandboxConfigRpcResult<InstallationPiAuthRecord>>;
  readonly listRepos: () => Promise<SandboxConfigRpcResult<ReadonlyArray<RepositoryRegistryEntry>>>;
  readonly addRepo: (input: unknown) => Promise<SandboxConfigRpcResult<RepositoryRegistryEntry>>;
  readonly removeRepo: (repo: unknown) => Promise<SandboxConfigRpcResult<boolean>>;
};

export interface ScottySandboxConfigNamespace {
  readonly getByName: (name: string) => ScottySandboxConfigStub;
}
