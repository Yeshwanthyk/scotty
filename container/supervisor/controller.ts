import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Scope, Stream } from "effect";
import { Actions } from "./actions.js";
import { threadGone, type ToSupervisorMessage } from "../../protocol/supervisor.js";
import { type Agent, makeAgent } from "./agents/agent.js";
import { Requests } from "./requests.js";
import { AgentError, type AgentReady, type Runner } from "./runner.js";
import { keepsDisk, session } from "./place.js";
import type { Output } from "./wire.js";
import {
  hasState,
  installSettings,
  installStyle,
  prepareWorkspace,
  readMarker,
  saveWorkspace,
  storeSave,
  storeSkills,
  tunnelBase,
  WorkspaceError,
  writeMarker,
} from "./workspace.js";

type Start = Extract<ToSupervisorMessage, { type: "start" }>;
type Ready = Omit<Extract<Output, { type: "workspace_ready" }>, "type"> & AgentReady;
type StartState =
  | { status: "inflight" }
  | { status: "ready"; ready: Ready }
  | { status: "failed"; code: string; message: string };
type Sender = (output: Output, gen?: number) => void;

const shutdownBudget = "25 seconds";

export class Controller {
  private send: Sender = () => {};
  private gen: number | undefined;
  private startState: StartState | undefined;
  private agent: Agent | undefined;
  private runner: Runner | undefined;
  private actions: Actions | undefined;
  private scope: Scope.Closeable | undefined;
  private readonly requests = new Requests();
  bind(send: Sender) {
    this.send = send;
  }

