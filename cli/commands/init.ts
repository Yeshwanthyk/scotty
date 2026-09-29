import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import * as ui from "@clack/prompts";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Option, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ChatGptStatus, ClaudeStatus, GitHubStatus, failure } from "../client.js";
import { Config, configPath, readConfig, removeConfig, writeConfig } from "../config.js";
import { bold, dim, green, launch, output, red, withClient } from "./common.js";
import { type Report, deployWith, loadConfig, root, stageEnv, step } from "./deploy.js";
import {
  awaitChatGpt,
  checkLines,
  checks,
  saveClaude,
  saveGitHub,
  startChatGpt,
  until,
} from "./setup.js";

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

// The wordmark, shaded teal to pink one column at a time (256-colour codes).
const wordmark = ["┌─┐┌─┐┌─┐┌┬┐┌┬┐┬ ┬", "└─┐│  │ │ │  │ └┬┘", "└─┘└─┘└─┘ ┴  ┴  ┴ "];
const shades = [44, 44, 38, 38, 39, 33, 63, 63, 99, 99, 135, 135, 171, 171, 170, 170, 169, 168];
const shade = (line: string) =>
  process.env.NO_COLOR === undefined
    ? `${[...line].map((char, i) => `\u001b[38;5;${shades[i] ?? 168}m${char}`).join("")}\u001b[0m`
    : line;

const banner = () => console.log(`\n${wordmark.map((line) => `  ${shade(line)}`).join("\n")}\n`);

const cancelled = () => failure("cancelled", "Cancelled", "Run it again when ready", 2);

const answered = <A>(value: A): value is Exclude<A, symbol> => typeof value !== "symbol";

// A clack prompt as an Effect; Esc or Ctrl-C ends the command with exit 2.
const ask = <A>(prompt: () => Promise<A>) =>
  Effect.promise(prompt).pipe(
    Effect.flatMap((answer) => {
      if (answered(answer)) return Effect.succeed(answer);
      ui.cancel("Cancelled. Nothing more was changed.");
      return Effect.fail(cancelled());
    }),
  );

// A field of the config; Enter keeps the current value, shown greyed in the box.
const field = (
  message: string,
  valid: (value: string) => boolean,
  current: string | undefined,
  problem: string,
) =>
  ask(() =>
    ui.text({
      message,
      ...(current === undefined || current === ""
        ? {}
        : { placeholder: current, defaultValue: current }),
      validate: (value) => (valid((value ?? "").trim() || (current ?? "")) ? undefined : problem),
    }),
  ).pipe(Effect.map((value) => value.trim() || (current ?? "")));

// Every question first, so the slow part runs unattended.
const questions = (previous: Config | undefined) =>
  Effect.gen(function* () {
    const f = Config.fields;
    const stage = yield* field(
      `Stage name ${dim("— resources are named scotty-<stage>")}`,
      Schema.is(f.stage),
      previous?.stage ?? "personal",
      "Lowercase letters, digits and hyphens; starts with a letter; at most 20",
    );
    const email = yield* field(
      `Your email ${dim("— the only one Cloudflare Access lets in")}`,
      Schema.is(f.email),
      previous?.email,
      "An email address",
    );
    const accountId = yield* field(
      `Cloudflare account id ${dim("— 32 characters, in the dashboard URL")}`,
      Schema.is(f.accountId),
      previous?.accountId,
      "32 lowercase hex characters",
    );
    const domain = yield* field(
      `Domain on that account ${dim("— e.g. example.com")}`,
      Schema.is(f.domain),
      previous?.domain,
      "A domain like example.com",
    );
    const zoneId = yield* field(
      `Zone id of ${domain} ${dim("— its Overview page, under API")}`,
      Schema.is(f.zoneId),
      previous !== undefined && previous.domain === domain ? previous.zoneId : undefined,
      "32 lowercase hex characters",
    );
    const host = yield* field(
      "Scotty's address",
      (value) =>
        Schema.is(f.host)(value) &&
        value.endsWith(`.${domain}`) &&
        !/^\d{1,5}-[a-z0-9-]{6,32}\./.test(value),
      previous !== undefined && previous.domain === domain ? previous.host : `scotty.${domain}`,
      `A name under ${domain} that is not <port>-<id>.${domain}`,
    );
    return { stage, email, accountId, domain, zoneId, host };
  });

type Agent = "chatgpt" | "claude";

const agentChoice = ask(() =>
  ui.select<ReadonlyArray<Agent>>({
    message: "Which agents should sessions run?",
    options: [
      { value: ["chatgpt", "claude"], label: "Codex and Claude", hint: "both sign in now" },
      { value: ["chatgpt"], label: "Codex only", hint: "signs in to ChatGPT" },
      { value: ["claude"], label: "Claude only", hint: "uses claude setup-token" },
    ],
  }),
);

const spawn = (command: string, args: readonly string[], stdio: "inherit" | "ignore") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd: root, stdin: stdio, stdout: stdio, stderr: stdio }),
    );
    return yield* child.exitCode;
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const onPath = (command: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, command)));

