import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import type { Bindings } from "./bindings";
import type { SandboxActivateInput, SandboxConfigStatus } from "./sandbox-config-contracts";
import {
  SandboxConfigStore,
  type SandboxConfigFailure,
  durableObjectSandboxConfigAuthorityStorage,
  sandboxConfigStoreLayer,
} from "./sandbox-config-store";

export const SANDBOX_CONFIG_OBJECT_NAME = "account";

export interface SandboxConfigRpcError {
  readonly reason: SandboxConfigFailure["reason"];
  readonly message: string;
}

export type SandboxConfigRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: SandboxConfigRpcError };

export class ScottySandboxConfig extends DurableObject<Bindings> {
  private readonly layer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.layer = sandboxConfigStoreLayer(durableObjectSandboxConfigAuthorityStorage(ctx.storage));
  }

  status(): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#run(Effect.flatMap(SandboxConfigStore, (store) => store.status()));
  }

  activate(input: SandboxActivateInput): Promise<SandboxConfigRpcResult<SandboxConfigStatus>> {
    return this.#run(Effect.flatMap(SandboxConfigStore, (store) => store.activate(input)));
  }

  async #run<A>(
    operation: Effect.Effect<A, SandboxConfigFailure, SandboxConfigStore>,
  ): Promise<SandboxConfigRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.layer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({
        ok: false,
        // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: Effect.Result has narrowed this value to SandboxConfigFailure
        error: { reason: error.reason, message: error.message },
      }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }
}

export type ScottySandboxConfigStub = Pick<ScottySandboxConfig, "status" | "activate">;

export interface ScottySandboxConfigNamespace {
  readonly getByName: (name: string) => ScottySandboxConfigStub;
}
