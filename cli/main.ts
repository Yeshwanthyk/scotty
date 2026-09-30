#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command, CliError } from "effect/unstable/cli";
import { version } from "../src/version.js";
import { CliFailure, failure } from "./client.js";
import { bold, dim, json, red } from "./commands/common.js";
import { deploy, skill } from "./commands/deploy.js";
import { init, teardown } from "./commands/init.js";
import { doctor, login } from "./commands/setup.js";
import { create, ls, log, open, read } from "./commands/sessions.js";
import { hatch, interrupt, resume, rm, steer, stop } from "./commands/actions.js";
import { push } from "./commands/push.js";
import { connect, connections, deliveries } from "./commands/connections.js";
import { automation, runs } from "./commands/automations.js";

const overview = `${bold("scotty")} — Codex and Claude sessions in Cloudflare Containers

${bold("Setup")}
  init                            Set up Scotty: questions, deploy, sign-ins, doctor
  deploy                          Deploy this Scotty to the configured stage (--image ref)
  teardown                        Remove the stage from Cloudflare and its config
  doctor                          Check setup, sign-ins and the deployment
  login chatgpt|github|claude     Sign in to an account sessions use
  skill                           Print the guide to hand your own agent

${bold("Sessions")}
  new <repo> <prompt>             Start a session (--agent claude, --key <retry key>,
                                  --session-key <key>: a repeat steers that session)
  ls [--search <text>]            List sessions; search title, repo, branch, prompt, key
  read <id>                       Read the latest messages (--last N, --role user|assistant)
  steer <id> <text>               Send text; a stopped session resumes
  interrupt <id>                  Interrupt the current turn
  stop <id> / resume <id>         Stop a container, or resume from its last save
  rm <id…>                        Delete stopped sessions
  open [id]                       Open Scotty, or a session, in the browser
  hatch <id> <port>               Print the preview URL for a port
  log <id>                        Print raw events

${bold("What sessions get")}
  push skill <path…>              Upload skills (a folder with SKILL.md, or a zip)
  push instructions <file|->      Set the instructions every session gets
  ls skills                       List skills and the instructions
  rm skill <name>                 Delete a skill

${bold("Hooks")}
  connect webhook <name>          Make a webhook: its URL, and the secret (shown once)
  connections                     List connections
  deliveries                      List deliveries, newest first (--connection <name>)
  rm connection <name>            Delete a connection

${bold("Automations")}
  automation add <name> <repo> <prompt>
                                  Add one, off: --cron "0 9 * * 1" --tz Europe/London,
                                  --every <minutes> or --on <connection>
  automation ls                   List automations and their last runs
  automation enable <name>        Turn one on (--off turns it off)
  automation run <name>           Run one now
  automation rm <name>            Delete an automation
  runs                            List runs, newest first (--automation <name>)

${bold("Flags")}
  --json      JSON output (the default when piped)
  --version   Print the version
  --help      Help for a command: scotty <command> --help

${dim("An id can be the first 4+ characters shown by scotty ls.")}`;

