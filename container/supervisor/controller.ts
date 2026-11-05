import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Scope, Stream } from "effect";
import { Actions } from "./actions.js";
import { threadGone, type ToSupervisorMessage } from "../../protocol/supervisor.js";
import { type Agent, makeAgent } from "./agents/agent.js";
import { Requests } from "./requests.js";
import { AgentError, type AgentReady, type Runner } from "./runner.js";
import { processEnv } from "./runtime.js";
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

// The session this container belongs to, given by a place that keeps its disk. Cloudflare gives
// none, so there it writes no marker and every hello stays as it was.
const session = () => processEnv("SCOTTY_SESSION");
// A runner stops with a 30 s grace; the agent gets most of it to end its turn and exit.
const shutdownBudget = "25 seconds";

// One container controller owns start/runner/request outcomes for its fixed gen.
// State changes precede outside work; resends observe the same in-flight result.
export class Controller {
  private send: Sender = () => {};
  private gen: number | undefined;
  private startState: StartState | undefined;
  private agent: Agent | undefined;
  private runner: Runner | undefined;
  private actions: Actions | undefined;
  private scope: Scope.Closeable | undefined;
  private readonly requests = new Requests();
  bind(send: Sender): void {
    this.send = send;
  }

  private start(message: Start): Effect.Effect<void> {
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
      const agent = makeAgent(message.agent);
      this.agent = agent;
      const outcome = yield* Effect.gen({ self: this }, function* () {
        const marker = message.resume === undefined ? undefined : yield* readMarker;
        const disk =
          marker !== undefined &&
          session() !== "" &&
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
          message.egress,
        );
        // A thread the agent can't pick up from the disk is the place's to replace, not a failed
        // start: the Session DO restores from the save in a new machine.
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
          .start({ SCOTTY_HATCH: message.hatch }, message.resume?.threadId)
          .pipe(
            Effect.mapError((error) =>
              disk === undefined || error.code === "spawn" || error.code === "config"
                ? error
                : gone(error.message),
            ),
            Scope.provide(scope),
          );
        if (session() !== "")
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
    });
  }

  // On SIGTERM the agent ends its turn and exits before the place's grace runs out, so the
  // thread file on the disk is closed.
  shutdown(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const runner = this.runner;
      const actions = this.actions;
      if (runner !== undefined && actions !== undefined)
        yield* actions.run(runner.interrupt("shutdown")).pipe(Effect.ignore);
      if (this.scope !== undefined) yield* Scope.close(this.scope, Exit.void);
    }).pipe(Effect.timeout(shutdownBudget), Effect.ignore);
  }

  private request(
    req: string,
    action: Effect.Effect<void, AgentError>,
    gen: number,
  ): Effect.Effect<void> {
    return this.requests.run(req, action).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.sync(() =>
            this.send({ type: "error", req, code: error.code, message: error.message }, gen),
          ),
        onSuccess: () => Effect.sync(() => this.send({ type: "delivered", req }, gen)),
      }),
    );
  }
  save(gen: number): Effect.Effect<Uint8Array, WorkspaceError> {
    const state = this.startState;
    if (state?.status !== "ready" || this.agent === undefined || this.gen !== gen)
      return Effect.fail(new WorkspaceError({ message: "workspace not ready" }));
    return saveWorkspace(state.ready.commit, this.agent, state.ready.session).pipe(
      Effect.provide(BunServices.layer),
    );
  }
  load(tar: Uint8Array): Effect.Effect<void, WorkspaceError> {
    return this.startState === undefined
      ? storeSave(tar).pipe(Effect.provide(BunServices.layer))
      : Effect.fail(new WorkspaceError({ message: "workspace already started" }));
  }
  // A start sent again after a reconnect finds the skills already installed.
  skills(commit: string, tarball: Uint8Array): Effect.Effect<void, WorkspaceError> {
    return this.startState === undefined
      ? storeSkills(commit, tarball).pipe(Effect.provide(BunServices.layer))
      : Effect.void;
  }
  receive(message: ToSupervisorMessage): Effect.Effect<void> {
    if (message.type === "start") return this.start(message);
    if (message.type === "ack") return Effect.void;
    const req = message.req;
    if (this.runner === undefined || this.actions === undefined || this.gen !== message.gen) {
      const code = "not_ready";
      return Effect.sync(() => this.send({ type: "error", req, code, message: code }, message.gen));
    }
    return message.type === "prompt"
      ? this.request(
          req,
          this.actions.run(this.runner.send(req, message.turn, message.text).pipe(Effect.asVoid)),
          message.gen,
        )
      : this.request(req, this.actions.run(this.runner.interrupt(req)), message.gen);
  }
}