  private start(message: Start) {
    return Effect.gen({ self: this }, function* () {
      if (this.startState !== undefined) {
        if (this.startState.status === "ready") {
          const ready = this.startState.ready;
          this.send(
            {
              type: "workspace_ready",
              base: ready.base,
              branch: ready.branch,
              commit: ready.commit,
              ms: ready.ms,
              retried: ready.retried,
            },
            message.gen,
          );
          this.send({ type: "agent_ready", kind: ready.kind, session: ready.session }, message.gen);
        } else if (this.startState.status === "failed")
          this.send(
            { type: "error", code: this.startState.code, message: this.startState.message },
            message.gen,
          );
        return;
      }
      this.gen = message.gen;
      this.startState = { status: "inflight" };
      const tunnel = message.tunnel === true;
      const agent = makeAgent(
        tunnel
          ? {
              ...message.agent,
              mcp: message.agent.mcp?.map((server) => ({
                ...server,
                url: server.url.replace(/^http:\/\//, `${tunnelBase}/`),
              })),
            }
          : message.agent,
      );
      this.agent = agent;
      const outcome = yield* Effect.gen({ self: this }, function* () {
        const marker = message.resume === undefined ? undefined : yield* readMarker;
        const disk =
          marker !== undefined &&
          keepsDisk() &&
          marker.session === session() &&
          marker.branch === message.branch
            ? marker
            : undefined;
        const workspace = yield* prepareWorkspace(
          message.repo,
          message.base,
          message.branch,
          message.git,
          agent,
          message.resume,
          disk,
          tunnel,
        );
        const gone = (detail: string) =>
          new AgentError({ code: threadGone, message: `can't resume the thread: ${detail}` });
        if (
          disk !== undefined &&
          message.resume !== undefined &&
          !(yield* hasState(agent, message.resume.threadId))
        )
          return yield* gone("its state file is not on the disk");
        yield* installSettings(agent, message.instructions, message.skills);
        yield* installStyle(
          agent,
          message.agent.kind === "claude" ? message.agent.style : undefined,
        );
        this.send({ type: "workspace_prepared" }, message.gen);
        const scope = yield* Scope.make();
        this.scope = scope;
        const runner = yield* agent.runner(workspace.dir);
        this.runner = runner;
        const actions = yield* Actions.make();
        this.actions = actions;
        yield* actions.drain.pipe(Effect.forkScoped, Scope.provide(scope));
        yield* runner.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => this.send(event, message.gen))),
          Effect.forkScoped,
          Scope.provide(scope),
        );
        const ready = yield* runner
          .start(
            { SCOTTY_HATCH: message.hatch, ...(tunnel ? { SCOTTY_TUNNEL: tunnelBase } : {}) },
            message.resume?.threadId,
          )
          .pipe(
            Effect.mapError((error) =>
              disk !== undefined && error.unresumable === true ? gone(error.message) : error,
            ),
            Scope.provide(scope),
          );
        if (keepsDisk())
          yield* writeMarker({
            session: session(),
            branch: message.branch,
            base: workspace.commit,
            thread: ready.session,
          });
        return {
          base: message.base,
          branch: message.branch,
          commit: workspace.commit,
          ms: workspace.ms,
          retried: workspace.retried,
          kind: ready.kind,
          session: ready.session,
        };
      }).pipe(Effect.provide(BunServices.layer), Effect.exit);
      if (Exit.isFailure(outcome)) {
        const error = outcome.cause;
        const mapped = yield* Effect.failCause(error).pipe(
          Effect.catchTag("WorkspaceError", (failure) =>
            Effect.succeed({ code: "workspace", message: failure.message }),
          ),
          Effect.catchTag("AgentError", (failure) =>
            Effect.succeed({ code: failure.code, message: failure.message }),
          ),
          Effect.catchCause(() =>
            Effect.succeed({ code: "start", message: "agent startup failed" }),
          ),
        );
        this.startState = { status: "failed", ...mapped };
        this.send({ type: "error", ...mapped }, message.gen);
        if (this.scope !== undefined) yield* Scope.close(this.scope, Exit.void);
        this.runner = undefined;
        this.actions = undefined;
        this.scope = undefined;
        return;
      }
      this.startState = { status: "ready", ready: outcome.value };
      this.send(
        {
          type: "workspace_ready",
          base: outcome.value.base,
          branch: outcome.value.branch,
          commit: outcome.value.commit,
          ms: outcome.value.ms,
          retried: outcome.value.retried,
        },
        message.gen,
      );
      this.send(
        { type: "agent_ready", kind: outcome.value.kind, session: outcome.value.session },
        message.gen,
      );
    }) satisfies Effect.Effect<void>;
  }

  shutdown() {
    return Effect.gen({ self: this }, function* () {
      const runner = this.runner;
      const actions = this.actions;
      if (runner !== undefined && actions !== undefined)
        yield* actions.run(runner.interrupt("shutdown")).pipe(Effect.ignore);
      if (this.scope !== undefined) yield* Scope.close(this.scope, Exit.void);
    }).pipe(Effect.timeout(shutdownBudget), Effect.ignore) satisfies Effect.Effect<void>;
  }

  private request(req: string, action: Effect.Effect<void, AgentError>, gen: number) {
    return this.requests.run(req, action).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.sync(() =>
            this.send({ type: "error", req, code: error.code, message: error.message }, gen),
          ),
        onSuccess: () => Effect.sync(() => this.send({ type: "delivered", req }, gen)),
      }),
    ) satisfies Effect.Effect<void>;
  }
  save(gen: number) {
    const state = this.startState;
    if (state?.status !== "ready" || this.agent === undefined || this.gen !== gen)
      return Effect.fail(
        new WorkspaceError({ message: "workspace not ready" }),
      ) satisfies Effect.Effect<Uint8Array, WorkspaceError>;
    return saveWorkspace(state.ready.commit, this.agent, state.ready.session).pipe(
      Effect.provide(BunServices.layer),
    ) satisfies Effect.Effect<Uint8Array, WorkspaceError>;
  }
  load(tar: Uint8Array) {
    return (
      this.startState === undefined
        ? storeSave(tar).pipe(Effect.provide(BunServices.layer))
        : Effect.fail(new WorkspaceError({ message: "workspace already started" }))
    ) satisfies Effect.Effect<void, WorkspaceError>;
  }
  skills(commit: string, tarball: Uint8Array) {
    return (
      this.startState === undefined
        ? storeSkills(commit, tarball).pipe(Effect.provide(BunServices.layer))
        : Effect.void
    ) satisfies Effect.Effect<void, WorkspaceError>;
  }
  receive(message: ToSupervisorMessage) {
    if (message.type === "start") return this.start(message) satisfies Effect.Effect<void>;
    if (message.type === "ack") return Effect.void satisfies Effect.Effect<void>;
    const req = message.req;
    if (this.runner === undefined || this.actions === undefined || this.gen !== message.gen) {
      const code = "not_ready";
      return Effect.sync(() =>
        this.send({ type: "error", req, code, message: code }, message.gen),
      ) satisfies Effect.Effect<void>;
    }
    return (
      message.type === "prompt"
        ? this.request(
            req,
            this.actions.run(
              this.runner
                .send(req, message.turn, message.text, message.images ?? [])
                .pipe(Effect.asVoid),
            ),
            message.gen,
          )
        : this.request(req, this.actions.run(this.runner.interrupt(req)), message.gen)
    ) satisfies Effect.Effect<void>;
  }
}
