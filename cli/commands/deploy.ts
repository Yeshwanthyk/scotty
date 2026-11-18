import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import * as ui from "@clack/prompts";
import { Effect, Exit, FileSystem, Option, Predicate, Redacted, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { CloudflareLayer } from "../../deploy/cloudflare.ts";
import { version } from "../../src/version.js";
import { failure } from "../client.js";
import { type Config, readConfig } from "../config.js";
import { embedded, packedFile, unpackRelease } from "../release.ts";
import { dim, green, json, launch, output } from "./common.js";

export const root = fileURLToPath(new URL("../..", import.meta.url));

export const loadConfig = Effect.gen(function* () {
  const config = yield* readConfig;
  if (config === undefined)
    return yield* failure("setup", "Scotty is not set up on this machine", "scotty init", 3);
  return config;
});

export const progress = (text: string) =>
  Effect.sync(() => {
    if (!json) console.error(dim(`· ${text}`));
  });

export interface Report {
  readonly start: (text: string) => void;
  readonly done: (text: string) => void;
  readonly failed: (text: string, output: string) => void;
  readonly progress?: (text: string) => void;
}

const plain: Report = {
  start: (text) => {
    if (!json) console.error(dim(`· ${text}`));
  },
  done: () => {},
  failed: (_, printed) => console.error(printed),
};

export const step = (
  text: string,
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
  report: Report = plain,
  done = text,
) =>
  Effect.gen(function* () {
    report.start(text);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd: root, env, extendEnv: true, stdin: "ignore" }),
    );
    const stop = () => {
      try {
        process.kill(-Number(child.pid), "SIGINT");
      } catch {}
    };
    process.once("exit", stop);
    yield* Effect.addFinalizer(() => Effect.sync(() => process.off("exit", stop)));
    const last: string[] = [];
    const [, code] = yield* Effect.all(
      [
        child.all.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              last.push(line);
              if (last.length > 30) last.shift();
            }),
          ),
        ),
        child.exitCode,
      ],
      { concurrency: 2 },
    );
    if (code !== 0) {
      report.failed(text, last.join("\n").trimEnd());
      return yield* failure("deploy_failed", `${text} failed`, "Fix the error above, then rerun");
    }
    report.done(done);
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.catchTag("PlatformError", () => {
      report.failed(text, "");
      return Effect.fail(
        failure("deploy_failed", `Could not run ${command}`, `Install ${command}`),
      );
    }),
  );

export const load = <A>(name: string, module: () => Promise<A>) =>
  Effect.tryPromise({
    try: module,
    catch: () => failure("setup", `Could not load the ${name} module`, "Reinstall scotty", 3),
  });
const deployer = load("deployer", () => import("../../deploy/deployer.ts"));
const cloudflare = load("Cloudflare", () => import("../../deploy/cloudflare.ts"));

const Messages = Schema.Array(Schema.Struct({ message: Schema.String }));
const nonEmpty = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

const described = (error: unknown) => {
  if (typeof error === "string") return error;
  const tag =
    (Predicate.hasProperty(error, "_tag") ? nonEmpty(error._tag) : undefined) ??
    (error instanceof Error ? error.name : "Error");
  const message =
    (Predicate.hasProperty(error, "message") ? nonEmpty(error.message) : undefined) ??
    (Predicate.hasProperty(error, "errors") && Schema.is(Messages)(error.errors)
      ? nonEmpty(error.errors.map((item) => item.message).join("; "))
      : undefined);
  return message === undefined ? tag : `${tag}: ${message}`;
};

export const cloudflareStep = <A, E, R>(
  text: string,
  done: string,
  work: (progress: (text: string) => void) => Effect.Effect<A, E, R>,
  report: Report = plain,
) =>
  Effect.gen(function* () {
    report.start(text);
    const result = yield* work((line) => report.progress?.(line)).pipe(
      Effect.tapError((error) => Effect.sync(() => report.failed(text, described(error)))),
      Effect.mapError(() =>
        failure("deploy_failed", `${text} failed`, "Fix the error above, then rerun"),
      ),
    );
    report.done(done);
    return result;
  });

