import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Queue, Scope, Stream } from "effect";
import {
  AgentError,
  type Config,
  type AgentOutput,
  type AgentReady,
  type Delivered,
  type Runner,
} from "../../runner.js";
import { processEnv } from "../../runtime.js";

// The native claude from the SDK's platform package, installed by the image.
const executable = () =>
  processEnv("SCOTTY_CLAUDE") ||
  "/usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";

// Claude's stderr tail goes into the event log; tokens never do.
const redact = (line: string) =>
  line
    .replaceAll(String.fromCharCode(27), "")
    .replace(/\[[0-9;]*m/g, "")
    .replace(/sk-ant-[\w-]+/g, "[redacted]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]")
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);

// Messages for the running query. Claude reads them as it is ready for them.
class Inbox {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  push(message: SDKUserMessage) {
    this.items.push(message);
    this.wake?.();
  }
  end() {
    this.done = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.items.shift();
      if (next !== undefined) yield next;
      else if (this.done) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

type Live = { readonly query: Query; readonly inbox: Inbox; readonly gen: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Keeps frames small: only text and thinking deltas of the stream, and only the patch
// of a tool's structured result (Edit and Write; a new file's content), with long tool output cut.
const slim = (message: SDKMessage): SDKMessage | undefined => {
  if (message.type === "auth_status") return undefined;
  if (message.type === "stream_event") {
    const event = message.event;
    return event.type === "content_block_delta" &&
      (event.delta.type === "text_delta" || event.delta.type === "thinking_delta")
      ? message
      : undefined;
  }
  if (message.type !== "user" || !("tool_use_result" in message)) return message;
  const result = message.tool_use_result;
  const content = message.message.content;
  return {
    ...message,
    tool_use_result:
      isRecord(result) && "structuredPatch" in result
        ? {
            type: result.type,
            filePath: result.filePath,
            structuredPatch: result.structuredPatch,
            ...(result.type === "create" && typeof result.content === "string"
              ? { content: result.content.slice(0, 64_000) }
              : {}),
          }
        : undefined,
    message: {
      ...message.message,
      content: Array.isArray(content)
        ? content.map((block) =>
            block.type === "tool_result" && typeof block.content === "string"
              ? { ...block, content: block.content.slice(0, 16_000) }
              : block,
          )
        : content,
    },
  };
};

const outcome = (result: SDKResultMessage, interrupted: boolean) =>
  interrupted || result.terminal_reason?.startsWith("aborted_") === true
    ? ("interrupted" as const)
    : result.subtype === "success" && !result.is_error
      ? ("completed" as const)
      : ("failed" as const);

export class ClaudeRunner implements Runner {
  private session: string | undefined;
  private env: Record<string, string> = {};
  private scope: Scope.Scope | undefined;
  private live: Live | undefined;
  private gen = 0;
  private closed = false;
  private readonly stderr: string[] = [];
  // The DO turn Claude is working on, and the uuids of the messages sent into it.
  private activeDo: string | undefined;
  private readonly sent = new Set<string>();
  private interrupting: Deferred.Deferred<void> | undefined;
  private readonly endedDo = new Set<string>();
  readonly events: Stream.Stream<AgentOutput>;
  private constructor(
    private readonly agent: Extract<Config, { kind: "claude" }>,
    private readonly cwd: string,
    private readonly output: Queue.Queue<AgentOutput>,
  ) {
    this.events = Stream.fromQueue(output);
  }
  static make(agent: Extract<Config, { kind: "claude" }>, cwd: string) {
    return Effect.gen(function* () {
      return new ClaudeRunner(agent, cwd, yield* Queue.unbounded<AgentOutput>());
    });
  }

  private launch(resume: boolean): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const session = this.session;
      const scope = this.scope;
      if (session === undefined || scope === undefined) return;
      const inbox = new Inbox();
      const gen = ++this.gen;
      // e2e sessions run the scripted stand-in (container/scripted/claude.ts) with no token.
      const scripted = "scripted" in this.agent;
      const running = query({
        prompt: inbox,
        options: {
          cwd: this.cwd,
          pathToClaudeCodeExecutable: scripted
            ? "/usr/local/bin/scotty-claude-scripted"
            : executable(),
          // env replaces the environment, so only these reach Claude and its commands.
          env: {
            ...this.env,
            PATH: processEnv("PATH"),
            HOME: processEnv("HOME") || "/home/scotty",
            LANG: "C.UTF-8",
            TERM: "xterm-256color",
            ...(scripted ? {} : { CLAUDE_CODE_OAUTH_TOKEN: this.agent.token }),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
          },
          ...(resume ? { resume: session } : { sessionId: session }),
          model: this.agent.model,
          mcpServers: Object.fromEntries(
            (this.agent.mcp ?? []).map((server) => [
              server.name,
              { type: "http" as const, url: server.url },
            ]),
          ),
          ...(scripted ? {} : { effort: this.agent.effort }),
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          disallowedTools: ["AskUserQuestion", "ExitPlanMode"],
          includePartialMessages: true,
          stderr: (data) => {
            for (const line of data.split("\n"))
              if (line.trim() !== "") this.stderr.push(redact(line));
            this.stderr.splice(0, Math.max(0, this.stderr.length - 20));
          },
        },
      });
      this.live = { query: running, inbox, gen };
      yield* Stream.fromAsyncIterable(running, (error) => error).pipe(
        Stream.runForEach((message) => this.receive(message, gen)),
        Effect.exit,
        Effect.andThen(this.exited(gen)),
        Effect.forkIn(scope),
      );
    });
  }

