// A stand-in for `codex app-server --listen stdio://` that e2e sessions run instead of Codex, so
// they need no ChatGPT account and don't depend on what a model says. It speaks the messages
// the supervisor's Codex adapter uses, in the shapes Codex 0.157.1 sends them, and reads each
// prompt as a script (script.ts). Its messages are typed by codex-protocol.ts, generated from
// that Codex, so typecheck holds them to its protocol.
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Option, Schema } from "effect";
import type {
  AgentMessageDeltaNotification,
  CommandExecutionOutputDeltaNotification,
  InitializeResponse,
  ItemCompletedNotification,
  ItemStartedNotification,
  Thread,
  ThreadItem,
  ThreadResumeResponse,
  ThreadStartedNotification,
  ThreadStartResponse,
  ThreadStatusChangedNotification,
  Turn as TurnBody,
  TurnCompletedNotification,
  TurnInterruptResponse,
  TurnStartedNotification,
  TurnStartResponse,
  TurnSteerResponse,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "./codex-protocol.js";
import { fill, lines, shell, step } from "./script.js";

type Notifications = {
  "thread/started": ThreadStartedNotification;
  "thread/status/changed": ThreadStatusChangedNotification;
  "turn/started": TurnStartedNotification;
  "turn/completed": TurnCompletedNotification;
  "item/started": ItemStartedNotification;
  "item/completed": ItemCompletedNotification;
  "item/agentMessage/delta": AgentMessageDeltaNotification;
  "item/commandExecution/outputDelta": CommandExecutionOutputDeltaNotification;
};

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
});
const Input = Schema.Array(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
);
const ThreadParams = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
});
const TurnParams = Schema.Struct({ threadId: Schema.String, input: Input });
const SteerParams = Schema.Struct({
  threadId: Schema.String,
  expectedTurnId: Schema.String,
  input: Input,
});
const InterruptParams = Schema.Struct({ threadId: Schema.String, turnId: Schema.String });
// Typecheck fails unless every request the pinned Codex's protocol allows decodes.
type Covers<Sent, Read> = [Sent] extends [Read] ? true : never;
const covers: [
  Covers<ThreadStartParams, typeof ThreadParams.Encoded>,
  Covers<ThreadResumeParams, typeof ThreadParams.Encoded>,
  Covers<TurnStartParams, typeof TurnParams.Encoded>,
  Covers<TurnSteerParams, typeof SteerParams.Encoded>,
  Covers<TurnInterruptParams, typeof InterruptParams.Encoded>,
] = [true, true, true, true, true];
void covers;

type Turn = {
  readonly id: string;
  readonly thread: string;
  readonly lines: string[];
  readonly items: ThreadItem[];
  readonly startedAt: number;
  interrupted: boolean;
  child: ChildProcess | undefined;
};

const home = process.env.CODEX_HOME ?? `${process.env.HOME ?? "/home/scotty"}/.codex`;
const sessions = `${home}/sessions`;
let thread: string | undefined;
let cwd = process.cwd();
let active: Turn | undefined;
let lastOutput = "";

const seconds = () => Math.floor(Date.now() / 1000);
const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id: string | number, result: object) => write({ id, result });
const fail = (id: string | number, message: string) =>
  write({ id, error: { code: -32600, message } });
const notify = <M extends keyof Notifications>(method: M, params: Notifications[M]) =>
  write({ method, params, emittedAtMs: Date.now() });
const started = (turn: Turn, item: ThreadItem) =>
  notify("item/started", { item, threadId: turn.thread, turnId: turn.id, startedAtMs: Date.now() });
const completed = (turn: Turn, item: ThreadItem) =>
  notify("item/completed", {
    item,
    threadId: turn.thread,
    turnId: turn.id,
    completedAtMs: Date.now(),
  });
