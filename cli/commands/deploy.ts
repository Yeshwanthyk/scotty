import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { version } from "../../src/version.js";
import { failure } from "../client.js";
import { type Config, readConfig } from "../config.js";
import { dim, green, json, output } from "./common.js";

// Deploying runs from a Scotty checkout until the CLI carries its own release.
const root = fileURLToPath(new URL("../..", import.meta.url));

export const loadConfig = Effect.gen(function* () {
  const config = yield* readConfig;
  if (config === undefined)
    return yield* failure("setup", "Scotty is not set up on this machine", "scotty init", 3);
  return config;
});

const progress = (text: string) =>
  Effect.sync(() => {
    if (!json) console.error(dim(`· ${text}`));
  });

// Quiet unless it fails; then the last lines of its output say why.
const step = (
  text: string,
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    yield* progress(text);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd: root, env, extendEnv: true, stdin: "ignore" }),
    );
    const [printed, code] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: 2 },
    );
    if (code !== 0) {
      console.error(printed.trimEnd().split("\n").slice(-30).join("\n"));
      return yield* failure("deploy_failed", `${text} failed`, "Fix the error above, then rerun");
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.catchTag("PlatformError", () =>
      Effect.fail(failure("deploy_failed", `Could not run ${command}`, `Install ${command}`)),
    ),
  );

// Builds the UI, copies the pinned image and applies the stack; asks nothing.
export const deployWith = (config: Config) =>
  Effect.gen(function* () {
    yield* step("Building the UI", "npm", ["run", "--silent", "ui:build"]);
    yield* step(
      `Deploying stage ${config.stage} (a few minutes)`,
      "bun",
      ["deploy/run.ts", "--stage", config.stage],
      {
        CLOUDFLARE_ACCOUNT_ID: config.accountId,
        SCOTTY_OWNER_EMAIL: config.email,
        SCOTTY_HATCH_BASE: config.domain,
        SCOTTY_HATCH_ZONE_ID: config.zoneId,
        SCOTTY_HOST: config.host,
      },
    );
    return `https://${config.host}`;
  });

export const deploy = Command.make("deploy", {}, () =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    const url = yield* deployWith(config);
    yield* output(
      { stage: config.stage, url, version },
      `${green("✓")} Deployed v${version} to ${url}\n${dim("  → scotty doctor")}`,
    );
  }),
);
