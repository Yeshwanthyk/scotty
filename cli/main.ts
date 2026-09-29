import { BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command, CliError } from "effect/unstable/cli";
import { version } from "../src/version.js";
import { CliFailure, failure } from "./client.js";
import { bold, dim, json, red } from "./commands/common.js";
import { deploy } from "./commands/deploy.js";
import { doctor, login } from "./commands/setup.js";
import { create, ls, log, open, read } from "./commands/sessions.js";
import { hatch, interrupt, resume, rm, steer, stop } from "./commands/actions.js";
import { push } from "./commands/push.js";

const overview = `${bold("scotty")} — Codex and Claude sessions in Cloudflare Containers

${bold("Setup")}
  deploy                          Deploy Scotty from this checkout to the configured stage
  doctor                          Check setup, sign-ins and the deployment
  login chatgpt|github|claude     Sign in to an account sessions use

${bold("Sessions")}
  new <repo> <prompt>             Start a session (--agent claude, --key <retry key>)
  ls                              List sessions
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

${bold("Flags")}
  --json      JSON output (the default when piped)
  --version   Print the version
  --help      Help for a command: scotty <command> --help

${dim("An id can be the first 4+ characters shown by scotty ls.")}`;

const help: Record<string, string> = {
  deploy: `Usage: scotty deploy
Build the UI, copy the pinned container image and deploy the stage in the Scotty config.
Asks nothing; run it from a Scotty checkout after \`scotty init\`.`,
  doctor: `Usage: scotty doctor
Check the config, Cloudflare Access, the Worker and each sign-in, and print the fix for each problem.
Exits 3 when something required is missing.`,
  login: `Usage: scotty login chatgpt|github|claude
chatgpt   Opens the device-code page and waits for you to enter the code.
github    Saves the token from \`gh auth token\`, or from stdin when piped.
claude    Runs \`claude setup-token\` and saves the token, or reads it from stdin when piped.
Example: gh auth token | scotty login github`,
  new: `Usage: scotty new <owner/repo | https://github.com/owner/repo> <prompt> [--agent codex|claude] [--key key]
Start a session with Codex (the default) or Claude. --key makes retries idempotent.
Example: scotty new octocat/Hello-World "Describe the code"`,
  ls: `Usage: scotty ls [skills]
List sessions, newest activity first; \`ls skills\` lists skills and the instructions.`,
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
  rm: `Usage: scotty rm <id…> | scotty rm skill <name>
Delete stopped sessions with their saves and files, or delete a skill.`,
  open: `Usage: scotty open [id]
Open Scotty, or one session, in the default browser.`,
  hatch: `Usage: scotty hatch <id> <port>
Print the preview URL for a server on <port> in a running session.
Example: scotty hatch 3f2a 8080`,
  log: `Usage: scotty log <id>
Print a session's raw events (one JSON object per line in a terminal).`,
  push: `Usage: scotty push skill <folder|zip…> | scotty push instructions <file|->
skill          Upload skills; one with the same name is replaced and keeps its on/off setting.
instructions   Set the text every session gets; - reads stdin, an empty file clears it.
New sessions and resumes get the change.
Example: scotty push instructions ./AGENTS.md`,
};

const root = Command.make("scotty").pipe(
  Command.withSubcommands([
    deploy,
    doctor,
    login,
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
  else console.error(`${red("✗")} ${error.message}\n  ${dim(`→ ${error.hint}`)}`);
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
