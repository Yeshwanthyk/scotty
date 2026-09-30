import { lookup } from "node:dns/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { connect } from "node:tls";
import * as ui from "@clack/prompts";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Option, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { renderUnicodeCompact } from "uqr";
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

// The wordmark in half-block letters, shaded teal to pink across a dim field of stars.
const letters = ["█▀▀ █▀▀ █▀█ ▀█▀ ▀█▀ █ █", "▄▄█ █▄▄ █▄█  █   █   █ "];
const sky = ["   ·     ✦          ·       ✧      ·", "      ✧        ·        ✦     ·  "];
const shades = [44, 38, 39, 33, 63, 99, 135, 171, 170, 169, 168];
const color = process.env.NO_COLOR === undefined;
const paint = (code: number, text: string) =>
  color ? `\u001b[38;5;${code}m${text}\u001b[0m` : text;
const shade = (line: string) =>
  [...line]
    .map((char, i) =>
      char === " "
        ? char
        : paint(shades[Math.floor((i * shades.length) / line.length)] ?? 168, char),
    )
    .join("");
const stars = (line: string) => paint(240, line);

const banner = () =>
  console.log(
    [
      "",
      stars(sky[0] ?? ""),
      ...letters.map((line, i) => `      ${shade(line)}${stars(i === 0 ? "     ·" : "   ✧")}`),
      stars(sky[1] ?? ""),
      "",
    ].join("\n"),
  );

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

// A list from Cloudflare behind a spinner; undefined when it could not be read, so init asks instead.
const listed = <A, E, R>(text: string, list: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.gen(function* () {
    const spin = ui.spinner();
    spin.start(text);
    const found = yield* Effect.exit(list);
    if (Exit.isSuccess(found)) {
      spin.clear();
      return found.value;
    }
    spin.error(`${text} failed ${dim("— type it instead")}`);
    return undefined;
  });

const cloudflare = Effect.promise(() => import("../../deploy/cloudflare.ts"));

// The account the Cloudflare sign-in can see; one is taken without asking.
const accountChoice = (current: string | undefined) =>
  Effect.gen(function* () {
    const { accounts } = yield* cloudflare;
    const found = yield* listed("Reading your Cloudflare accounts", accounts);
    const only = found?.length === 1 ? found[0] : undefined;
    if (only !== undefined) {
      ui.log.success(`Cloudflare account ${bold(only.name)}`);
      return only.id;
    }
    if (found === undefined || found.length === 0)
      return yield* field(
        `Cloudflare account id ${dim("— 32 characters, in the dashboard URL")}`,
        Schema.is(Config.fields.accountId),
        current,
        "32 lowercase hex characters",
      );
    return yield* ask(() =>
      ui.select({
        message: "Which Cloudflare account?",
        options: found.map((account) => ({ value: account.id, label: account.name })),
        ...(current === undefined ? {} : { initialValue: current }),
      }),
    );
  });

// The domain Scotty runs under, from the account's zones.
const domainChoice = (accountId: string, current: Config | undefined) =>
  Effect.gen(function* () {
    const { zones } = yield* cloudflare;
    const found = yield* listed("Reading the domains on that account", zones(accountId));
    if (found !== undefined && found.length === 0) {
      ui.cancel("That account has no domains.");
      return yield* failure(
        "setup",
        "The Cloudflare account has no domains",
        "Add a domain to it in the Cloudflare dashboard, then scotty init again",
        3,
      );
    }
    if (found === undefined) {
      const domain = yield* field(
        `Domain on that account ${dim("— e.g. example.com")}`,
        Schema.is(Config.fields.domain),
        current?.domain,
        "A domain like example.com",
      );
      const zoneId = yield* field(
        `Zone id of ${domain} ${dim("— its Overview page, under API")}`,
        Schema.is(Config.fields.zoneId),
        current !== undefined && current.domain === domain ? current.zoneId : undefined,
        "32 lowercase hex characters",
      );
      return { domain, zoneId };
    }
    const zone = yield* ask(() =>
      ui.select({
        message: `Which domain? ${dim("— Scotty runs at a name under it")}`,
        options: found.map((zone) => ({
          value: zone,
          label: zone.name,
          ...(zone.status === "active" || zone.status == null ? {} : { hint: zone.status }),
        })),
        ...(current === undefined
          ? {}
          : { initialValue: found.find((zone) => zone.id === current.zoneId) }),
      }),
    );
    return { domain: zone.name, zoneId: zone.id };
  });

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
    const accountId = yield* accountChoice(previous?.accountId);
    const { domain, zoneId } = yield* domainChoice(
      accountId,
      previous?.accountId === accountId ? previous : undefined,
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

// A re-run offers the saved answers whole; Enter keeps them.
const settings = (previous: Config | undefined) =>
  Effect.gen(function* () {
    if (previous === undefined) return yield* questions(previous);
    ui.note(
      [
        `${dim("Stage   ")} ${previous.stage}`,
        `${dim("Sign-in ")} ${previous.email}`,
        `${dim("Address ")} https://${previous.host}`,
        `${dim("Previews")} <port>-<id>.${previous.domain}`,
      ].join("\n"),
      "Saved settings",
    );
    if (yield* ask(() => ui.confirm({ message: "Use these settings?" }))) return previous;
    return yield* questions(previous);
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

// clack's spinner reads keys in raw mode and exits 0 on Ctrl-C without calling onCancel, so Ctrl-C
// is turned into its abort signal, which does.
const CtrlC = Schema.Struct({ ctrl: Schema.Literal(true), name: Schema.Literal("c") });
const stoppable = (cancelMessage: string, onCancel: () => void) => {
  const abort = new AbortController();
  const key = (_: unknown, pressed: unknown) => {
    if (Schema.is(CtrlC)(pressed)) abort.abort();
  };
  process.stdin.on("keypress", key);
  const spin = ui.spinner({ indicator: "timer", cancelMessage, onCancel, signal: abort.signal });
  return { spin, release: () => process.stdin.off("keypress", key) };
};

// Slow steps as timed spinners; a failure shows the step's last lines of output. Ctrl-C says what
// was left behind and how to go on.
const spinners = (stopped: string): Report => {
  let running: ReturnType<typeof stoppable> | undefined;
  let current = "";
  const end = () => {
    running?.release();
    return running?.spin;
  };
  return {
    start: (text) => {
      current = text;
      running = stoppable(`${text} stopped`, () => {
        ui.cancel(stopped);
        process.exit(130);
      });
      running.spin.start(text);
    },
    done: (text) => end()?.stop(text),
    failed: (text, printed) => {
      end()?.error(`${text} failed`);
      if (printed !== "") ui.log.message(dim(printed));
    },
    progress: (text) => running?.spin.message(`${current} ${dim(`· ${text}`)}`),
  };
};

const DnsReply = Schema.Struct({
  Answer: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.Number, data: Schema.String })),
  ),
});