const turnBody = (turn: Turn, status: "inProgress" | "completed" | "interrupted"): TurnBody => ({
  id: turn.id,
  items: status === "inProgress" ? [] : turn.items,
  itemsView: status === "inProgress" ? "notLoaded" : "summary",
  status,
  error: null,
  startedAt: turn.startedAt,
  completedAt: status === "inProgress" ? null : seconds(),
  durationMs: status === "inProgress" ? null : (seconds() - turn.startedAt) * 1000,
});
// The rollout file is what the supervisor saves and restores; resume needs it back.
const rollout = (id: string) => `${sessions}/rollout-scripted-${id}.jsonl`;
const record = (id: string, entry: object) =>
  appendFileSync(rollout(id), `${JSON.stringify(entry)}\n`);

const Entry = Schema.fromJsonString(Schema.Struct({ input: Schema.String }));
// What the thread remembers survives a stop only through the restored rollout file.
const recall = (id: string) => () =>
  readFileSync(rollout(id), "utf8")
    .split("\n")
    .map((line) => Schema.decodeUnknownOption(Entry)(line))
    .find(Option.isSome)
    ?.pipe(
      Option.map((entry) => entry.input),
      Option.getOrElse(() => ""),
    ) ?? "";

const userMessage = (turn: Turn, text: string) => {
  const item: ThreadItem = {
    type: "userMessage",
    id: crypto.randomUUID(),
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
  };
  started(turn, item);
  completed(turn, item);
  record(turn.thread, { turn: turn.id, input: text });
};

const say = (turn: Turn, text: string) => {
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const message = (text: string): ThreadItem => ({
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  });
  started(turn, message(""));
  // Real replies stream in pieces.
  for (let at = 0; at < text.length; at += 4)
    notify("item/agentMessage/delta", {
      threadId: turn.thread,
      turnId: turn.id,
      itemId: id,
      delta: text.slice(at, at + 4),
    });
  const done = message(text);
  completed(turn, done);
  turn.items.push(done);
};

const run = async (turn: Turn, command: string) => {
  const id = `call_${crypto.randomUUID().replaceAll("-", "")}`;
  const execution = (
    status: "inProgress" | "completed" | "failed" | "declined",
    result: { output: string; exitCode: number; durationMs: number } | undefined,
  ): ThreadItem => ({
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: `/bin/bash -lc ${JSON.stringify(command)}`,
    cwd,
    processId: null,
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command }],
    aggregatedOutput: result?.output ?? null,
    exitCode: result?.exitCode ?? null,
    durationMs: result?.durationMs ?? null,
  });
  started(turn, execution("inProgress", undefined));
  const startedAt = Date.now();
  const { output, exitCode } = await shell(command, cwd, (child) => (turn.child = child));
  turn.child = undefined;
  if (output !== "")
    notify("item/commandExecution/outputDelta", {
      threadId: turn.thread,
      turnId: turn.id,
      itemId: id,
      delta: output,
    });
  lastOutput = output.trim();
  const done = execution(turn.interrupted ? "declined" : exitCode === 0 ? "completed" : "failed", {
    output,
    exitCode,
    durationMs: Date.now() - startedAt,
  });
  completed(turn, done);
  turn.items.push(done);
};

const perform = async (turn: Turn) => {
  for (
    let line = turn.lines.shift();
    line !== undefined && !turn.interrupted;
    line = turn.lines.shift()
  ) {
    const next = step(line);
    if (next.kind === "run") await run(turn, next.command);
    else say(turn, fill(next.text, lastOutput, recall(turn.thread)));
  }
  if (active === turn) active = undefined;
  notify("turn/completed", {
    threadId: turn.thread,
    turn: turnBody(turn, turn.interrupted ? "interrupted" : "completed"),
  });
  notify("thread/status/changed", { threadId: turn.thread, status: { type: "idle" } });
};

const text = (input: typeof Input.Type) => input.map((part) => part.text ?? "").join("\n");

