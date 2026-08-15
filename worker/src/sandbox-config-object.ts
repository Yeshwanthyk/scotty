import {
  DurableObject,
  DurableObjectState,
  type DurableObjectShape,
} from "alchemy/Cloudflare/Workers";
import type { RuntimeContext } from "alchemy";
import { Effect } from "effect";
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

interface ScottySandboxConfigShape extends DurableObjectShape {
  readonly status: () => Effect.Effect<
    SandboxConfigRpcResult<SandboxConfigStatus>,
    never,
    RuntimeContext
  >;
  readonly activate: (
    input: SandboxActivateInput,
  ) => Effect.Effect<SandboxConfigRpcResult<SandboxConfigStatus>, never, RuntimeContext>;
  readonly piAuth: () => Effect.Effect<
    SandboxConfigRpcResult<InstallationPiAuthRecord | null>,
    never,
    RuntimeContext
  >;
  readonly writePiAuth: (
    input: InstallationPiAuthRecord,
  ) => Effect.Effect<SandboxConfigRpcResult<InstallationPiAuthRecord>, never, RuntimeContext>;
  readonly listRepos: () => Effect.Effect<
    SandboxConfigRpcResult<ReadonlyArray<RepositoryRegistryEntry>>,
    never,
    RuntimeContext
  >;
  readonly addRepo: (
    input: unknown,
  ) => Effect.Effect<SandboxConfigRpcResult<RepositoryRegistryEntry>, never, RuntimeContext>;
  readonly removeRepo: (
    repo: unknown,
  ) => Effect.Effect<SandboxConfigRpcResult<boolean>, never, RuntimeContext>;
}

export class ScottySandboxConfig extends DurableObject<
  ScottySandboxConfig,
  ScottySandboxConfigShape
>()("ScottySandboxConfig") {}

export default ScottySandboxConfig.make<never>(
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const layer = sandboxConfigStoreLayer(
      durableObjectSandboxConfigAuthorityStorage(state.raw.storage),
    );
    const piAuthLayer = installationPiAuthStoreLayer(
      durableObjectInstallationPiAuthStorage(state.raw.storage),
    );
    const repoLayer = installationRepoStoreLayer(
      durableObjectInstallationRepoStorage(state.raw.storage),
    );

    const run = <A>(
      operation: Effect.Effect<A, SandboxConfigFailure, SandboxConfigStore>,
    ): Effect.Effect<SandboxConfigRpcResult<A>, never, RuntimeContext> =>
      operation.pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            error: sandboxConfigRpcError(error),
          }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );

    const runPiAuth = <A>(
      operation: Effect.Effect<A, InstallationPiAuthFailure, InstallationPiAuthStore>,
    ): Effect.Effect<SandboxConfigRpcResult<A>, never, RuntimeContext> =>
      operation.pipe(
        Effect.provide(piAuthLayer),
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error: sandboxConfigRpcError(error) }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );

    const runRepo = <A>(
      operation: Effect.Effect<A, InstallationRepoFailure, InstallationRepoStore>,
    ): Effect.Effect<SandboxConfigRpcResult<A>, never, RuntimeContext> =>
      operation.pipe(
        Effect.provide(repoLayer),
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error: sandboxConfigRpcError(error) }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );

    return Effect.succeed({
      status: () => run(Effect.flatMap(SandboxConfigStore, (store) => store.status())),
      activate: (input: SandboxActivateInput) =>
        run(Effect.flatMap(SandboxConfigStore, (store) => store.activate(input))),
      piAuth: () => runPiAuth(Effect.flatMap(InstallationPiAuthStore, (store) => store.read)),
      writePiAuth: (input: InstallationPiAuthRecord) =>
        runPiAuth(Effect.flatMap(InstallationPiAuthStore, (store) => store.write(input))),
      listRepos: () => runRepo(Effect.flatMap(InstallationRepoStore, (store) => store.list)),
      addRepo: (input: unknown) =>
        runRepo(Effect.flatMap(InstallationRepoStore, (store) => store.upsert(input))),
      removeRepo: (repo: unknown) =>
        runRepo(Effect.flatMap(InstallationRepoStore, (store) => store.remove(repo))),
    });
  }),
);

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
