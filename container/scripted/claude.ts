// A stand-in for the `claude` executable the Agent SDK spawns, which e2e sessions run instead of
// Claude Code, so they need no Claude account and don't depend on what a model says. It speaks
// stream-json on stdio as Claude Code does for the SDK's query(): control requests and SDK
// messages, typed by the pinned SDK so typecheck holds them to its protocol. Each prompt is read
// as a script (script.ts).
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  NonNullableUsage,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";
import { fill, lines, shell, step } from "./script.js";

const Input = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("control_request"),
    request_id: Schema.String,
    request: Schema.Struct({ subtype: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("user"),
    uuid: Schema.optional(Schema.String),
    message: Schema.Struct({
      content: Schema.Union([
        Schema.String,
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ]),
    }),
  }),
]);

type Turn = {
  readonly lines: string[];
  // The user messages this turn answers, as the result reports them.
  readonly answers: string[];
  readonly startedAt: number;
  interrupted: boolean;
  child: ChildProcess | undefined;
};

const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const resumed = flag("resume");
const session = resumed ?? flag("session-id") ?? crypto.randomUUID();
const cwd = process.cwd();
// Claude Code keeps a session in a project folder named after its cwd; the supervisor saves it.
const project = `${process.env.HOME ?? "/home/scotty"}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
const transcript = `${project}/${session}.jsonl`;
if (resumed !== undefined && !existsSync(transcript)) {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}
mkdirSync(project, { recursive: true });

let active: Turn | undefined;
let lastOutput = "";

const write = (message: SDKMessage | object) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
const record = (entry: object) =>
  appendFileSync(
    transcript,
    `${JSON.stringify({ ...entry, sessionId: session, cwd, timestamp: new Date().toISOString() })}\n`,
  );

const Entry = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("user"),
    message: Schema.Struct({ content: Schema.String }),
  }),
);
// What the session remembers survives a stop only through the restored transcript.
const recall = () =>
  readFileSync(transcript, "utf8")
    .split("\n")
    .map((line) => Schema.decodeUnknownOption(Entry)(line))
    .find(Option.isSome)
    ?.pipe(
      Option.map((entry) => entry.message.content),
      Option.getOrElse(() => ""),
    ) ?? "";

// A scripted reply uses no model, so every count is zero.
const usage: NonNullableUsage = {
  input_tokens: 0,
  output_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  fallback_credit: { status: { type: "redeemed" } },
  service_tier: "standard",
  inference_geo: "",
  iterations: [],
  speed: "standard",
};

const assistant = (content: SDKAssistantMessage["message"]["content"]) => {
  const message = {
    type: "assistant",
    message: {
      id: `msg_scripted_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      content,
      container: null,
      context_management: null,
      stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      usage,
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: session,
  } satisfies SDKAssistantMessage;
  write(message);
  record({ type: "assistant", uuid: message.uuid, message: message.message });
};

const say = (text: string) => {
  // Real replies stream in pieces before the message they become.
  for (let at = 0; at < text.length; at += 4)
    write({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: text.slice(at, at + 4) },
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: session,
    } satisfies SDKPartialAssistantMessage);
  assistant([{ type: "text", text, citations: null }]);
};

const run = async (turn: Turn, command: string) => {
  const id = `toolu_scripted_${crypto.randomUUID().replaceAll("-", "")}`;
  assistant([
    { type: "tool_use", id, name: "Bash", input: { command, description: "Run a scripted step" } },
  ]);
  const { output, exitCode } = await shell(command, cwd, (child) => (turn.child = child));
  turn.child = undefined;
  lastOutput = output.trim();
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: turn.interrupted ? "[Request interrupted by user for tool use]" : output,
          is_error: turn.interrupted || exitCode !== 0,
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: session,
    tool_use_result: { stdout: output, stderr: "", interrupted: turn.interrupted, isImage: false },
  } satisfies SDKUserMessage;
  write(message);
  record({ type: "user", uuid: message.uuid, message: message.message });
};

const result = (turn: Turn): SDKResultMessage => {
  const common = {
    type: "result" as const,
    duration_ms: Date.now() - turn.startedAt,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: session,
    user_message_uuids: turn.answers,
    queued_turn_count: 0,
  };
  return turn.interrupted
    ? {
        ...common,
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
        stop_reason: null,
        terminal_reason: "aborted_streaming",
      }
    : { ...common, subtype: "success", is_error: false, result: "", stop_reason: "end_turn" };
};

const perform = async (turn: Turn) => {
  for (
    let line = turn.lines.shift();
    line !== undefined && !turn.interrupted;
    line = turn.lines.shift()
  ) {
    const next = step(line);
    if (next.kind === "run") await run(turn, next.command);
    else say(fill(next.text, lastOutput, recall));
  }
  if (active === turn) active = undefined;
  write(result(turn));
};

const prompt = (content: typeof Input.Type & { type: "user" }) =>
  typeof content.message.content === "string"
    ? content.message.content
    : content.message.content.map((part) => part.text ?? "").join("\n");

const handle = (message: typeof Input.Type) => {
  if (message.type === "control_request") {
    const { subtype } = message.request;
    // An interrupt stops the running command; the turn then ends as interrupted.
    if (subtype === "interrupt" && active !== undefined) {
      active.interrupted = true;
      active.child?.kill();
    }
    return write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response:
          subtype === "initialize"
            ? {
                commands: [],
                agents: [],
                models: [],
                output_style: "default",
                available_output_styles: [],
              }
            : {},
      },
    });
  }
  const text = prompt(message);
  const uuid = message.uuid ?? crypto.randomUUID();
  record({ type: "user", uuid, message: { role: "user", content: text } });
  // With a turn running, a message is a steer: its lines join that turn.
  if (active !== undefined) {
    active.lines.push(...lines(text));
    active.answers.push(uuid);
    return;
  }
  const turn: Turn = {
    lines: lines(text),
    answers: [uuid],
    startedAt: Date.now(),
    interrupted: false,
    child: undefined,
  };
  active = turn;
  void perform(turn);
};

for await (const line of createInterface({ input: process.stdin })) {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Input))(line);
  if (Option.isSome(decoded)) handle(decoded.value);
}
active?.child?.kill();
