import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CopyError, decode } from "./oci.ts";
const Stage = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)));
const error = (step) => new CopyError({ step, status: 0 });
const args = process.argv.slice(2);
const stageAt = args.indexOf("--stage");
const stage = stageAt < 0 ? undefined : args[stageAt + 1];
const input = {
  source: process.env.SCOTTY_SOURCE_IMAGE,
  account: process.env.CLOUDFLARE_ACCOUNT_ID,
  repository: process.env.SCOTTY_REGISTRY_REPOSITORY,
};
const program = Effect.gen(function* () {
  if (!stage || args.filter((arg) => arg === "--stage").length !== 1 || stage.startsWith("--"))
    return yield* error("explicit --stage required");
  const validStage = yield* decode(Stage, stage, "stage");
  if (validStage === "production" || validStage.startsWith("scotty-baseline-"))
    return yield* error("stage reserved");
  const valid = yield* decode(
    Schema.Struct({ source: Schema.String, account: Schema.String, repository: Schema.String }),
    input,
    "required environment",
  );
  // copyImage performs the strict digest/account/repository validation before obtaining credentials.
  const { copyImage, copyLayer } = yield* Effect.tryPromise({
    try: () => import("./image.ts"),
    catch: () => error("image copier unavailable"),
  });
  const image = yield* copyImage(valid).pipe(Effect.provide(copyLayer));
  const exit = yield* Effect.tryPromise({
    try: () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          "./node_modules/.bin/alchemy",
          ["deploy", "--profile", "default", "--yes", "--no-input", ...args],
          {
            env: { ...process.env, SCOTTY_IMAGE: image },
            stdio: "inherit",
          },
        );
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      }),
    catch: () => error("alchemy launch/exit"),
  });
  if (exit !== 0) return yield* error("alchemy deploy");
});
Effect.runPromise(program).catch((cause) => {
  console.error(
    cause instanceof CopyError ? `${cause.step}: HTTP ${cause.status}` : "deploy failed",
  );
  process.exitCode = 1;
});
