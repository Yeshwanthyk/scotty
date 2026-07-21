import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  m01bCanaryConfigFromEnvironment,
  m01bCanaryFaultDestinationLayer,
  m01bCanaryFaultFromEnvironment,
  m01bCanaryApprovedLocalPaths,
  m01bCanaryProgram,
  M01B_SYNTHETIC_SOURCE_ID,
} from "./account-secrets-store-canary.ts";
import {
  disposableLocalSecretOwnerKeyLayer,
  disposableLocalSecretSourceLayer,
} from "./local-secret-source.ts";
import {
  cloudflareWriteOnlySecretDestinationLive,
  writeOnlySecretProviderLayer,
} from "./write-only-secret-cloudflare.ts";

const expectedUid = (): number => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- deployment preflight boundary
    throw new Error("M01B requires a local POSIX user identity.");
  }
  return uid;
};

const secretProviders = Layer.unwrap(
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    m01bCanaryConfigFromEnvironment(stage, process.env);
    const paths = m01bCanaryApprovedLocalPaths(stage, process.env, expectedUid());
    const destination = m01bCanaryFaultDestinationLayer(
      m01bCanaryFaultFromEnvironment(process.env),
    ).pipe(Layer.provide(cloudflareWriteOnlySecretDestinationLive));
    return writeOnlySecretProviderLayer(
      disposableLocalSecretSourceLayer(paths, M01B_SYNTHETIC_SOURCE_ID),
      disposableLocalSecretOwnerKeyLayer(paths),
      destination,
    );
  }),
);

export const m01bCanaryProviders = secretProviders.pipe(Layer.provideMerge(Cloudflare.providers()));

export default Alchemy.Stack(
  "ScottyM01BSecretCanary",
  {
    providers: m01bCanaryProviders,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    return yield* m01bCanaryProgram(m01bCanaryConfigFromEnvironment(stage, process.env));
  }),
);