export const cloudflareToken = Effect.gen(function* () {
  const { accounts, cloudflareLayer, tokenPage } = yield* cloudflare;
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN;
  if (fromEnv === undefined && !(process.stdin.isTTY && process.stdout.isTTY))
    return yield* failure(
      "setup",
      "Deploying needs a Cloudflare API token",
      "Set CLOUDFLARE_API_TOKEN, or run it in a terminal to paste one",
      3,
    );
  const token = Redacted.make(
    fromEnv ??
      (yield* Effect.gen(function* () {
        const page = tokenPage();
        ui.note(
          `Create a token with the permissions filled in, then paste it here.\n${dim(page)}`,
          "Cloudflare API token",
        );
        yield* Effect.ignore(launch(page));
        const pasted = yield* Effect.tryPromise({
          try: () => ui.password({ message: "Cloudflare API token", mask: "•" }),
          catch: () =>
            failure("prompt", "Could not read the token", "Set CLOUDFLARE_API_TOKEN instead", 2),
        });
        if (typeof pasted === "symbol") {
          ui.cancel("Cancelled. Nothing was changed.");
          return yield* failure("cancelled", "Cancelled", "Run it again when ready", 2);
        }
        return pasted.trim();
      })),
  );
  const found = yield* Effect.exit(accounts.pipe(Effect.provide(cloudflareLayer(token))));
  if (Exit.isFailure(found) || found.value.length === 0)
    return yield* failure(
      "setup",
      "Cloudflare did not accept that API token",
      fromEnv === undefined
        ? "Create a token on the page, then paste it"
        : "Check CLOUDFLARE_API_TOKEN",
      3,
    );
  return cloudflareLayer(token);
});

export const deployWith = (
  config: Config,
  layer: CloudflareLayer,
  report: Report = plain,
  image?: string,
) =>
  Effect.gen(function* () {
    const { deployStage } = yield* deployer;
    const dir = embedded()
      ? yield* unpackRelease.pipe(
          Effect.mapError(() =>
            failure("deploy_failed", "Could not unpack the release", "Reinstall scotty"),
          ),
        )
      : yield* Effect.gen(function* () {
          yield* step(
            "Building the UI",
            "npm",
            ["run", "--silent", "ui:build"],
            {},
            report,
            "UI built",
          );
          const build = `import { buildRelease } from "./deploy/release.ts"; await buildRelease("dist/release");`;
          yield* step(
            "Building the release",
            "bun",
            ["--eval", build],
            {},
            report,
            "Release built",
          );
          return join(root, "dist", "release");
        });
    yield* cloudflareStep(
      `Deploying scotty-${config.stage} (a few minutes)`,
      `Deployed scotty-${config.stage}`,
      (progress) => deployStage(config, dir, progress, image).pipe(Effect.provide(layer)),
      report,
    );
    return `https://${config.host}`;
  }).pipe(Effect.scoped);

export const removeWith = (config: Config, layer: CloudflareLayer, report: Report = plain) =>
  Effect.gen(function* () {
    const { removeStage } = yield* deployer;
    yield* cloudflareStep(
      `Removing stage ${config.stage} (a minute or two)`,
      `Removed stage ${config.stage}`,
      (progress) => removeStage(config, progress).pipe(Effect.provide(layer)),
      report,
    );
  });

export const leftoversWith = (config: Config, layer: CloudflareLayer) =>
  Effect.gen(function* () {
    const { leftovers } = yield* deployer;
    return yield* leftovers(config).pipe(Effect.provide(layer));
  });

export const deploy = Command.make(
  "deploy",
  { image: Flag.String("image").pipe(Flag.optional) },
  ({ image }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const url = yield* deployWith(
        config,
        yield* cloudflareToken,
        plain,
        Option.getOrUndefined(image),
      );
      yield* output(
        { stage: config.stage, url, version },
        `${green("✓")} Deployed v${version} to ${url}\n${dim("  → scotty doctor")}`,
      );
    }),
);

export const skill = Command.make("skill", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text =
      (yield* packedFile("SKILL.md")) ??
      (yield* fs.readFileString(join(root, "skills", "scotty", "SKILL.md")));
    yield* output({ skill: text }, text.trimEnd());
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError(() => failure("setup", "The Scotty skill is missing", "Reinstall scotty", 3)),
  ),
);
