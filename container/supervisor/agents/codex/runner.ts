import { imageUrl, type PromptImage } from "../../../../protocol/prompt.js";
import { Effect, Option, Queue, Result, Schema, Stream, type Scope, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { supervisorVersion } from "../../../../protocol/supervisor.js";
import { launchCodex } from "./config.js";
import { CodexRpc } from "./rpc.js";
import { TurnNotice } from "./rpc-schema.js";
import {
  AgentError,
  type Config,
  type AgentOutput,
  type AgentReady,
  type Delivered,
  type Runner,
} from "../../runner.js";

const Thread = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) });
const Started = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) });
const Steered = Schema.Struct({ turnId: Schema.String });
const Notification = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

export class CodexRunner implements Runner {
  private rpc: CodexRpc | undefined;
  private thread: string | undefined;
  private activeCodex: string | undefined;
  private activeDo: string | undefined;
  private pendingDo: string | undefined;
  private readonly completed = new Set<string>();
  private readonly endedDo = new Set<string>();
  readonly events: Stream.Stream<AgentOutput>;
  private constructor(
    private readonly agent: Extract<Config, { kind: "codex" }>,
    private readonly cwd: string,
    private readonly output: Queue.Queue<AgentOutput>,
  ) {
    this.events = Stream.fromQueue(output);
  }
  static make(agent: Extract<Config, { kind: "codex" }>, cwd: string) {
    return Effect.gen(function* () {
      return new CodexRunner(agent, cwd, yield* Queue.unbounded<AgentOutput>());
    });
  }
  private receive(event: AgentOutput) {
    return Effect.gen({ self: this }, function* () {
      yield* Queue.offer(this.output, event);
      if (event.type !== "agent") return;
      const decoded = Schema.decodeUnknownResult(Notification)(event.event);
      if (
        Result.isFailure(decoded) ||
        (decoded.success.method !== "turn/started" && decoded.success.method !== "turn/completed")
      )
        return;
      const notice = yield* Schema.decodeUnknownEffect(TurnNotice)(decoded.success.params).pipe(
        Effect.option,
      );
      if (Option.isNone(notice) || notice.value.threadId !== this.thread) return;
      const turn = notice.value.turn;
      if (decoded.success.method === "turn/started" && !this.completed.has(turn.id)) {
        this.activeCodex = turn.id;
        this.activeDo = this.pendingDo ?? this.activeDo;
      } else if (
        decoded.success.method === "turn/completed" &&
        turn.status !== "inProgress" &&
        !this.completed.has(turn.id)
      ) {
        this.completed.add(turn.id);
        const doTurn = this.activeDo ?? this.pendingDo;
        if (this.activeCodex === turn.id) this.activeCodex = undefined;
        this.activeDo = undefined;
        this.pendingDo = undefined;
        if (doTurn !== undefined) {
          this.endedDo.add(doTurn);
          yield* Queue.offer(this.output, {
            type: "turn_end",
            turn: doTurn,
            codexTurn: turn.id,
            state: turn.status,
          });
        }
      }
    }) satisfies Effect.Effect<void>;
  }
  start(env: Record<string, string>, threadId?: string) {
    return Effect.gen({ self: this }, function* () {
      const child = yield* launchCodex(this.agent, this.cwd, env);
      const rpc = yield* CodexRpc.make(child);
      this.rpc = rpc;
      yield* rpc.start;
      yield* rpc.events.pipe(
        Stream.runForEach((event) => this.receive(event)),
        Effect.forkScoped,
      );
      yield* rpc.request("initialize", {
        clientInfo: { name: "scotty-sup", version: supervisorVersion },
        capabilities: { experimentalApi: false },
      });
      yield* rpc.notify("initialized");
      const method = threadId === undefined ? "thread/start" : "thread/resume";
      const result = yield* rpc.request(method, {
        ...(threadId === undefined ? {} : { threadId }),
        model: this.agent.model,
        modelProvider: "scotty-managed",
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      const thread = yield* Schema.decodeUnknownEffect(Thread)(result).pipe(
        Effect.mapError(
          () => new AgentError({ code: "protocol", message: `invalid ${method} reply` }),
        ),
      );
      this.thread = thread.thread.id;
      return { kind: "codex", session: thread.thread.id };
    }) satisfies Effect.Effect<
      AgentReady,
      AgentError,
      Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
    >;
  }
  send(req: string, turn: string, text: string, images: readonly PromptImage[] = []) {
    return Effect.gen({ self: this }, function* () {
      const rpc = this.rpc;
      const threadId = this.thread;
      if (rpc === undefined || threadId === undefined)
        return yield* new AgentError({ code: "not_ready", message: "agent not ready" });
      if (this.endedDo.has(turn))
        return yield* new AgentError({ code: "stale", message: "turn already ended" });
      const active = this.activeCodex;
      if (active !== undefined) {
        const result = yield* rpc.request("turn/steer", {
          threadId,
          expectedTurnId: active,
          input: [
            { type: "text", text },
            ...images.map((image) => ({ type: "image", url: imageUrl(image) })),
          ],
        });
        const response = yield* Schema.decodeUnknownEffect(Steered)(result).pipe(
          Effect.mapError(
            () => new AgentError({ code: "protocol", message: "invalid steer reply" }),
          ),
        );
        if (response.turnId !== active)
          return yield* new AgentError({
            code: "turn_mismatch",
            message: "steer targeted another turn",
          });
      } else {
        this.pendingDo = turn;
        const result = yield* rpc.request("turn/start", {
          threadId,
          input: [
            { type: "text", text },
            ...images.map((image) => ({ type: "image", url: imageUrl(image) })),
          ],
        });
        const response = yield* Schema.decodeUnknownEffect(Started)(result).pipe(
          Effect.mapError(
            () => new AgentError({ code: "protocol", message: "invalid turn/start reply" }),
          ),
        );
        if (!this.completed.has(response.turn.id)) {
          this.activeCodex = response.turn.id;
          this.activeDo = turn;
        }
      }
      return { req };
    }) satisfies Effect.Effect<Delivered, AgentError>;
  }
  interrupt(_req: string) {
    return Effect.gen({ self: this }, function* () {
      if (this.rpc === undefined || this.thread === undefined || this.activeCodex === undefined)
        return yield* new AgentError({ code: "no_turn", message: "no active turn" });
      yield* this.rpc.request("turn/interrupt", {
        threadId: this.thread,
        turnId: this.activeCodex,
      });
    }) satisfies Effect.Effect<void, AgentError>;
  }
}