// Cloudflare's resolver over HTTPS, asked afresh each time. A resolver in this process would
// remember "no such name" from before the deploy for up to half an hour.
const records = (name: string, type: "A" | "AAAA") =>
  Effect.tryPromise(() =>
    fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    }).then((response) => response.json()),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DnsReply)),
    Effect.map((reply) =>
      (reply.Answer ?? [])
        .filter((answer) => answer.type === (type === "A" ? 1 : 28))
        .map((answer) => answer.data),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

// The address as the world sees it: its DNS record, then a certificate for the name.
const published = (host: string) =>
  records(host, "A").pipe(Effect.map((addresses) => addresses[0]));

const certified = (host: string, address: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host: address, port: 443, servername: host, timeout: 5000 });
    const end = (ok: boolean) => {
      socket.destroy();
      resume(Effect.succeed(ok));
    };
    socket.once("secureConnect", () => end(socket.authorized));
    socket.once("error", () => end(false));
    socket.once("timeout", () => end(false));
  });

// Any record for a name, as Cloudflare's resolver sees it.
const answers = (name: string) =>
  Effect.gen(function* () {
    return (yield* records(name, "A")).length > 0 || (yield* records(name, "AAAA")).length > 0;
  });

// Alchemy keeps a stage's state in the checkout that deployed it.
const stateDir = (stage: string) => join(root, ".alchemy", "state", "scotty", stage);
const deployedHere = (stage: string) =>
  existsSync(stateDir(stage)) && readdirSync(stateDir(stage)).length > 0;

// A stage takes over the address and the domain's preview record and route, and its teardown
// deletes them, so a new stage may not share them with another deployment.
const taken = (config: Config) =>
  Effect.gen(function* () {
    if (deployedHere(config.stage)) return undefined;
    if (yield* answers(config.host)) return `https://${config.host}`;
    if (yield* answers(`1-scotty-preview-check.${config.domain}`))
      return `previews on *.${config.domain}`;
    return undefined;
  });

