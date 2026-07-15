import type { LifecycleAction, OutputMode } from "./types";

export class UsageError extends Error {}

export type ParsedArgs = {
  action: LifecycleAction;
  id?: string;
  mode: OutputMode;
  cwd?: string;
  force: boolean;
  project?: string;
  provider?: string;
  prompt?: string;
  title?: string;
  branch?: string;
  session?: string;
  all: boolean;
};

const actions = new Set<LifecycleAction>(["up", "down", "vaporize", "resume", "list", "status", "help"]);
const booleanFlags = new Set(["force", "json", "all"]);
const valueFlags = new Set(["cwd", "project", "provider", "prompt", "title", "branch", "session"]);

export const usage = `usage:
  scotty beam up [--cwd <path>] [--session <provider:id>] [--force]
  scotty beam up --project <owner/repo> [--provider <name>] [--prompt <text>]
  scotty beam down <id> [--cwd <path>] [--force]
  scotty beam vaporize <id>
  scotty beam resume <id>
  scotty beam list [--all]
  scotty beam status <id>
  scotty beam help [command]

All commands accept --json.`;

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] !== "beam") throw new UsageError(usage);
  const action = argv[1];
  if (!actions.has(action as LifecycleAction)) throw new UsageError(usage);

  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const separator = raw.indexOf("=");
    const name = separator === -1 ? raw : raw.slice(0, separator);
    if (booleanFlags.has(name)) {
      if (separator !== -1) throw new UsageError(`--${name} does not take a value`);
      flags.set(name, true);
      continue;
    }
    if (!valueFlags.has(name)) throw new UsageError(`unknown flag --${name}`);
    const inlineValue = separator === -1 ? undefined : raw.slice(separator + 1);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} requires a value`);
    flags.set(name, value);
    if (inlineValue === undefined) index += 1;
  }

  const parsedAction = action as LifecycleAction;
  if (parsedAction === "up" && positionals.length > 0) {
    throw new UsageError("scotty beam up does not take an id; use --session to select a local agent session");
  }
  if (parsedAction === "list" && positionals.length > 0) throw new UsageError("scotty beam list does not take an id");
  if (["down", "vaporize", "resume", "status"].includes(parsedAction) && positionals.length !== 1) {
    throw new UsageError(`scotty beam ${parsedAction} requires exactly one id`);
  }
  if (parsedAction === "help" && positionals.length > 1) throw new UsageError("scotty beam help accepts at most one command");
  if (parsedAction !== "up" && flags.has("project")) {
    throw new UsageError(`--project is only valid with scotty beam up`);
  }
  if (flags.has("project") && flags.has("session")) {
    throw new UsageError("--project and --session are mutually exclusive");
  }

  return {
    action: parsedAction,
    ...(positionals[0] === undefined ? {} : { id: positionals[0] }),
    mode: flags.has("json") ? "json" : "text",
    force: flags.has("force"),
    all: flags.has("all"),
    ...stringFlag(flags, "cwd"),
    ...stringFlag(flags, "project"),
    ...stringFlag(flags, "provider"),
    ...stringFlag(flags, "prompt"),
    ...stringFlag(flags, "title"),
    ...stringFlag(flags, "branch"),
    ...stringFlag(flags, "session"),
  };
}

function stringFlag(flags: Map<string, string | true>, name: string): Record<string, string> {
  const value = flags.get(name);
  return typeof value === "string" ? { [name]: value } : {};
}
