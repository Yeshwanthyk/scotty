// Codex's side of the session view and start: its app-server events as items and text, and
// the agent settings a Codex start sends.
import type { AgentConfig } from "../../../protocol/supervisor.js";
import type { AgentSettings } from "./agent-settings.js";
import {
  array,
  base,
  type Change,
  commandTool,
  type Item,
  type Json,
  list,
  number,
  record,
  string,
  tail,
  tool,
  type ToolStatus,
  type TurnItems,
  unwrapShell,
  upsert,
} from "../items.js";

const status = (value: unknown): ToolStatus =>
  value === "failed"
    ? "failed"
    : value === "declined"
      ? "declined"
      : value === "inProgress"
        ? "running"
        : "done";

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
function codexItem(value: unknown): Item | undefined {
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

// Folds one Codex notification into a turn's items. Deltas grow the item a later completion replaces.
export function step(turn: TurnItems, event: unknown): TurnItems {
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

export function text(event: unknown): { text: string; complete: boolean } | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return undefined;
  const method = Reflect.get(event, "method");
  const params: unknown = Reflect.get(event, "params");
  if (method !== "item/completed" && method !== "item/agentMessage/delta") return undefined;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return undefined;
  const item: unknown = Reflect.get(params, method === "item/completed" ? "item" : "delta");
  if (typeof item === "string") return { text: item, complete: false };
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const text: unknown = Reflect.get(item, "text");
  return typeof text === "string" ? { text, complete: method === "item/completed" } : undefined;
}

export const startConfig = (
  chatgpt: {
    readonly token: string;
    readonly accountId: string;
  },
  settings: typeof AgentSettings.Type,
): Extract<typeof AgentConfig.Type, { kind: "codex" }> => ({
  kind: "codex",
  model: settings.model,
  effort: settings.effort,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  token: chatgpt.token,
  accountId: chatgpt.accountId,
});
