import {
  DurableObject,
  DurableObjectState,
  type DurableObjectShape,
} from "alchemy/Cloudflare/Workers";
import type { RuntimeContext } from "alchemy";
import { Effect } from "effect";
import type { InstallationPiAuthRecord } from "../../protocol/pi-auth";
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

export const SANDBOX_CONFIG_OBJECT_NAME = "account";

export interface SandboxConfigRpcError {
  readonly reason: SandboxConfigFailure["reason"] | InstallationPiAuthFailureReason;
  readonly message: string;
}

export type SandboxConfigRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: SandboxConfigRpcError };

const sandboxConfigRpcError = ({
  reason,
  message,
}: SandboxConfigFailure | InstallationPiAuthFailure): SandboxConfigRpcError => ({
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

    return Effect.succeed({
      status: () => run(Effect.flatMap(SandboxConfigStore, (store) => store.status())),
      activate: (input: SandboxActivateInput) =>
        run(Effect.flatMap(SandboxConfigStore, (store) => store.activate(input))),
      piAuth: () => runPiAuth(Effect.flatMap(InstallationPiAuthStore, (store) => store.read)),
      writePiAuth: (input: InstallationPiAuthRecord) =>
        runPiAuth(Effect.flatMap(InstallationPiAuthStore, (store) => store.write(input))),
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
};

export interface ScottySandboxConfigNamespace {
  readonly getByName: (name: string) => ScottySandboxConfigStub;
}
