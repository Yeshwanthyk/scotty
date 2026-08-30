import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import type { Bindings } from "../shared/bindings";
import {
  type IssuedRunnerCredential,
  RunnerRegistry,
  type RunnerRegistryFailure,
  type RunnerRegistrationView,
  durableObjectRunnerAuthorityStorage,
  runnerRegistryLayer,
} from "./registry";

export interface RunnerRegistryRpcError {
  readonly reason: RunnerRegistryFailure["reason"];
  readonly message: string;
}

export type RunnerRegistryRpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: RunnerRegistryRpcError };

const runnerRegistryRpcError = ({
  reason,
  message,
}: RunnerRegistryFailure): RunnerRegistryRpcError => ({ reason, message });

export class ScottyRunnerRegistry extends DurableObject<Bindings> {
  private readonly layer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.layer = runnerRegistryLayer(durableObjectRunnerAuthorityStorage(ctx.storage));
  }

  authenticate(
    name: string,
    credential: string,
  ): Promise<RunnerRegistryRpcResult<RunnerRegistrationView>> {
    return this.#run(
      Effect.flatMap(RunnerRegistry, (registry) => registry.authenticate({ name, credential })),
    );
  }

  get(name: string): Promise<RunnerRegistryRpcResult<RunnerRegistrationView>> {
    return this.#run(Effect.flatMap(RunnerRegistry, (registry) => registry.get(name)));
  }

  list(): Promise<RunnerRegistryRpcResult<ReadonlyArray<RunnerRegistrationView>>> {
    return this.#run(Effect.flatMap(RunnerRegistry, (registry) => registry.list()));
  }

  register(
    name: string,
    replace: boolean,
  ): Promise<RunnerRegistryRpcResult<IssuedRunnerCredential>> {
    return this.#run(
      Effect.flatMap(RunnerRegistry, (registry) =>
        registry.register({
          name,
          credential: randomRunnerCredential(),
          replace,
        }),
      ),
    );
  }

  remove(name: string): Promise<RunnerRegistryRpcResult<void>> {
    return this.#run(Effect.flatMap(RunnerRegistry, (registry) => registry.remove(name)));
  }

  async #run<A>(
    operation: Effect.Effect<A, RunnerRegistryFailure, RunnerRegistry>,
  ): Promise<RunnerRegistryRpcResult<A>> {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Durable Object RPC methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(
      operation.pipe(Effect.provide(this.layer), Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => ({ ok: false, error: runnerRegistryRpcError(error) }),
      onSuccess: (value) => ({ ok: true, value }),
    });
  }
}

export type ScottyRunnerRegistryStub = {
  readonly authenticate: (
    name: string,
    credential: string,
  ) => Promise<RunnerRegistryRpcResult<RunnerRegistrationView>>;
  readonly get: (name: string) => Promise<RunnerRegistryRpcResult<RunnerRegistrationView>>;
  readonly list: () => Promise<RunnerRegistryRpcResult<ReadonlyArray<RunnerRegistrationView>>>;
  readonly register: (
    name: string,
    replace: boolean,
  ) => Promise<RunnerRegistryRpcResult<IssuedRunnerCredential>>;
  readonly remove: (name: string) => Promise<RunnerRegistryRpcResult<void>>;
};

export interface ScottyRunnerRegistryNamespace {
  readonly getByName: (name: string) => ScottyRunnerRegistryStub;
}

function randomRunnerCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const secret = btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  return `scotty_runner_${secret}`;
}
