import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { version } from "../../src/version.js";
import { failure } from "../client.js";
import { type Config, readConfig } from "../config.js";
import { dim, green, json, output } from "./common.js";

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

// What a deploy is doing, from the lines Alchemy and the image copy print; the names are
// alchemy.run.ts's resource ids.
export const deployStage = (line: string): string | undefined => {
  const text = stripVTControlCharacters(line);
  const assets = /Uploaded (\d+) of (\d+) assets/.exec(text);
  if (assets !== null) return `Uploading the web app (${assets[1]}/${assets[2]})`;
  if (/\b(skip|verified|pushed|published) sha256:/.test(text)) return "Copying the container image";
  if (text.includes("Reconciling custom domains")) return "Attaching the address";
  if (text.includes("uploading script")) return "Uploading the Worker";
  const resource = /\[(\w+(?:\/\w+)?)\] (?:pre-creating|creating|updating|replacing|deleting)/.exec(
    text,
  );
  const named: Record<string, string> = {
    SessionArtifacts: "the bucket",
    SessionContainer: "the container app",
    "ScottyWorker/Access": "the Access app",
    ScottyWorker: "the Worker",
    HatchWildcard: "the preview address",
    HatchRoute: "the preview route",
  };
  const name = resource?.[1];
  if (name === undefined || !Object.hasOwn(named, name)) return undefined;
  const verb = /\] deleting/.test(text) ? "Removing" : "Setting up";
  return `${verb} ${named[name]}`;
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
    // The last lines say why a step failed; the others only move the spinner along.
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
              const stage = deployStage(line);
              if (stage !== undefined) report.progress?.(stage);
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

// What alchemy.run.ts reads, for deploying and destroying alike.
export const stageEnv = (config: Config) => ({
  CLOUDFLARE_ACCOUNT_ID: config.accountId,
  SCOTTY_OWNER_EMAIL: config.email,
  SCOTTY_HATCH_BASE: config.domain,
  SCOTTY_HATCH_ZONE_ID: config.zoneId,
  SCOTTY_HOST: config.host,
});

// Builds the UI, copies the pinned image and applies the stack; asks nothing.
export const deployWith = (config: Config, report: Report = plain) =>
  Effect.gen(function* () {
    yield* step("Building the UI", "npm", ["run", "--silent", "ui:build"], {}, report, "UI built");
    yield* step(
      `Deploying scotty-${config.stage} (a few minutes)`,
      "bun",
      ["deploy/run.ts", "--stage", config.stage],
      stageEnv(config),
      report,
      `Deployed scotty-${config.stage}`,
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