// A sign-in init runs for you when it is missing; it stops init if it does not finish.
const ensure = (
  name: string,
  why: string,
  done: Effect.Effect<boolean>,
  command: string,
  args: readonly string[],
) =>
  Effect.gen(function* () {
    if (yield* done) return ui.log.success(`${name} ${dim("signed in")}`);
    ui.log.step(`${bold(name)} ${dim(`— ${why}`)}`);
    const code = yield* spawn(command, args, "inherit").pipe(Effect.orElseSucceed(() => 1));
    if (code !== 0 || !(yield* done)) {
      ui.log.error(`${name} sign-in did not finish`);
      return yield* failure(
        "setup",
        `${name} did not finish`,
        `${[command, ...args].join(" ")}, then scotty init again`,
        3,
      );
    }
    ui.log.success(`${name} ${dim("signed in")}`);
  });

// What a new machine lacks, fixed or named before any question.
const preflight = Effect.gen(function* () {
  const missing = ["cloudflared", "gh"].filter((command) => !onPath(command));
  if (missing.length > 0) {
    ui.log.error(`Scotty needs ${missing.map((command) => bold(command)).join(" and ")}`);
    return yield* failure(
      "setup",
      `Scotty needs ${missing.join(" and ")}`,
      `brew install ${missing.join(" ")}, then scotty init again`,
      3,
    );
  }
  ui.log.success(`cloudflared and gh ${dim("installed")}`);
  yield* ensure(
    "GitHub CLI",
    "Scotty clones and pushes as you",
    spawn("gh", ["auth", "status"], "ignore").pipe(
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => false),
    ),
    "gh",
    ["auth", "login"],
  );
  const alchemyHome = process.env.ALCHEMY_HOME ?? join(homedir(), ".alchemy");
  yield* ensure(
    "Cloudflare deploys",
    "a browser opens; allow the account that will host Scotty",
    Effect.sync(() => existsSync(join(alchemyHome, "profiles", "default", "cloudflare.json"))),
    "npx",
    ["alchemy", "profile", "edit", "--add", "Cloudflare"],
  );
});

// Slow steps as timed spinners; a failure shows the step's last lines of output.
const spinners = (): Report => {
  let spin = ui.spinner({ indicator: "timer" });
  return {
    start: (text) => {
      spin = ui.spinner({ indicator: "timer" });
      spin.start(text);
    },
    done: (text) => spin.stop(text),
    failed: (text, printed) => {
      spin.error(`${text} failed`);
      if (printed !== "") ui.log.message(dim(printed));
    },
  };
};

// A new host needs its DNS record and certificate before Access can sign in to it.
const reachable = (url: string) =>
  Effect.gen(function* () {
    const spin = ui.spinner({ indicator: "timer" });
    spin.start(`Waiting for ${url} ${dim("— DNS and certificate")}`);
    for (let attempt = 0; attempt < 60; attempt++) {
      const ok = yield* Effect.tryPromise(() =>
        fetch(url, { redirect: "manual" }).then((response) => response.status < 500),
      ).pipe(Effect.orElseSucceed(() => false));
      if (ok) return spin.stop(`${url} is up`);
      yield* Effect.sleep("5 seconds");
    }
    spin.error(`${url} did not answer`);
    return yield* failure(
      "setup",
      `${url} did not answer after 5 minutes`,
      "Check the domain's DNS in Cloudflare, then scotty init again",
      3,
    );
  });

