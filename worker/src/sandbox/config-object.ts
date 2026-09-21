import type { RuntimeCliPin } from "../../../protocol/runtime-cli-pin";
import { Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { verifyRuntimeImageCompatibility } from "../../../protocol/runtime-image-compatibility";
import { makeRuntimeCliReleaseResolverForClient } from "../runtime-cli/release-resolver";
import { makeRuntimeCliCacheForServices, r2RuntimeCliCacheBucket } from "../runtime-cli/cache";
import { makeRuntimeCliSelection, RuntimeCliSelectionFailure } from "../runtime-cli/selection";
import { readRuntimeCliArtifact } from "../runtime-cli/artifact";

const decodeCompatibilityJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
export type RuntimeCliSelectionRpcResult =
  | { readonly ok: true; readonly value: RuntimeCliPin }
  | { readonly ok: false; readonly reason: string };
import { DurableObject } from "cloudflare:workers";
import { Effect, Predicate, Result } from "effect";
import type { Bindings } from "../shared/bindings";
import type { RepositoryRegistryEntry } from "../../../protocol/settings/repository";
import type { CloudSettingsSnapshot } from "../../../protocol/settings/cloud-settings";
import type {
  SandboxActivateInput,
  SandboxConfigStatus,
  SandboxSettingsUpdate,
} from "./config-contracts";
import {
  SandboxConfigStore,
  durableRuntimeCliSelectionStorage,
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

  async selectRuntimeCli(): Promise<RuntimeCliSelectionRpcResult> {
    const program = Effect.gen({ self: this }, function* () {
      const raw = yield* decodeCompatibilityJson(
        this.env.SCOTTY_RUNTIME_IMAGE_COMPATIBILITY || "null",
      );
      const evidence = yield* verifyRuntimeImageCompatibility(
        raw,
        this.env.SCOTTY_CONTAINER_IMAGE_DIGEST ?? "",
      );
      const client = yield* HttpClient.HttpClient;
      const selection = makeRuntimeCliSelection(
        durableRuntimeCliSelectionStorage(this.ctx.storage),
        makeRuntimeCliReleaseResolverForClient(client),
        makeRuntimeCliCacheForServices(
          client,
          r2RuntimeCliCacheBucket(this.env.SANDBOX_BUNDLE_BUCKET),
        ),
      );
      const pin = yield* selection.select(evidence.compatibility);
      const body = yield* readRuntimeCliArtifact(this.env.SANDBOX_BUNDLE_BUCKET, pin.descriptor);
      yield* Effect.tryPromise({
        try: () => body.cancel(),
        catch: () => new RuntimeCliSelectionFailure({ reason: "storage" }),
      });
      return pin;
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.result);
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: native Durable Object RPC returns a Promise to the host
    const result = await Effect.runPromise(program);
    return Result.match(result, {
      onSuccess: (value) => ({ ok: true, value }),
      onFailure: (error) => ({
        ok: false,
        reason: Predicate.isTagged(error, "RuntimeImageCompatibilityError")
          ? `runtime_cli_${error.reason}`
          : // oxlint-disable-next-line scotty/no-manual-tag-check -- boundary: RPC exposes only a typed failure code, never upstream causes or request data
            error._tag,
      }),
    });
  }

  status(): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#runConfig(Effect.flatMap(SandboxConfigStore, (store) => store.status()));
  }

  settings(): Promise<SandboxConfigRpcResult<CloudSettingsSnapshot>> {
    return this.#runConfig(Effect.flatMap(SandboxConfigStore, (store) => store.settings()));
  }

  updateSettings(
    input: SandboxSettingsUpdate,
  ): Promise<SandboxConfigRpcResult<CloudSettingsSnapshot>> {
    return this.#runConfig(
      Effect.flatMap(SandboxConfigStore, (store) => store.updateSettings(input)),
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
  readonly selectRuntimeCli: () => Promise<RuntimeCliSelectionRpcResult>;
  readonly status: () => Promise<SandboxConfigRpcResult<SandboxConfigStatus>>;
  readonly activate: (
    input: SandboxActivateInput,
  ) => Promise<SandboxConfigRpcResult<SandboxConfigStatus>>;
  readonly settings: () => Promise<SandboxConfigRpcResult<CloudSettingsSnapshot>>;
  readonly updateSettings: (
    input: SandboxSettingsUpdate,
  ) => Promise<SandboxConfigRpcResult<CloudSettingsSnapshot>>;
  readonly listRepos: () => Promise<SandboxConfigRpcResult<ReadonlyArray<RepositoryRegistryEntry>>>;
  readonly addRepo: (input: unknown) => Promise<SandboxConfigRpcResult<RepositoryRegistryEntry>>;
  readonly removeRepo: (repo: unknown) => Promise<SandboxConfigRpcResult<boolean>>;
};

export interface ScottySandboxConfigNamespace {
  readonly getByName: (name: string) => ScottySandboxConfigStub;
}
