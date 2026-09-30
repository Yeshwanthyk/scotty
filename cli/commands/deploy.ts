import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import * as ui from "@clack/prompts";
import { Effect, Exit, FileSystem, Redacted, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { CloudflareLayer } from "../../deploy/cloudflare.ts";
import { version } from "../../src/version.js";
import { failure } from "../client.js";
import { type Config, readConfig } from "../config.js";
import { dim, green, json, launch, output } from "./common.js";

// Deploying runs from a Scotty checkout until the CLI carries its own release.
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

// How a slow step shows itself; init draws spinners, other commands print a line.
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

// Quiet unless it fails; then the last lines of its output say why.
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
    // The child runs in its own process group, which a terminal's Ctrl-C does not reach, and an
    // exit skips this scope's cleanup; so an exit stops it here.
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGINT");
      } catch {
        // It has already exited.
      }
    };
    process.once("exit", stop);
    yield* Effect.addFinalizer(() => Effect.sync(() => process.off("exit", stop)));
    // The last lines say why a step failed.
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

const deployer = Effect.promise(() => import("../../deploy/deployer.ts"));
const cloudflare = Effect.promise(() => import("../../deploy/cloudflare.ts"));

// A Cloudflare step behind the report; a failure shows what Cloudflare said.
export const cloudflareStep = <A, E, R>(
  text: string,
  done: string,
  work: (progress: (text: string) => void) => Effect.Effect<A, E, R>,
  report: Report = plain,
) =>
  Effect.gen(function* () {
    report.start(text);
    const result = yield* work((line) => report.progress?.(line)).pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          report.failed(
            text,
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          ),
        ),
      ),
      Effect.mapError(() =>
        failure("deploy_failed", `${text} failed`, "Fix the error above, then rerun"),
      ),
    );
    report.done(done);
    return result;
  });

// The owner's Cloudflare API token for this run only: CLOUDFLARE_API_TOKEN, or pasted after the
// page that creates one opens. It is checked by listing the accounts it can see, and never saved.
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
        const pasted = yield* Effect.promise(() =>
          ui.password({ message: "Cloudflare API token", mask: "•" }),
        );
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

// Builds a release from this checkout and deploys it to the stage; asks nothing.
export const deployWith = (config: Config, layer: CloudflareLayer, report: Report = plain) =>
  Effect.gen(function* () {
    const { deployStage } = yield* deployer;
    const { buildRelease } = yield* Effect.promise(() => import("../../deploy/release.ts"));
    const dir = join(root, "dist", "release");
    yield* step("Building the UI", "npm", ["run", "--silent", "ui:build"], {}, report, "UI built");
    yield* cloudflareStep(
      "Building the release",
      "Release built",
      () => Effect.tryPromise(() => buildRelease(dir)),
      report,
    );
    yield* cloudflareStep(
      `Deploying scotty-${config.stage} (a few minutes)`,
      `Deployed scotty-${config.stage}`,
      (progress) => deployStage(config, dir, progress).pipe(Effect.provide(layer)),
      report,
    );
    return `https://${config.host}`;
  });

// Removes the stage by name; the caller checks what is left.
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

// What of the stage Cloudflare still has.
export const leftoversWith = (config: Config, layer: CloudflareLayer) =>
  Effect.gen(function* () {
    const { leftovers } = yield* deployer;
    return yield* leftovers(config).pipe(Effect.provide(layer));
  });

export const deploy = Command.make("deploy", {}, () =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    const url = yield* deployWith(config, yield* cloudflareToken);
    yield* output(
      { stage: config.stage, url, version },
      `${green("✓")} Deployed v${version} to ${url}\n${dim("  → scotty doctor")}`,
    );
  }),
);

// The guide a person hands their own agent; it lives in the checkout beside this CLI.
export const skill = Command.make("skill", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(join(root, "skills", "scotty", "SKILL.md"));
    yield* output({ skill: text }, text.trimEnd());
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError(() =>
      failure("setup", "skills/scotty/SKILL.md is missing from this checkout", "git pull", 3),
    ),
  ),
);