// cloudflared prints the Access token when it succeeds, so only a line that is just a link is shown.
const accessLogin = (url: string, email: string) =>
  Effect.gen(function* () {
    ui.log.step(`${bold("Cloudflare Access")} ${dim(`— a browser opens; sign in with ${email}`)}`);
    const spin = ui.spinner();
    spin.start("Waiting for you to sign in");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("cloudflared", ["access", "login", url], { cwd: root, stdin: "ignore" }),
    );
    yield* child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          if (/^https:\/\/\S+$/.test(line.trim()))
            spin.message(`Waiting for you to sign in ${dim(`— or open ${line.trim()}`)}`);
        }),
      ),
    );
    if ((yield* child.exitCode) !== 0) {
      spin.error("Access sign-in did not finish");
      return yield* failure(
        "access_login",
        "Access sign-in did not finish",
        `cloudflared access login ${url}, then scotty init again`,
        3,
      );
    }
    spin.stop("Signed in to Cloudflare Access");
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        failure(
          "access_login",
          "cloudflared did not run",
          "Install cloudflared, then scotty init again",
          3,
        ),
      ),
    ),
  );

// GitHub is required; each chosen agent signs in unless it already is, and a failed one is left
// for doctor to report.
const signIns = (agents: ReadonlyArray<Agent>) =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const github = yield* Effect.exit(api("/api/credentials/github", GitHubStatus));
    if (Exit.isSuccess(github) && github.value.status === "set")
      ui.log.success(`GitHub ${dim("token saved")}`);
    else {
      const saved = yield* saveGitHub(api);
      ui.log.success(`GitHub ${dim(`token saved for ${saved.login ?? "you"}`)}`);
    }
    const later = (name: string, command: string) => () =>
      Effect.sync(() => ui.log.warn(`${name} skipped ${dim(`— ${command} finishes it`)}`));
    if (agents.includes("chatgpt")) {
      const chatgpt = yield* Effect.exit(api("/api/credentials/chatgpt", ChatGptStatus));
      if (Exit.isSuccess(chatgpt) && chatgpt.value.status === "signed-in")
        ui.log.success(`ChatGPT ${dim(`signed in${until(chatgpt.value.expiresAt)}`)}`);
      else
        yield* Effect.gen(function* () {
          const start = yield* startChatGpt(api);
          ui.note(
            `Open  ${start.verificationUrl}\nEnter ${bold(start.userCode)}`,
            "ChatGPT sign-in for Codex",
          );
          yield* Effect.ignore(launch(start.verificationUrl));
          const spin = ui.spinner();
          spin.start("Waiting for the code");
          const result = yield* awaitChatGpt(api, start).pipe(
            Effect.onError(() => Effect.sync(() => spin.error("ChatGPT sign-in did not finish"))),
          );
          spin.stop(`ChatGPT ${dim(`signed in${until(result.expiresAt)}`)}`);
        }).pipe(Effect.catch(later("ChatGPT", "scotty login chatgpt")));
    }
    if (agents.includes("claude")) {
      const claude = yield* Effect.exit(api("/api/credentials/claude", ClaudeStatus));
      if (Exit.isSuccess(claude) && claude.value.status === "signed-in")
        ui.log.success(`Claude ${dim(`token saved${until(claude.value.expiresAt)}`)}`);
      else
        yield* Effect.gen(function* () {
          ui.log.step(`${bold("Claude")} ${dim("— claude setup-token opens a browser")}`);
          const saved = yield* saveClaude(api, (line) => ui.log.message(line));
          ui.log.success(`Claude ${dim(`token saved${until(saved.expiresAt)}`)}`);
        }).pipe(Effect.catch(later("Claude", "scotty login claude")));
    }
  });

