// Claude's side of the session view and start: its Agent SDK messages as items and text, and
// the agent settings a Claude start sends.
import type { AgentConfig } from "../../../protocol/supervisor.js";
import type { AgentSettings } from "./agent-settings.js";
import {
  array,
  type Change,
  type Item,
  type Json,
  namedTool,
  record,
  string,
  tail,
  tool,
  type TurnItems,
  unwrapShell,
  upsert,
} from "../items.js";

const repoPath = (path: string) => path.replace(/^\/workspace\/repo\//, "");

// Claude's structured patch as unified hunks; a new file's content is its diff, as with Codex.
function change(result: Json): Change | undefined {
  const path = string(result["filePath"]);
  if (path === "") return undefined;
  if (result["type"] === "create")
    return { path: repoPath(path), kind: "add", diff: string(result["content"]) };
  const diff = array(result["structuredPatch"])
    .flatMap((entry) => {
      const hunk = record(entry);
      if (hunk === undefined) return [];
      const header = `@@ -${String(hunk["oldStart"])},${String(hunk["oldLines"])} +${String(hunk["newStart"])},${String(hunk["newLines"])} @@`;
      return [header, ...array(hunk["lines"]).map(string)];
    })
    .join("\n");
  return { path: repoPath(path), kind: "update", diff };
}

const blockText = (content: unknown) =>
  typeof content === "string"
    ? content
    : array(content)
        .map((part) => string(record(part)?.["text"]))
        .join("\n");

const notice = (turn: TurnItems, text: string, tone: "info" | "error"): TurnItems => ({
  ...turn,
  items: [...turn.items, { kind: "notice", id: `notice-${turn.items.length}`, text, tone }],
});

// Earlier text in the turn was commentary once Claude goes on to use a tool.
const commentary = (items: Item[]) =>
  items.map((item) => (item.kind === "text" && item.final ? { ...item, final: false } : item));

function assistant(turn: TurnItems, message: Json): TurnItems {
  const uuid = string(message["uuid"]);
  // Streamed text is replaced by the message it became.
  let items = turn.items.filter((item) => !item.id.startsWith("live-"));
  array(record(message["message"])?.["content"]).forEach((entry, index) => {
    const block = record(entry);
    if (block === undefined) return;
    const id = `${uuid}-${index}`;
    if (block["type"] === "text")
      items = upsert(items, { kind: "text", id, text: string(block["text"]), final: true });
    else if (block["type"] === "thinking")
      items = upsert(items, { kind: "thinking", id, text: string(block["thinking"]) });
    else if (block["type"] === "tool_use") {
      const name = string(block["name"]);
      const input = record(block["input"]) ?? {};
      items = commentary(items);
      if (name === "TodoWrite") {
        const steps = array(input["todos"]).flatMap((todo) => {
          const fields = record(todo);
          return fields === undefined
            ? []
            : [{ step: string(fields["content"]), status: string(fields["status"]) }];
        });
        items = upsert(items, { kind: "plan", id: "plan", steps });
        return;
      }
      const command = string(input["command"]);
      items = upsert(
        items,
        tool(string(block["id"]), name, {
          ...namedTool(name, input),
          status: "running",
          input: name === "Bash" ? unwrapShell(command) : JSON.stringify(input, null, 2),
        }),
      );
    }
  });
  const next = { ...turn, items };
  return message["error"] === "authentication_failed"
    ? notice(next, "Claude is signed out. Run scotty login claude.", "error")
    : next;
}

function user(turn: TurnItems, message: Json): TurnItems {
  const result = record(message["tool_use_result"]);
  let items = turn.items;
  for (const entry of array(record(message["message"])?.["content"])) {
    const block = record(entry);
    if (block === undefined || block["type"] !== "tool_result") continue;
    const existing = items.find((item) => item.id === string(block["tool_use_id"]));
    if (existing?.kind !== "tool") continue;
    const changed = result === undefined ? undefined : change(result);
    items = upsert(items, {
      ...existing,
      status: block["is_error"] === true ? "failed" : "done",
      output: tail(blockText(block["content"])),
      changes: changed === undefined ? existing.changes : [changed],
    });
  }
  return { ...turn, items };
}

// Folds one Claude SDK message into a turn's items. Subagent messages show only as their Task row.
export function step(turn: TurnItems, event: unknown): TurnItems {
  const message = record(event);
  if (message === undefined || (message["parent_tool_use_id"] ?? null) !== null) return turn;
  switch (message["type"]) {
    case "stream_event": {
      const stream = record(message["event"]);
      const delta = record(stream?.["delta"]);
      const thinking = delta?.["type"] === "thinking_delta";
      const text = string(thinking ? delta?.["thinking"] : delta?.["text"]);
      const id = `live-${String(stream?.["index"])}`;
      const existing = turn.items.find((item) => item.id === id);
      const item: Item = thinking
        ? {
            kind: "thinking",
            id,
            text: (existing?.kind === "thinking" ? existing.text : "") + text,
          }
        : {
            kind: "text",
            id,
            text: (existing?.kind === "text" ? existing.text : "") + text,
            final: false,
          };
      return { ...turn, items: upsert(turn.items, item) };
    }
    case "assistant":
      return assistant(turn, message);
    case "user":
      return user(turn, message);
    case "system":
      return message["subtype"] === "compact_boundary"
        ? notice(turn, "Context compacted", "info")
        : turn;
    case "rate_limit_event": {
      const info = record(message["rate_limit_info"]);
      if (info?.["status"] !== "rejected") return turn;
      const resets = info["resetsAt"];
      return notice(
        turn,
        typeof resets === "number"
          ? `Claude usage limit reached; resets at ${new Date(resets * 1000).toISOString()}`
          : "Claude usage limit reached",
        "error",
      );
    }
    case "result":
      return message["is_error"] === true || message["subtype"] !== "success"
        ? notice(
            turn,
            string(message["result"]) ||
              array(message["errors"]).map(string).join("\n") ||
              "Claude failed",
            "error",
          )
        : turn;
    default:
      return turn;
  }
}

// The answer is the last text Claude finished; streamed text isn't counted.
export function text(event: unknown): { text: string; complete: boolean } | undefined {
  const message = record(event);
  if (message?.["type"] !== "assistant" || (message["parent_tool_use_id"] ?? null) !== null)
    return undefined;
  const parts = array(record(message["message"])?.["content"]).flatMap((entry) => {
    const block = record(entry);
    return block?.["type"] === "text" ? [string(block["text"])] : [];
  });
  return parts.length === 0 ? undefined : { text: parts.join("\n\n"), complete: true };
}

export const startConfig = (
  claude: { readonly token: string },
  settings: typeof AgentSettings.Type,
): Extract<typeof AgentConfig.Type, { kind: "claude" }> => ({
  kind: "claude",
  model: settings.model,
  effort: settings.effort,
  token: claude.token,
});
