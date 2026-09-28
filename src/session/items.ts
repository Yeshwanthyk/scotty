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

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const string = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) => (typeof value === "number" ? value : null);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// `/bin/zsh -lc 'rg foo'` reads as `rg foo`.
export const unwrapShell = (command: string) => {
  const inner = /^(?:\S*\/)?(?:ba|z)?sh -l?c ([\s\S]*)$/.exec(command.trim())?.[1];
  if (inner === undefined) return command.trim();
  const quote = inner[0];
  return (quote === "'" || quote === '"') && inner.endsWith(quote) ? inner.slice(1, -1) : inner;
};

const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
const list = (names: string[]) =>
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

const status = (value: unknown): ToolStatus =>
  value === "failed"
    ? "failed"
    : value === "declined"
      ? "declined"
      : value === "inProgress"
        ? "running"
        : "done";

const tool = (
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

function commandSummary(item: Json) {
  const actions = array(item["commandActions"]).flatMap((action) => {
    const fields = record(action);
    return fields === undefined ? [] : [fields];
  });
  const kinds = new Set(actions.map((action) => action["type"]));
  const command = string(item["command"]);
  if (actions.length > 0 && !kinds.has("unknown")) {
    if (kinds.size === 1 && kinds.has("read"))
      return {
        category: "inspect" as const,
        summary: `Read ${list(actions.map((action) => string(action["name"]) || base(string(action["path"]))))}`,
      };
    if (kinds.size === 1 && kinds.has("search")) {
      const query = string(actions[0]?.["query"]);
      return {
        category: "inspect" as const,
        summary: query ? `Search for ${query}` : "Search files",
      };
    }
    if (kinds.size === 1 && kinds.has("listFiles"))
      return {
        category: "inspect" as const,
        summary: `List ${string(actions[0]?.["path"]) || "files"}`,
      };
    return { category: "inspect" as const, summary: `Explore ${actions.length} places` };
  }
  return commandTool(command);
}

// One Codex app-server ThreadItem as an item, or nothing for kinds the UI doesn't draw.
export function codexItem(value: unknown): Item | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const id = string(item["id"]);
  switch (item["type"]) {
    case "agentMessage":
      return {
        kind: "text",
        id,
        text: string(item["text"]),
        final: item["phase"] !== "commentary",
      };
    case "reasoning": {
      const text = [...array(item["summary"]), ...array(item["content"])].map(string).join("\n\n");
      return { kind: "thinking", id, text };
    }
    case "commandExecution":
      return tool(id, "shell", {
        ...commandSummary(item),
        status: status(item["status"]),
        input: unwrapShell(string(item["command"])),
        output: tail(string(item["aggregatedOutput"])),
        exitCode: number(item["exitCode"]),
        durationMs: number(item["durationMs"]),
      });
    case "fileChange": {
      const changes = array(item["changes"]).flatMap((entry): Change[] => {
        const change = record(entry);
        if (change === undefined) return [];
        const kind = record(change["kind"])?.["type"] ?? change["kind"];
        return [
          {
            path: string(change["path"]).replace(/^\/workspace\/repo\//, ""),
            kind: kind === "add" ? "add" : kind === "delete" ? "delete" : "update",
            diff: string(change["diff"]),
          },
        ];
      });
      const verb = changes.every((change) => change.kind === "add")
        ? "Create"
        : changes.every((change) => change.kind === "delete")
          ? "Delete"
          : "Edit";
      return tool(id, "apply_patch", {
        category: "change",
        summary: `${verb} ${list(changes.map((change) => base(change.path)))}`,
        status: status(item["status"]),
        changes,
      });
    }
    case "mcpToolCall": {
      const result = record(item["result"]);
      const error = record(item["error"]);
      const content = array(result?.["content"])
        .map((part) => string(record(part)?.["text"]))
        .join("\n");
      return tool(id, `${string(item["server"])}.${string(item["tool"])}`, {
        category: "research",
        summary: `${string(item["server"])} · ${string(item["tool"])}`,
        status: status(item["status"]),
        input: JSON.stringify(item["arguments"] ?? {}, null, 2),
        output: tail(error === undefined ? content : string(error["message"])),
        durationMs: number(item["durationMs"]),
      });
    }
    case "webSearch": {
      const action = record(item["action"]);
      const url = string(action?.["url"]);
      return tool(id, "web_search", {
        category: "research",
        summary: url
          ? `Open ${url}`
          : `Search the web for ${string(item["query"] ?? action?.["query"])}`,
      });
    }
    case "collabAgentToolCall": {
      const verb: Record<string, string> = {
        spawnAgent: "Start a subagent",
        sendInput: "Message a subagent",
        wait: "Wait for subagents",
      };
      return tool(id, string(item["tool"]), {
        category: "agent",
        summary: verb[string(item["tool"])] ?? string(item["tool"]),
        status: status(item["status"]),
        input: string(item["prompt"]),
      });
    }
    case "imageView":
      return tool(id, "view_image", {
        category: "inspect",
        summary: `View ${base(string(item["path"]))}`,
      });
    case "contextCompaction":
      return { kind: "notice", id, text: "Context compacted", tone: "info" };
    default:
      return undefined;
  }
}

export type TurnItems = { items: Item[]; diff: string };

const upsert = (items: Item[], next: Item) => {
  const at = items.findIndex((item) => item.id === next.id);
  return at < 0 ? [...items, next] : items.map((item, index) => (index === at ? next : item));
};

// Folds one Codex notification into a turn's items. Deltas grow the item a later completion replaces.
export function codexStep(turn: TurnItems, event: unknown): TurnItems {
  const fields = record(event);
  const params = record(fields?.["params"]);
  if (fields === undefined || params === undefined) return turn;
  const method = fields["method"];
  const itemId = string(params["itemId"]);
  const delta = string(params["delta"]);
  const existing = turn.items.find((item) => item.id === itemId);
  switch (method) {
    case "item/started":
    case "item/completed": {
      const item = codexItem(params["item"]);
      if (item === undefined) return turn;
      // A started item carries no streamed text yet; keep what deltas already gave it.
      const kept = turn.items.find((entry) => entry.id === item.id);
      if (method === "item/started" && kept !== undefined) return turn;
      return { ...turn, items: upsert(turn.items, item) };
    }
    case "item/agentMessage/delta":
      return {
        ...turn,
        items: upsert(
          turn.items,
          existing?.kind === "text"
            ? { ...existing, text: existing.text + delta }
            : { kind: "text", id: itemId, text: delta, final: false },
        ),
      };
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return {
        ...turn,
        items: upsert(
          turn.items,
          existing?.kind === "thinking"
            ? { ...existing, text: existing.text + delta }
            : { kind: "thinking", id: itemId, text: delta },
        ),
      };
    case "item/commandExecution/outputDelta":
      return existing?.kind === "tool"
        ? {
            ...turn,
            items: upsert(turn.items, { ...existing, output: tail(existing.output + delta) }),
          }
        : turn;
    case "turn/plan/updated": {
      const steps = array(params["plan"]).flatMap((entry) => {
        const step = record(entry);
        return step === undefined
          ? []
          : [{ step: string(step["step"]), status: string(step["status"]) }];
      });
      return { ...turn, items: upsert(turn.items, { kind: "plan", id: "plan", steps }) };
    }
    case "turn/diff/updated":
      return { ...turn, diff: string(params["diff"]) };
    case "error": {
      const error = record(params["error"]);
      const retry = params["willRetry"] === true;
      const text = string(error?.["message"]);
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "notice",
            id: `error-${turn.items.length}`,
            text: retry ? `Retrying: ${text}` : text,
            tone: retry ? "info" : "error",
          },
        ],
      };
    }
    default:
      return turn;
  }
}