export const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    yield* terminalOnly("init");
    banner();
    ui.intro(` ${bold("Beam me up")} `);
    ui.note(
      [
        "A Cloudflare account on Workers Paid, with Zero Trust on",
        "A domain on that account; Scotty runs at a name under it",
        "A ChatGPT or Claude plan, and a GitHub account",
      ].join("\n"),
      "You need",
    );
    yield* preflight;
    const previous = yield* readConfig.pipe(Effect.orElseSucceed(() => undefined));
    const config = yield* questions(previous);
    if (
      previous !== undefined &&
      (previous.stage !== config.stage || previous.accountId !== config.accountId)
    ) {
      ui.cancel(`Stage ${previous.stage} is still set up.`);
      return yield* failure(
        "usage",
        `Stage ${previous.stage} is still set up; a new stage or account would leave it running`,
        "scotty teardown, then scotty init",
        2,
      );
    }
    const agents = yield* agentChoice;
    ui.note(
      [
        `${dim("Address ")} https://${config.host}`,
        `${dim("Previews")} <port>-<id>.${config.domain}`,
        `${dim("Sign-in ")} ${config.email}`,
        `${dim("Creates ")} scotty-${config.stage} and its container app and bucket`,
        `${dim("Agents  ")} ${agents.map((agent) => (agent === "chatgpt" ? "Codex" : "Claude")).join(" and ")}`,
      ].join("\n"),
      "Ready to deploy",
    );
    if (!(yield* ask(() => ui.confirm({ message: "Deploy now?" })))) {
      ui.cancel("Nothing was deployed.");
      return yield* cancelled();
    }
    yield* writeConfig(config);
    const url = yield* deployWith(config, spinners());
    yield* reachable(url);
    yield* accessLogin(url, config.email);
    yield* signIns(agents);
    const result = yield* checks;
    ui.note(checkLines(result).join("\n"), "Doctor");
    if (result.some((check) => check.status === "fail")) {
      process.exitCode = 3;
      return ui.outro(`Fix the ${red("✗")} items, then ${bold("scotty doctor")}`);
    }
    ui.outro(
      [
        `${green("Scotty is up")} at ${bold(url)}`,
        "",
        `   ${dim("Open it on your phone, or start a session here:")}`,
        `   scotty new owner/repo "What to do"`,
      ].join("\n"),
    );
  }),
);

export const teardown = Command.make(
  "teardown",
  { stage: Flag.String("stage").pipe(Flag.optional) },
  ({ stage }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const removes = [
        `Worker scotty-${config.stage} at https://${config.host}, with every session and sign-in`,
        `Container app scotty-${config.stage}-sessions`,
        `Bucket scotty-${config.stage}-artifacts, with its files and saves`,
        `Its Access application, and the preview route and DNS for *.${config.domain}`,
        configPath,
      ];
      const typed = Option.isSome(stage)
        ? stage.value
        : yield* Effect.gen(function* () {
            yield* terminalOnly("teardown");
            ui.intro(` ${bold(`Remove stage ${config.stage}`)} `);
            ui.note(removes.join("\n"), `From Cloudflare account ${config.accountId}`);
            return yield* ask(() =>
              ui.text({ message: `Type ${bold(config.stage)} to remove it` }),
            );
          });
      if (Option.isSome(stage))
        console.error(
          [
            `${bold(`Remove stage ${config.stage}`)} from Cloudflare account ${config.accountId}:`,
            ...removes.map((line) => `  ${line}`),
            "",
          ].join("\n"),
        );
      if (typed.trim() !== config.stage) {
        if (Option.isNone(stage)) ui.cancel("Nothing was removed.");
        return yield* failure(
          "usage",
          `That is not the stage name (${config.stage}); nothing was removed`,
          "scotty teardown",
          2,
        );
      }
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
        Option.isNone(stage) ? spinners() : undefined,
        `Removed stage ${config.stage}`,
      );
      yield* removeConfig;
      if (Option.isNone(stage)) return ui.outro(dim("scotty init sets it up again"));
      yield* output(
        { stage: config.stage, removed: true },
        `${green("✓")} Removed stage ${config.stage}\n${dim("  → scotty init to set it up again")}`,
      );
    }),
);
