import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Scope, Stream } from "effect";
import { Actions } from "./actions.js";
import type { ToSupervisorMessage } from "../../protocol/supervisor.js";
import { makeRunner } from "./agent.js";
import { Requests } from "./requests.js";
import { AgentError, type Runner } from "./runner.js";
import type { Output } from "./wire.js";
import { prepareWorkspace, saveWorkspace, storeSave, WorkspaceError } from "./workspace.js";

type Start = Extract<ToSupervisorMessage, { type: "start" }>;
type Ready = { base: string; branch: string; commit: string; kind: "codex"; session: string };
type StartState =
  | { status: "inflight" }
  | { status: "ready"; ready: Ready }
  | { status: "failed"; code: string; message: string };
type Sender = (output: Output, gen?: number) => void;

// One container controller owns start/runner/request outcomes for its fixed gen.
// State changes precede outside work; resends observe the same in-flight result.
export class Controller {
  private send: Sender = () => {};
  private gen: number | undefined;
  private startState: StartState | undefined;
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
      const outcome = yield* Effect.gen({ self: this }, function* () {
        const workspace = yield* prepareWorkspace(
          message.repo,
          message.base,
          message.branch,
          message.git,
          message.resume,
        );
        const scope = yield* Scope.make();
        this.scope = scope;
        const runner = yield* makeRunner(message.agent, workspace.dir);
        this.runner = runner;
        const actions = yield* Actions.make();
        this.actions = actions;
        yield* actions.drain.pipe(Effect.forkScoped, Scope.provide(scope));
        yield* runner.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => this.send(event, message.gen))),
          Effect.forkScoped,
          Scope.provide(scope),
        );
        const agent = yield* runner.start(message.resume?.threadId).pipe(Scope.provide(scope));
        return {
          base: message.base,
          branch: message.branch,
          commit: workspace.commit,
          kind: agent.kind,
          session: agent.session,
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
        },
        message.gen,
      );
      this.send(
        { type: "agent_ready", kind: outcome.value.kind, session: outcome.value.session },
        message.gen,
      );
    });
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
    if (state?.status !== "ready" || this.gen !== gen)
      return Effect.fail(new WorkspaceError({ message: "workspace not ready" }));
    return saveWorkspace(state.ready.commit, state.ready.session).pipe(
      Effect.provide(BunServices.layer),
    );
  }
  load(tar: Uint8Array): Effect.Effect<void, WorkspaceError> {
    return this.startState === undefined
      ? storeSave(tar).pipe(Effect.provide(BunServices.layer))
      : Effect.fail(new WorkspaceError({ message: "workspace already started" }));
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
