import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Option, Schema } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ChatGptStatus, ClaudeStatus, GitHubStatus, failure } from "../client.js";
import { Config, configPath, readConfig, removeConfig, writeConfig } from "../config.js";
import { bold, dim, green, output, withClient } from "./common.js";
import { deployWith, loadConfig, progress, root, stageEnv, step } from "./deploy.js";
import { loginTo, runDoctor } from "./setup.js";

const terminalOnly = (command: string) =>
  Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      return yield* failure(
        "usage",
        `scotty ${command} asks questions, so it runs in a terminal`,
        command === "init"
          ? `Write ${configPath} yourself, then scotty deploy`
          : "scotty teardown --stage <stage>",
        2,
      );
  });

const prompt = <A>(self: Prompt.Prompt<A>) =>
  Prompt.run(self).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError(() => failure("cancelled", "Cancelled", "Run it again when ready", 2)),
  );

// A field of the config, asked with the current value as the default.
const ask = (
  message: string,
  valid: (value: string) => boolean,
  current: string | undefined,
  problem: string,
) =>
  // The prompt's own default is editable text that typing appends to, so Enter picks it instead.
  prompt(
    Prompt.String({
      message: current === undefined || current === "" ? message : `${message} [${current}]`,
      validate: (value) => {
        const answer = value.trim() === "" ? (current ?? "") : value.trim();
        return valid(answer) ? Effect.succeed(answer) : Effect.fail(problem);
      },
    }),
  );

// Every question first, so the slow part runs unattended.
const questions = (previous: Config | undefined) =>
  Effect.gen(function* () {
    const f = Config.fields;
    const stage = yield* ask(
      "Stage name (resources are named scotty-<stage>)",
      Schema.is(f.stage),
      previous?.stage ?? "personal",
      "Lowercase letters, digits and hyphens; starts with a letter; at most 20",
    );
    const email = yield* ask(
      "Your email (the only one Cloudflare Access lets in)",
      Schema.is(f.email),
      previous?.email,
      "An email address",
    );
    const accountId = yield* ask(
      "Cloudflare account id (32 characters, in the dashboard URL)",
      Schema.is(f.accountId),
      previous?.accountId,
      "32 lowercase hex characters",
    );
    const domain = yield* ask(
      "Domain on that account (e.g. example.com)",
      Schema.is(f.domain),
      previous?.domain,
      "A domain like example.com",
    );
    const zoneId = yield* ask(
      `Zone id of ${domain} (its Overview page, under API)`,
      Schema.is(f.zoneId),
      previous?.domain === domain ? previous.zoneId : undefined,
      "32 lowercase hex characters",
    );
    const host = yield* ask(
      "Scotty's address",
      (value) =>
        Schema.is(f.host)(value) &&
        value.endsWith(`.${domain}`) &&
        !/^\d{1,5}-[a-z0-9-]{6,32}\./.test(value),
      previous?.domain === domain ? previous.host : `scotty.${domain}`,
      `A name under ${domain} that is not <port>-<id>.${domain}`,
    );
    return { stage, email, accountId, domain, zoneId, host };
  });

const spawnInherit = (command: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
    );
    return yield* child.exitCode;
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

// A new host needs its DNS record and certificate before Access can sign in to it.
const reachable = (url: string) =>
  Effect.gen(function* () {
    yield* progress(`Waiting for ${url}`);
    for (let attempt = 0; attempt < 60; attempt++) {
      const ok = yield* Effect.tryPromise(() =>
        fetch(url, { redirect: "manual" }).then((response) => response.status < 500),
      ).pipe(Effect.orElseSucceed(() => false));
      if (ok) return;
      yield* Effect.sleep("5 seconds");
    }
    return yield* failure(
      "setup",
      `${url} did not answer after 5 minutes`,
      "Check the domain's DNS in Cloudflare, then scotty init again",
      3,
    );
  });

type Agent = "chatgpt" | "claude";

const agentChoice = prompt(
  Prompt.Select<ReadonlyArray<Agent>>({
    message: "Which agents should sessions run?",
    choices: [
      { title: "Codex and Claude", value: ["chatgpt", "claude"] },
      { title: "Codex only", value: ["chatgpt"], description: "Signs in to ChatGPT" },
      { title: "Claude only", value: ["claude"], description: "Uses claude setup-token" },
    ],
  }),
);

