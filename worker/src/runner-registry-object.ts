import {
  DurableObject,
  DurableObjectState,
  type DurableObjectShape,
} from "alchemy/Cloudflare/Workers";
import type { RuntimeContext } from "alchemy";
import { Effect } from "effect";
import {
  type IssuedRunnerCredential,
  RunnerRegistry,
  type RunnerRegistryFailure,
  type RunnerRegistrationView,
  durableObjectRunnerAuthorityStorage,
  runnerRegistryLayer,
} from "./runner-registry";

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

interface ScottyRunnerRegistryShape extends DurableObjectShape {
  readonly authenticate: (
    name: string,
    credential: string,
  ) => Effect.Effect<RunnerRegistryRpcResult<RunnerRegistrationView>, never, RuntimeContext>;
  readonly get: (
    name: string,
  ) => Effect.Effect<RunnerRegistryRpcResult<RunnerRegistrationView>, never, RuntimeContext>;
  readonly list: () => Effect.Effect<
    RunnerRegistryRpcResult<ReadonlyArray<RunnerRegistrationView>>,
    never,
    RuntimeContext
  >;
  readonly register: (
    name: string,
    replace: boolean,
  ) => Effect.Effect<RunnerRegistryRpcResult<IssuedRunnerCredential>, never, RuntimeContext>;
  readonly remove: (
    name: string,
  ) => Effect.Effect<RunnerRegistryRpcResult<void>, never, RuntimeContext>;
}

export class ScottyRunnerRegistry extends DurableObject<
  ScottyRunnerRegistry,
  ScottyRunnerRegistryShape
>()("ScottyRunnerRegistry") {}

export default ScottyRunnerRegistry.make<never>(
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const layer = runnerRegistryLayer(durableObjectRunnerAuthorityStorage(state.raw.storage));

    const run = <A>(
      operation: Effect.Effect<A, RunnerRegistryFailure, RunnerRegistry>,
    ): Effect.Effect<RunnerRegistryRpcResult<A>, never, RuntimeContext> =>
      operation.pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            error: runnerRegistryRpcError(error),
          }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );

    return Effect.succeed({
      authenticate: (name: string, credential: string) =>
        run(
          Effect.flatMap(RunnerRegistry, (registry) => registry.authenticate({ name, credential })),
        ),
      get: (name: string) => run(Effect.flatMap(RunnerRegistry, (registry) => registry.get(name))),
      list: () => run(Effect.flatMap(RunnerRegistry, (registry) => registry.list())),
      register: (name: string, replace: boolean) =>
        run(
          Effect.flatMap(RunnerRegistry, (registry) =>
            registry.register({
              name,
              credential: randomRunnerCredential(),
              replace,
            }),
          ),
        ),
      remove: (name: string) =>
        run(Effect.flatMap(RunnerRegistry, (registry) => registry.remove(name))),
    });
  }),
);

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