const threadBody = (id: string): Thread => ({
  id,
  sessionId: id,
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "legacy",
  modelProvider: "scotty-managed",
  model: "scripted",
  reasoningEffort: null,
  createdAt: seconds(),
  updatedAt: seconds(),
  recencyAt: null,
  status: { type: "idle" },
  path: rollout(id),
  cwd,
  cliVersion: "0.157.1",
  originator: null,
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
});

const handle = (message: typeof Message.Type) => {
  const { id, method } = message;
  if (method === undefined) return;
  if (id === undefined) return; // notifications such as `initialized` need nothing
  const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
    Schema.decodeUnknownOption(schema)(message.params);
  switch (method) {
    case "initialize":
      return reply(id, {
        userAgent: "scotty-scripted/0.157.1",
        codexHome: home,
        platformFamily: "unix",
        platformOs: "linux",
      } satisfies InitializeResponse);
    case "thread/start":
    case "thread/resume": {
      const params = decode(ThreadParams);
      if (Option.isNone(params)) return fail(id, "invalid params");
      cwd = params.value.cwd ?? cwd;
      mkdirSync(sessions, { recursive: true });
      let current: string;
      if (method === "thread/resume") {
        const wanted = params.value.threadId;
        if (wanted === undefined || !existsSync(rollout(wanted)))
          return fail(id, `no rollout found for thread id ${wanted ?? ""}`);
        current = wanted;
      } else {
        current = crypto.randomUUID();
        record(current, { thread: current });
      }
      thread = current;
      const opened = {
        thread: threadBody(current),
        model: "scripted",
        modelProvider: "scotty-managed",
        serviceTier: null,
        cwd,
        disabledPluginIds: [],
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: null,
      } satisfies ThreadStartResponse;
      reply(
        id,
        method === "thread/start"
          ? opened
          : ({
              ...opened,
              collaborationMode: null,
              turnsBackwardsCursor: null,
              itemsBackwardsCursor: null,
            } satisfies ThreadResumeResponse),
      );
      return notify("thread/started", { thread: threadBody(current) });
    }
    case "turn/start": {
      const params = decode(TurnParams);
      if (thread === undefined || Option.isNone(params) || params.value.threadId !== thread)
        return fail(id, "invalid params");
      if (active !== undefined) return fail(id, "a turn is already running");
      const turn: Turn = {
        id: crypto.randomUUID(),
        thread,
        lines: lines(text(params.value.input)),
        items: [],
        startedAt: seconds(),
        interrupted: false,
        child: undefined,
      };
      active = turn;
      reply(id, { turn: turnBody(turn, "inProgress") } satisfies TurnStartResponse);
      notify("thread/status/changed", {
        threadId: thread,
        status: { type: "active", activeFlags: [] },
      });
      notify("turn/started", { threadId: thread, turn: turnBody(turn, "inProgress") });
      userMessage(turn, text(params.value.input));
      void perform(turn);
      return;
    }
    case "turn/steer": {
      const params = decode(SteerParams);
      if (
        Option.isNone(params) ||
        active === undefined ||
        params.value.expectedTurnId !== active.id
      )
        return fail(id, "no matching active turn");
      active.lines.push(...lines(text(params.value.input)));
      userMessage(active, text(params.value.input));
      return reply(id, { turnId: active.id } satisfies TurnSteerResponse);
    }
    case "turn/interrupt": {
      const params = decode(InterruptParams);
      if (Option.isNone(params) || active === undefined || params.value.turnId !== active.id)
        return fail(id, "no matching active turn");
      active.interrupted = true;
      active.child?.kill();
      return reply(id, {} satisfies TurnInterruptResponse);
    }
    default:
      return write({ id, error: { code: -32601, message: `${method} is not scripted` } });
  }
};

for await (const line of createInterface({ input: process.stdin })) {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Message))(line);
  if (Option.isSome(decoded)) handle(decoded.value);
}
