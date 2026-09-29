import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CopyError, decode } from "./oci.ts";

const Stage = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,19}$/)));
const error = (step: string) => new CopyError({ step, status: 0 });
const args = process.argv.slice(2);
const stages: string[] = [];
// Destroy removes what Alchemy's state records for the stage; nothing is copied.
const destroy = args.includes("--destroy");
const forwarded: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--stage") {
    stages.push(args[++i] ?? "");
  } else if (arg?.startsWith("--stage=")) {
    stages.push(arg.slice("--stage=".length));
  } else if (arg !== "--destroy") {
    forwarded.push(arg ?? "");
  }
}
// The pinned supervisor image; its registry.cloudflare.com copy is `scotty@<same digest>`.
const input = {
  source: readFileSync(new URL("../container/image.digest", import.meta.url), "utf8").trim(),
  account: process.env.CLOUDFLARE_ACCOUNT_ID,
  repository: "scotty",
};

const program = Effect.gen(function* () {
  const stage = stages[0];
  if (stages.length !== 1 || !stage || stage.startsWith("-"))
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
  // alchemy.run.ts checks the image ref even when destroying.
  const image = destroy
    ? `registry.cloudflare.com/${valid.account}/${valid.repository}@${valid.source.split("@")[1] ?? ""}`
    : yield* copyImage(valid).pipe(Effect.provide(copyLayer));
  const exit = yield* Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          "./node_modules/.bin/alchemy",
          [
            destroy ? "destroy" : "deploy",
            "--profile",
            "default",
            "--yes",
            "--no-input",
            ...forwarded,
            "--stage",
            validStage,
          ],
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
  if (exit !== 0) return yield* error(destroy ? "alchemy destroy" : "alchemy deploy");
});
Effect.runPromise(program).catch((cause: unknown) => {
  console.error(
    cause instanceof CopyError ? `${cause.step}: HTTP ${cause.status}` : "deploy failed",
  );
  process.exitCode = 1;
});