const help: Record<string, string> = {
  init: `Usage: scotty init
Asks for the stage, your email, the Cloudflare account and a domain on it, saves them to
~/.config/scotty/config.json, deploys, then signs in to Access, ChatGPT, GitHub and (optionally)
Claude, and ends with doctor. Run it in a terminal; running it again keeps finished steps.`,
  teardown: `Usage: scotty teardown [--stage name]
Remove the configured stage from Cloudflare: the Worker with every session and sign-in, the
container app, the bucket and its files, Access and previews. Then deletes the config.
Asks you to type the stage name; --stage <name> confirms it without asking.`,
  deploy: `Usage: scotty deploy [--image docker.io/<repo>@sha256:<digest>]
Deploy the release this CLI carries (from a checkout, one built there) to the stage in the
Scotty config, copying its container image into Cloudflare. Run it after \`scotty init\`.
--image deploys an image built FROM Scotty's; it is refused unless its scotty.supervisor label
matches. A later deploy without --image goes back to Scotty's image.`,
  doctor: `Usage: scotty doctor
Check the config, Cloudflare Access, the Worker and each sign-in, and print the fix for each problem.
Exits 3 when something required is missing.`,
  login: `Usage: scotty login chatgpt|github|claude
chatgpt   Opens the device-code page and waits for you to enter the code.
github    Saves the token from \`gh auth token\`, or from stdin when piped.
claude    Runs \`claude setup-token\` and saves the token, or reads it from stdin when piped.
Example: gh auth token | scotty login github`,
  new: `Usage: scotty new <owner/repo | https://github.com/owner/repo> <prompt> [--agent codex|claude] [--key key] [--session-key key]
Start a session with Codex (the default) or Claude. --key makes retries idempotent.
--session-key names the session: the same key with the same repository and agent sends the
prompt to that session (resuming it if stopped); with another repository or agent it is refused.
Example: scotty new octocat/Hello-World "Describe the code"`,
  ls: `Usage: scotty ls [skills] [--search <text>]
List sessions, newest activity first; \`ls skills\` lists skills and the instructions.
--search keeps sessions whose title, repository, branch, first prompt or key contains the text (up to 200 characters, any case).`,
  read: `Usage: scotty read <id> [--last N] [--role user|assistant]
Print the session state and its last N messages (default 1, at most 500), filtered by role first.
Example: scotty read 3f2a --last 5 --role assistant`,
  steer: `Usage: scotty steer <id> <text> [--req id]
Send text to a session; a stopped session resumes first.
Example: scotty steer 3f2a "Run the checks"`,
  interrupt: `Usage: scotty interrupt <id> [--req id]
Interrupt the current turn.`,
  stop: `Usage: scotty stop <id>
Stop a session's container; its work is saved and \`scotty resume\` or a steer picks it up.`,
  resume: `Usage: scotty resume <id>
Resume a stopped session from its last save.`,
  rm: `Usage: scotty rm <id…> | scotty rm skill <name> | scotty rm connection <name>
Delete stopped sessions with their saves and files, or delete a skill or a connection.`,
  open: `Usage: scotty open [id]
Open Scotty, or one session, in the default browser.`,
  hatch: `Usage: scotty hatch <id> <port>
Print the preview URL for a server on <port> in a running session.
Example: scotty hatch 3f2a 8080`,
  log: `Usage: scotty log <id>
Print a session's raw events (one JSON object per line in a terminal).`,
  skill: `Usage: scotty skill
Print the Scotty skill: how an agent sets up and drives Scotty with this CLI.
Save it for your agent: scotty skill > ~/.claude/skills/scotty/SKILL.md`,
  connect: `Usage: scotty connect webhook <name>
Make a webhook that starts sessions. Prints its URL and its secret once. A sender POSTs JSON
{"repo": "owner/repo", "prompt": "…", "key": "optional", "agent": "codex|claude", "title": "optional"}
to the URL, signed as Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature).
A repeated key sends the prompt to the session that key started.`,
  connections: `Usage: scotty connections
List connections (names, kinds and URLs; secrets are never shown again).`,
  deliveries: `Usage: scotty deliveries [--connection name]
List what senders posted, newest first: accepted (with its session), rejected (and why) or
duplicate. The last 200 are shown.`,
  automation: `Usage: scotty automation add|ls|enable|run|rm
add <name> <owner/repo> <prompt> (--cron "<5 fields>" --tz <IANA zone> | --every <minutes> | --on <connection>)
    [--only field=value[,value…]] [--key template] [--agent codex|claude]
  Adds an automation, off; enable it to run. A calendar schedule is read in its zone; an interval
  counts from when it is turned on; --on fires on each delivery to that webhook connection.
  --only keeps payloads whose field (a.b for nested) is one of the values; repeat it for more.
  The prompt and --key take {{field}} from the payload (a schedule's payload is {"at": time}).
  A run whose key already has a session sends the prompt to that session.
ls                   List automations in plain words, on or off, with the last run.
enable <name> [--off]  Turn one on or off. A schedule missed while off does not run.
run <name>           Run one now, on or off; prints the run and its session.
rm <name>            Delete an automation; its runs stay listed.
Example: scotty automation add standup octocat/Hello-World "Summarise yesterday's commits" --cron "0 9 * * 1-5" --tz Europe/London`,
  runs: `Usage: scotty runs [--automation name]
List runs, newest first: what fired them, skipped (and why), started or steered a session, or
failed; and how that session's turn went. The last 100 are shown.`,
  push: `Usage: scotty push skill <folder|zip…> | scotty push instructions <file|->
skill          Upload skills; one with the same name is replaced and keeps its on/off setting.
instructions   Set the text every session gets; - reads stdin, an empty file clears it.
New sessions and resumes get the change.
Example: scotty push instructions ./AGENTS.md`,
};

const root = Command.make("scotty").pipe(
  Command.withSubcommands([
    init,
    deploy,
    teardown,
    doctor,
    login,
    skill,
    create,
    ls,
    read,
    steer,
    interrupt,
    stop,
    resume,
    rm,
    open,
    hatch,
    log,
    push,
    connect,
    connections,
    deliveries,
    automation,
    runs,
  ]),
);

// The library wraps argument errors in ShowHelp, whose own message is only "Help requested".
const problem = (error: CliError.CliError) =>
  error._tag === "ShowHelp" ? (error.errors[0]?.message ?? "Missing arguments") : error.message;

const report = (error: CliFailure) => {
  if (json)
    console.log(
      JSON.stringify({ error: { code: error.code, message: error.message, hint: error.hint } }),
    );
  // A cancelled prompt has already said so on screen.
  else if (error.code !== "cancelled")
    console.error(`${red("✗")} ${error.message}\n  ${dim(`→ ${error.hint}`)}`);
  process.exitCode = error.exit;
};

const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const name = args.find((arg) => !arg.startsWith("-"));
if (args.includes("--version") || args.includes("-v")) {
  console.log(json ? JSON.stringify({ version }) : version);
} else if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(name !== undefined && Object.hasOwn(help, name) ? help[name] : overview);
} else if (name === undefined || !Object.hasOwn(help, name)) {
  report(failure("usage", `Unknown command: ${name ?? args.join(" ")}`, "scotty --help", 2));
} else {
  try {
    await Effect.runPromise(
      Command.runWith(root, { version, renderErrors: false })(args).pipe(
        // The command library prints its own messages; ours go through output().
        Effect.provideService(Console.Console, { ...console, log: () => {} }),
        Effect.provide(BunServices.layer),
      ),
    );
  } catch (cause: unknown) {
    report(
      cause instanceof CliFailure
        ? cause
        : CliError.isCliError(cause)
          ? failure("usage", problem(cause), `scotty ${name} --help`, 2)
          : failure("request_failed", "Command failed", "scotty doctor"),
    );
  }
}