// This Mac's own lookup, which can remember the name as missing from before the deploy.
const resolvesHere = (host: string) =>
  Effect.tryPromise(() => lookup(host)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

// A new host needs its DNS record and certificate before Access can sign in to it. There is no
// limit: each stage says what it waits for, and Ctrl-C says how to go on.
const reachable = (host: string, stage: string) =>
  Effect.gen(function* () {
    const url = `https://${host}`;
    const flush = "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder";
    const { spin, release } = stoppable("Stopped waiting", () => {
      ui.cancel(
        `scotty-${stage} is deployed.\n   ${bold("scotty init")} goes on from here; ${bold("scotty teardown")} removes it.`,
      );
      process.exit(130);
    });
    const started = performance.now();
    const slow = () => performance.now() - started > 600_000;
    // A new address's DNS record often takes several minutes to appear.
    spin.start(`Waiting for DNS ${dim(`— ${host}`)}`);
    while (true) {
      const address = yield* published(host);
      if (address === undefined)
        spin.message(
          `Waiting for DNS ${dim(`— ${host}${slow() ? "; check the domain's DNS in Cloudflare" : ""}`)}`,
        );
      else if (!(yield* certified(host, address)))
        spin.message(`Waiting for the certificate ${dim(`— ${host}`)}`);
      else if (!(yield* resolvesHere(host)))
        spin.message(
          `Waiting for this Mac's DNS cache ${dim(`— ${url} is live; ${flush} clears it`)}`,
        );
      else {
        release();
        return spin.stop(`${url} is live`);
      }
      yield* Effect.sleep("5 seconds");
    }
  });

const elapsed = (since: number) => {
  const seconds = Math.round((performance.now() - since) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

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
    const config = yield* settings(previous);
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
    const inUse = yield* taken(config);
    if (inUse !== undefined) {
      ui.cancel(`${inUse} is already in use.`);
      return yield* failure(
        "usage",
        `${inUse} is already in use; deploying scotty-${config.stage} would take it over`,
        "Tear down the stage that uses it, or pick a domain no other stage uses",
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
    const started = performance.now();
    yield* writeConfig(config);
    const url = yield* deployWith(
      config,
      spinners(
        `Parts of scotty-${config.stage} may already be in Cloudflare.\n   ${bold("scotty init")} picks up where this stopped; ${bold("scotty teardown")} removes it.`,
      ),
    );
    yield* reachable(config.host, config.stage);
    yield* accessLogin(url, config.email);
    yield* signIns(agents);
    const result = yield* checks;
    ui.note(checkLines(result).join("\n"), "Doctor");
    if (result.some((check) => check.status === "fail")) {
      process.exitCode = 3;
      return ui.outro(`Fix the ${red("✗")} items, then ${bold("scotty doctor")}`);
    }
    ui.note(
      renderUnicodeCompact(url, { border: 2, invert: true }).trimEnd(),
      "Scan to open on your phone",
    );
    ui.outro(
      [
        `${green(`Scotty is up in ${elapsed(started)}`)} at ${bold(url)}`,
        "",
        `   ${dim("Start a session from here:")} scotty new owner/repo "What to do"`,
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
      // Without the stage's state, destroy removes nothing.
      const state = stateDir(config.stage);
      if (!deployedHere(config.stage))
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
        Option.isNone(stage)
          ? spinners(
              `Part of stage ${config.stage} may be left.\n   ${bold("scotty teardown")} finishes removing it.`,
            )
          : undefined,
        `Removed stage ${config.stage}`,
      );
      // The config stays until Cloudflare shows nothing of the stage, so a rerun can finish it.
      const { leftovers } = yield* cloudflare;
      const left = yield* leftovers(config.accountId, config.stage).pipe(
        Effect.mapError(() =>
          failure("teardown", "Could not check what is left in Cloudflare", "scotty teardown"),
        ),
      );
      if (left.length > 0)
        return yield* failure(
          "teardown",
          `Still in Cloudflare: ${left.join(", ")}`,
          "scotty teardown finishes removing it",
        );
      yield* removeConfig;
      if (Option.isNone(stage)) return ui.outro(dim("scotty init sets it up again"));
      yield* output(
        { stage: config.stage, removed: true },
        `${green("✓")} Removed stage ${config.stage}\n${dim("  → scotty init to set it up again")}`,
      );
    }),
);
