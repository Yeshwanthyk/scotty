import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  m01bCanaryApprovedLocalPaths,
  M01B_ROOT_KEY_FILE,
  M01B_SYNTHETIC_AUTH_FILE,
  M01B_SYNTHETIC_SOURCE_ID,
  M01B_STAGE_PREFIX,
} from "./account-secrets-store-canary.ts";
import {
  disposableLocalSecretSourceLayer,
  syncLocalSecretMetadata,
} from "./local-secret-source.ts";

const stage = process.env.ALCHEMY_STAGE ?? "";
const uid = process.getuid?.();

const program = Effect.gen(function* () {
  if (!new RegExp(`^${M01B_STAGE_PREFIX}[0-9a-f]{32}$`, "u").test(stage) || uid === undefined) {
    return yield* Effect.fail("invalid-local-canary-context" as const);
  }
  const paths = m01bCanaryApprovedLocalPaths(stage, process.env, uid);
  return yield* syncLocalSecretMetadata(M01B_SYNTHETIC_SOURCE_ID).pipe(
    Effect.provide(disposableLocalSecretSourceLayer(paths, M01B_SYNTHETIC_SOURCE_ID)),
  );
});

const exit = await Effect.runPromiseExit(program);
if (Exit.isSuccess(exit)) {
  process.stdout.write(`${JSON.stringify(exit.value)}\n`);
} else {
  process.stderr.write(
    `M01B sync failed; verify ALCHEMY_STAGE, ${M01B_SYNTHETIC_AUTH_FILE}, ${M01B_ROOT_KEY_FILE}, file ownership, mode, shape, and size.\n`,
  );
  process.exitCode = 1;
}
