// Claude's side of the session view and start: its Agent SDK messages as items and text, and
// the agent settings a Claude start sends.
import { Option, Schema } from "effect";
import type { AgentConfig } from "../../../protocol/supervisor.js";
import type { AgentSettings } from "./agent-settings.js";
import {
  type Change,
  type Item,
  namedTool,
  tail,
  tool,
  type TurnItems,
  unwrapShell,
  upsert,
} from "../items.js";

// The Agent SDK message shapes this view reads, named as in the pinned SDK's types. Each message,
// content block and hunk decodes on its own, so an unknown kind or a malformed part is skipped and
// extra fields are ignored.
const Blocks = Schema.Array(Schema.Unknown);
const Input = Schema.Record(Schema.String, Schema.Unknown);

const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const ContentBlock = Schema.Union([
  TextBlock,
  Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    id: Schema.String,
    name: Schema.String,
    input: Input,
  }),
]);
type ToolUseBlock = Extract<typeof ContentBlock.Type, { type: "tool_use" }>;
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock);
const decodeContentBlock = Schema.decodeUnknownOption(ContentBlock);

const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optional(Schema.Union([Schema.String, Blocks])),
  is_error: Schema.optional(Schema.Boolean),
});
const decodeToolResultBlock = Schema.decodeUnknownOption(ToolResultBlock);
const decodeTextPart = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }));

const Todo = Schema.Struct({ content: Schema.String, status: Schema.String });
const decodeTodos = Schema.decodeUnknownOption(Schema.Struct({ todos: Blocks }));
const decodeTodo = Schema.decodeUnknownOption(Todo);
const decodeCommand = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }));

// The supervisor keeps only the patch of an Edit or Write result, and a new file's content.
const FileResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    filePath: Schema.String,
    content: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.optional(Schema.Literal("update")),
    filePath: Schema.String,
    structuredPatch: Schema.optional(Blocks),
  }),
]);
const decodeFileResult = Schema.decodeUnknownOption(FileResult);
const Hunk = Schema.Struct({
  oldStart: Schema.optional(Schema.Number),
  oldLines: Schema.optional(Schema.Number),
  newStart: Schema.optional(Schema.Number),
  newLines: Schema.optional(Schema.Number),
  lines: Schema.optional(Schema.Array(Schema.String)),
});
const decodeHunk = Schema.decodeUnknownOption(Hunk);

