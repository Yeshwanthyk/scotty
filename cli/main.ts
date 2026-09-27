import { BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command, CliError } from "effect/unstable/cli";
import { CliFailure, failure } from "./client.js";
import { doctor, signin } from "./commands/setup.js";
import { create, ls, show, log } from "./commands/sessions.js";
import { steer, interrupt, stop } from "./commands/actions.js";
import { read } from "./commands/read.js";

const help: Record<string, string> = {
  scotty:
    "Usage: scotty <command> [--url https://host]\nCommands: doctor, signin, new, ls, show, steer, interrupt, stop, read, log\nRun scotty <command> --help for options.\nExample: scotty doctor",
  doctor:
    "Usage: scotty doctor [--url https://host]\nCheck Access and Worker connectivity.\nExample: scotty doctor",
  signin:
    "Usage: scotty signin [--url https://host]\nSign in to ChatGPT with a device code.\nExample: scotty signin",
  new: "Usage: scotty new <owner/repo|https://github.com/owner/repo> [--prompt text] [--key key] [--url https://host]\nCreate a session; --key makes retries idempotent.\nExample: scotty new octocat/Hello-World --prompt 'Describe the code'",
  ls: "Usage: scotty ls [--url https://host]\nList sessions.\nExample: scotty ls",
  show: "Usage: scotty show <id> [--url https://host]\nShow a session.\nExample: scotty show abcdef",
  steer:
    "Usage: scotty steer <id> <text> [--req id] [--url https://host]\nSend text to a session.\nExample: scotty steer abcdef 'Run the checks'",
  interrupt:
    "Usage: scotty interrupt <id> [--req id] [--url https://host]\nInterrupt the current turn.\nExample: scotty interrupt abcdef",
  stop: "Usage: scotty stop <id> [--url https://host]\nStop a session's container; a later steer resumes it.\nExample: scotty stop abcdef",
  read: "Usage: scotty read <id> [--last N] [--role user|assistant] [--url https://host]\nRead one snapshot with session authority and latest turn status. --last defaults to 1 (integer 1–500); filter by role before selecting the last messages. Empty assistant messages are omitted.\nExample: scotty read abcdef --last 5 --role assistant",
  log: "Usage: scotty log <id> [--url https://host]\nShow raw events.\nExample: scotty log abcdef",
};

const root = Command.make("scotty").pipe(
  Command.withSubcommands([doctor, signin, create, ls, show, steer, interrupt, stop, read, log]),
);
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  const name = args.find((arg) => Object.hasOwn(help, arg)) ?? "scotty";
  console.log(help[name]);
} else {
  try {
    await Effect.runPromise(
      Command.runWith(root, { version: "0.4.0", renderErrors: false })(args).pipe(
        Effect.provideService(Console.Console, { ...console, log: () => {} }),
        Effect.provide(BunServices.layer),
      ),
    );
  } catch (cause: unknown) {
    const error =
      cause instanceof CliFailure
        ? cause
        : CliError.isCliError(cause)
          ? failure("usage", "Invalid command or arguments", "scotty --help", 2)
          : failure("request_failed", "Command failed", "scotty doctor");
    console.log(
      JSON.stringify({ error: { code: error.code, message: error.message, hint: error.hint } }),
    );
    process.exitCode = error.exit;
  }
}