// GitHub is required; each chosen agent signs in unless it already is, and a failed one is left
// for doctor to report.
const signIns = (agents: ReadonlyArray<Agent>) =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const github = yield* Effect.exit(api("/api/credentials/github", GitHubStatus));
    if (Exit.isFailure(github) || github.value.status !== "set") {
      console.error(`\n${bold("GitHub")} (cloning and pushing, from gh auth token)`);
      yield* loginTo("github");
    }
    const later = <E>(effect: Effect.Effect<void, E>) =>
      Effect.exit(effect).pipe(
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit) ? Effect.void : progress("Skipped; doctor shows how to finish it"),
        ),
      );
    if (agents.includes("chatgpt")) {
      const chatgpt = yield* Effect.exit(api("/api/credentials/chatgpt", ChatGptStatus));
      if (Exit.isFailure(chatgpt) || chatgpt.value.status !== "signed-in") {
        console.error(`\n${bold("ChatGPT")} (Codex sessions)`);
        yield* later(loginTo("chatgpt"));
      }
    }
    if (agents.includes("claude")) {
      const claude = yield* Effect.exit(api("/api/credentials/claude", ClaudeStatus));
      if (Exit.isFailure(claude) || claude.value.status !== "signed-in") {
        console.error(`\n${bold("Claude")} (Claude sessions)`);
        yield* later(loginTo("claude"));
      }
    }
  });

export const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    yield* terminalOnly("init");
    console.error(
      [
        `${bold("Set up Scotty")}`,
        "You need a Cloudflare account on Workers Paid with Zero Trust, and a domain on it.",
        "Scotty runs at a name under that domain; previews at <port>-<id>.<domain>.",
        dim("Deploys use Alchemy's Cloudflare sign-in (profile default)."),
        "",
      ].join("\n"),
    );
    const previous = yield* readConfig.pipe(Effect.orElseSucceed(() => undefined));
    const config = yield* questions(previous);
    if (
      previous !== undefined &&
      (previous.stage !== config.stage || previous.accountId !== config.accountId)
    )
      return yield* failure(
        "usage",
        `Stage ${previous.stage} is still set up; a new stage or account would leave it running`,
        "scotty teardown, then scotty init",
        2,
      );
    const agents = yield* agentChoice;
    yield* writeConfig(config);
    console.error(`${green("✓")} Saved ${configPath}`);
    const url = yield* deployWith(config);
    console.error(`${green("✓")} Deployed to ${url}`);
    yield* reachable(url);
    console.error(`\n${bold("Cloudflare Access")} (a browser opens; sign in with ${config.email})`);
    const code = yield* spawnInherit("cloudflared", ["access", "login", url]).pipe(
      Effect.mapError(() =>
        failure(
          "access_login",
          "cloudflared did not run",
          "Install cloudflared, then scotty init again",
          3,
        ),
      ),
    );
    if (code !== 0)
      return yield* failure(
        "access_login",
        "Access sign-in did not finish",
        `cloudflared access login ${url}, then scotty init again`,
        3,
      );
    yield* signIns(agents);
    console.error("");
    yield* runDoctor;
  }),
);

export const teardown = Command.make(
  "teardown",
  { stage: Flag.String("stage").pipe(Flag.optional) },
  ({ stage }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      console.error(
        [
          `${bold(`Remove stage ${config.stage}`)} from Cloudflare account ${config.accountId}:`,
          `  Worker scotty-${config.stage} at https://${config.host}, with every session and sign-in`,
          `  Container app scotty-${config.stage}-sessions`,
          `  Bucket scotty-${config.stage}-artifacts, with its files and saves`,
          `  Its Access application, and the preview route and DNS for *.${config.domain}`,
          `  ${configPath}`,
          "",
        ].join("\n"),
      );
      if (Option.isNone(stage)) yield* terminalOnly("teardown");
      const typed = Option.isSome(stage)
        ? stage.value
        : yield* prompt(Prompt.String({ message: "Type the stage name to remove it" }));
      if (typed.trim() !== config.stage)
        return yield* failure(
          "usage",
          `That is not the stage name (${config.stage}); nothing was removed`,
          "scotty teardown",
          2,
        );
      // Alchemy keeps a stage's state in the checkout that deployed it; without it destroy removes nothing.
      const state = join(root, ".alchemy", "state", "scotty", config.stage);
      if (!existsSync(state) || readdirSync(state).length === 0)
        return yield* failure(
          "setup",
          `This checkout has no deploy state for stage ${config.stage}; nothing was removed`,
          `Run scotty teardown from the checkout that deployed it (${state} is missing)`,
          3,
        );
      yield* step(
        `Removing stage ${config.stage} (a minute or two)`,
        "bun",
        ["deploy/run.ts", "--destroy", "--stage", config.stage],
        stageEnv(config),
      );
      yield* removeConfig;
      yield* output(
        { stage: config.stage, removed: true },
        `${green("✓")} Removed stage ${config.stage}\n${dim("  → scotty init to set it up again")}`,
      );
    }),
);
