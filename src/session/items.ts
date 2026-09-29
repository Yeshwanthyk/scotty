// The agent-neutral shape the UI draws a turn from. Each agent's events are mapped here, purely.

export type ToolCategory = "inspect" | "change" | "check" | "research" | "agent" | "run" | "other";
export type ToolStatus = "running" | "done" | "failed" | "declined";
export type Change = { path: string; kind: "add" | "delete" | "update"; diff: string };

export type Item =
  | { kind: "text"; id: string; text: string; final: boolean }
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      category: ToolCategory;
      summary: string;
      status: ToolStatus;
      input: string;
      output: string;
      exitCode: number | null;
      durationMs: number | null;
      changes: Change[];
    }
  | { kind: "plan"; id: string; steps: { step: string; status: string }[] }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export type Tool = Extract<Item, { kind: "tool" }>;

const outputCap = 8 * 1024;
export const tail = (text: string) =>
  text.length <= outputCap ? text : `…${text.slice(text.length - outputCap)}`;

export type Json = Record<string, unknown>;
export const record = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
export const string = (value: unknown) => (typeof value === "string" ? value : "");
export const number = (value: unknown) => (typeof value === "number" ? value : null);
export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// `/bin/zsh -lc 'rg foo'` reads as `rg foo`.
export const unwrapShell = (command: string) => {
  const inner = /^(?:\S*\/)?(?:ba|z)?sh -l?c ([\s\S]*)$/.exec(command.trim())?.[1];
  if (inner === undefined) return command.trim();
  const quote = inner[0];
  return (quote === "'" || quote === '"') && inner.endsWith(quote) ? inner.slice(1, -1) : inner;
};

export const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
export const list = (names: string[]) =>
  names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;

const checks =
  /\b(?:(?:npm|pnpm|yarn|bun)(?: run)? (?:test|lint|typecheck|build|fmt|check)|vitest|jest|pytest|oxlint|eslint|tsc|(?:cargo|go) (?:test|build|check|clippy))\b/;
export const commandTool = (command: string) => {
  const line = unwrapShell(command);
  return {
    category: checks.test(line) ? ("check" as const) : ("run" as const),
    summary: line.split("\n")[0] ?? line,
  };
};

// Claude, Pi and Codex name the same tools differently; the summary is a verb and its targets.
export function namedTool(name: string, input: Json): { category: ToolCategory; summary: string } {
  const path = string(input["file_path"] ?? input["path"] ?? input["filePath"]);
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
    case "exec":
      return commandTool(string(input["command"] ?? input["cmd"]));
    case "read":
      return { category: "inspect", summary: `Read ${base(path)}` };
    case "glob":
    case "ls":
      return { category: "inspect", summary: `List ${string(input["pattern"]) || path || "."}` };
    case "grep":
    case "ffgrep":
      return {
        category: "inspect",
        summary: `Search for ${string(input["pattern"] ?? input["query"])}`,
      };
    case "edit":
    case "multiedit":
      return { category: "change", summary: `Edit ${base(path)}` };
    case "write":
      return { category: "change", summary: `Write ${base(path)}` };
    case "websearch":
    case "web_search":
      return { category: "research", summary: `Search the web for ${string(input["query"])}` };
    case "webfetch":
      return { category: "research", summary: `Open ${string(input["url"])}` };
    case "agent":
    case "task":
      return {
        category: "agent",
        summary: string(input["description"]) || "Run a subagent",
      };
    case "todowrite":
    case "update_plan":
      return { category: "other", summary: "Update the plan" };
    default:
      return name.startsWith("mcp__")
        ? { category: "research", summary: name.split("__").slice(1).join(" · ") }
        : { category: "other", summary: name };
  }
}

export const tool = (
  id: string,
  name: string,
  fields: Partial<Omit<Tool, "kind" | "id" | "name">> & Pick<Tool, "category" | "summary">,
): Tool => ({
  kind: "tool",
  id,
  name,
  status: "done",
  input: "",
  output: "",
  exitCode: null,
  durationMs: null,
  changes: [],
  ...fields,
});

export type TurnItems = { items: Item[]; diff: string };

export const upsert = (items: Item[], next: Item) => {
  const at = items.findIndex((item) => item.id === next.id);
  return at < 0 ? [...items, next] : items.map((item, index) => (index === at ? next : item));
};