const Parent = Schema.NullOr(Schema.String);
const AssistantMessage = Schema.Struct({
  type: Schema.Literal("assistant"),
  uuid: Schema.String,
  parent_tool_use_id: Schema.optional(Parent),
  message: Schema.Struct({ content: Blocks }),
  error: Schema.optional(Schema.String),
});
const UserMessage = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({ content: Schema.Union([Schema.String, Blocks]) }),
  tool_use_result: Schema.optional(Schema.Unknown),
});
const Message = Schema.Union([
  AssistantMessage,
  UserMessage,
  // The supervisor forwards only text and thinking deltas of the stream.
  Schema.Struct({
    type: Schema.Literal("stream_event"),
    event: Schema.Struct({
      index: Schema.Number,
      delta: Schema.Union([
        Schema.Struct({
          type: Schema.Literal("text_delta"),
          text: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("thinking_delta"),
          thinking: Schema.String,
        }),
      ]),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("compact_boundary"),
  }),
  Schema.Struct({
    type: Schema.Literal("rate_limit_event"),
    rate_limit_info: Schema.Struct({
      status: Schema.String,
      resetsAt: Schema.optional(Schema.Number),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.String,
    is_error: Schema.Boolean,
    result: Schema.optional(Schema.String),
    errors: Schema.optional(Schema.Array(Schema.String)),
  }),
]);
const decodeMessage = Schema.decodeUnknownOption(Message);
const decodeAssistant = Schema.decodeUnknownOption(AssistantMessage);
const decodeSubagent = Schema.decodeUnknownOption(
  Schema.Struct({ parent_tool_use_id: Schema.NonEmptyString }),
);

const repoPath = (path: string) => path.replace(/^\/workspace\/repo\//, "");

// `-start,lines`, leaving out a number the hunk doesn't give.
const range = (start: number | undefined, lines: number | undefined) =>
  [start, lines].filter((n) => n !== undefined).join(",");

// Claude's structured patch as unified hunks; a new file's content is its diff, as with Codex.
function change(result: unknown): Change | undefined {
  const decoded = decodeFileResult(result);
  if (Option.isNone(decoded) || decoded.value.filePath === "") return undefined;
  const file = decoded.value;
  if (file.type === "create")
    return {
      path: repoPath(file.filePath),
      kind: "add",
      diff: file.content ?? "",
    };
  const diff = (file.structuredPatch ?? [])
    .flatMap((entry) => {
      const hunk = decodeHunk(entry);
      if (Option.isNone(hunk)) return [];
      const { oldStart, oldLines, newStart, newLines, lines = [] } = hunk.value;
      return [`@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@`, ...lines];
    })
    .join("\n");
  return { path: repoPath(file.filePath), kind: "update", diff };
}

const blockText = (content: string | ReadonlyArray<unknown> | undefined) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((part) =>
          Option.getOrElse(
            Option.map(decodeTextPart(part), (fields) => fields.text),
            () => "",
          ),
        )
        .join("\n");

const notice = (turn: TurnItems, text: string, tone: "info" | "error"): TurnItems => ({
  ...turn,
  items: [...turn.items, { kind: "notice", id: `notice-${turn.items.length}`, text, tone }],
});

// Earlier text in the turn was commentary once Claude goes on to use a tool.
const commentary = (items: Item[]) =>
  items.map((item) => (item.kind === "text" && item.final ? { ...item, final: false } : item));

const toolUse = (block: ToolUseBlock, parent?: string) =>
  tool(block.id, block.name, {
    ...namedTool(block.name, block.input),
    status: "running",
    input:
      block.name === "Bash"
        ? unwrapShell(
            Option.getOrElse(
              Option.map(decodeCommand(block.input), (fields) => fields.command),
              () => "",
            ),
          )
        : JSON.stringify(block.input, null, 2),
    ...(parent === undefined ? {} : { parent }),
  });

// A subagent's tools nest under its Agent row; its text and plan stay inside the subagent.
function subagent(turn: TurnItems, event: unknown, parent: string): TurnItems {
  const message = decodeMessage(event);
  if (Option.isNone(message)) return turn;
  if (message.value.type === "user") return user(turn, message.value);
  if (message.value.type !== "assistant") return turn;
  let items = turn.items;
  for (const entry of message.value.message.content) {
    const block = decodeContentBlock(entry);
    if (Option.isNone(block) || block.value.type !== "tool_use" || block.value.name === "TodoWrite")
      continue;
    items = upsert(items, toolUse(block.value, parent));
  }
  return { ...turn, items };
}

function assistant(turn: TurnItems, message: typeof AssistantMessage.Type): TurnItems {
  // Streamed text is replaced by the message it became.
  let items = turn.items.filter((item) => !item.id.startsWith("live-"));
  message.message.content.forEach((entry, index) => {
    const decoded = decodeContentBlock(entry);
    if (Option.isNone(decoded)) return;
    const block = decoded.value;
    const id = `${message.uuid}-${index}`;
    if (block.type === "text")
      items = upsert(items, {
        kind: "text",
        id,
        text: block.text,
        final: true,
      });
    else if (block.type === "thinking")
      items = upsert(items, { kind: "thinking", id, text: block.thinking });
    else {
      items = commentary(items);
      if (block.name === "TodoWrite") {
        const todos = Option.getOrElse(
          Option.map(decodeTodos(block.input), (input) => input.todos),
          () => [],
        );
        const steps = todos.flatMap((entry) => {
          const todo = decodeTodo(entry);
          return Option.isNone(todo)
            ? []
            : [{ step: todo.value.content, status: todo.value.status }];
        });
        items = upsert(items, { kind: "plan", id: "plan", steps });
        return;
      }
      items = upsert(items, toolUse(block));
    }
  });
  const next = { ...turn, items };
  return message.error === "authentication_failed"
    ? notice(next, "Claude is signed out. Run scotty login claude.", "error")
    : next;
}

function user(turn: TurnItems, message: typeof UserMessage.Type): TurnItems {
  const changed = change(message.tool_use_result);
  const content = message.message.content;
  let items = turn.items;
  for (const entry of typeof content === "string" ? [] : content) {
    const decoded = decodeToolResultBlock(entry);
    if (Option.isNone(decoded)) continue;
    const block = decoded.value;
    const existing = items.find((item) => item.id === block.tool_use_id);
    if (existing?.kind !== "tool") continue;
    items = upsert(items, {
      ...existing,
      status: block.is_error === true ? "failed" : "done",
      output: tail(blockText(block.content)),
      changes: changed === undefined ? existing.changes : [changed],
    });
  }
  return { ...turn, items };
}

// Folds one Claude SDK message into a turn's items.
export function step(turn: TurnItems, event: unknown): TurnItems {
  const parent = decodeSubagent(event);
  if (Option.isSome(parent)) return subagent(turn, event, parent.value.parent_tool_use_id);
  const decoded = decodeMessage(event);
  if (Option.isNone(decoded)) return turn;
  const message = decoded.value;
  switch (message.type) {
    case "stream_event": {
      const { delta, index } = message.event;
      const id = `live-${String(index)}`;
      const existing = turn.items.find((item) => item.id === id);
      const item: Item =
        delta.type === "thinking_delta"
          ? {
              kind: "thinking",
              id,
              text: (existing?.kind === "thinking" ? existing.text : "") + delta.thinking,
            }
          : {
              kind: "text",
              id,
              text: (existing?.kind === "text" ? existing.text : "") + delta.text,
              final: false,
            };
      return { ...turn, items: upsert(turn.items, item) };
    }
    case "assistant":
      return assistant(turn, message);
    case "user":
      return user(turn, message);
    case "system":
      return notice(turn, "Context compacted", "info");
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      if (info.status !== "rejected") return turn;
      return notice(
        turn,
        info.resetsAt === undefined
          ? "Claude usage limit reached"
          : `Claude usage limit reached; resets at ${new Date(info.resetsAt * 1000).toISOString()}`,
        "error",
      );
    }
    case "result":
      return message.is_error || message.subtype !== "success"
        ? notice(
            turn,
            message.result || (message.errors ?? []).join("\n") || "Claude failed",
            "error",
          )
        : turn;
  }
}

// The answer is the last text Claude finished; streamed text isn't counted.
export function text(event: unknown): { text: string; complete: boolean } | undefined {
  const message = decodeAssistant(event);
  if (Option.isNone(message) || (message.value.parent_tool_use_id ?? null) !== null)
    return undefined;
  const parts = message.value.message.content.flatMap((entry) =>
    Option.toArray(Option.map(decodeTextBlock(entry), (block) => block.text)),
  );
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