  // Claude ended on its own: the session stops and can resume.
  private exited(gen: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.closed || gen !== this.gen) return;
      this.live = undefined;
      const tail = this.stderr.slice(-5).join(" | ");
      yield* Queue.offer(this.output, {
        type: "error",
        code: "exit",
        message: `Claude exited${tail ? `: ${tail}` : ""}`.slice(0, 1000),
      });
    });
  }

  private receive(message: SDKMessage, gen: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (gen !== this.gen) return;
      const event = slim(message);
      if (event !== undefined)
        yield* Queue.offer(this.output, { type: "agent", kind: "claude", event });
      if (message.type !== "result") return;
      const doTurn = this.activeDo;
      // A result for nothing Scotty sent, or with more of the turn's messages still queued.
      if (doTurn === undefined || (message.queued_turn_count ?? 0) > 0) return;
      const answered = message.user_message_uuids ?? [];
      if (answered.length > 0 && !answered.some((uuid) => this.sent.has(uuid))) return;
      yield* this.end(doTurn, message.uuid, outcome(message, this.interrupting !== undefined));
    });
  }

  private end(
    turn: string,
    result: string,
    state: "completed" | "interrupted" | "failed",
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.activeDo = undefined;
      this.sent.clear();
      this.endedDo.add(turn);
      yield* Queue.offer(this.output, { type: "turn_end", turn, codexTurn: result, state });
      if (this.interrupting !== undefined) yield* Deferred.succeed(this.interrupting, undefined);
      this.interrupting = undefined;
    });
  }

  start(
    env: Record<string, string>,
    threadId?: string,
  ): Effect.Effect<AgentReady, AgentError, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      this.env = env;
      this.session = threadId ?? crypto.randomUUID();
      this.scope = yield* Effect.scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          this.closed = true;
          this.live?.inbox.end();
          this.live?.query.close();
        }),
      );
      // Claude sends nothing until the first prompt, so the ID Scotty chose is the session.
      yield* this.launch(threadId !== undefined);
      return { kind: "claude", session: this.session };
    });
  }

  send(req: string, turn: string, text: string): Effect.Effect<Delivered, AgentError> {
    return Effect.gen({ self: this }, function* () {
      const live = this.live;
      if (live === undefined || this.session === undefined)
        return yield* new AgentError({ code: "not_ready", message: "agent not ready" });
      if (this.endedDo.has(turn))
        return yield* new AgentError({ code: "stale", message: "turn already ended" });
      // With a turn running, the message is a steer: Claude folds it into that turn.
      if (this.activeDo === undefined) this.activeDo = turn;
      const uuid = crypto.randomUUID();
      this.sent.add(uuid);
      live.inbox.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        uuid,
        session_id: this.session,
        origin: { kind: "human" },
      });
      return { req };
    });
  }

  // Claude stops the turn and keeps its process. If no result comes within 3 s,
  // the turn ends as interrupted and Claude restarts on the same session.
  interrupt(_req: string): Effect.Effect<void, AgentError> {
    return Effect.gen({ self: this }, function* () {
      const live = this.live;
      const turn = this.activeDo;
      if (live === undefined || turn === undefined)
        return yield* new AgentError({ code: "no_turn", message: "no active turn" });
      const ended = this.interrupting ?? (yield* Deferred.make<void>());
      this.interrupting = ended;
      yield* Effect.tryPromise({
        try: () => live.query.interrupt(),
        catch: () => new AgentError({ code: "interrupt", message: "Claude interrupt failed" }),
      }).pipe(Effect.timeout("3 seconds"), Effect.ignore);
      const answered = yield* Deferred.await(ended).pipe(Effect.timeoutOption("3 seconds"));
      if (answered._tag === "Some" || this.live !== live) return;
      this.gen++;
      live.inbox.end();
      live.query.close();
      yield* this.end(turn, crypto.randomUUID(), "interrupted");
      yield* this.launch(true);
    });
  }
}
