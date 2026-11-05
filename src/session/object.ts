import { cloudflarePlace } from "../places/cloudflare.js";
import {
  defaultPlace,
  type Exit as MachineExit,
  type Place,
  type PlaceKind,
  type Size,
} from "../places/place.js";
import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Cause,
  Config,
  Duration,
  Effect,
  Exit,
  FiberHandle,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  supervisorAuthHeader,
  Terminals,
  type AgentConfig,
  type ToSupervisorMessage,
} from "../../protocol/supervisor.js";
import CredsObject from "../creds/object.js";
import { type ConnectionMetadata, internalUrl } from "../creds/connections.js";
import * as claude from "./agents/claude.js";
import * as codex from "./agents/codex.js";
import {
  AgentSettings,
  defaultClaudeSettings,
  defaultCodexSettings,
} from "./agents/agent-settings.js";
import type { AgentKind, Origin } from "./events.js";
import { instructionsKey, sourceKey } from "../settings/skills.js";
import type { Command } from "./commands.js";
import { bindSessionContainer } from "./container-binding.js";
import { deadlines, idleWindow } from "./deadlines.js";
import { deadline, resizeConflict, startStep } from "./fold.js";
import { openLog, type Draft } from "./log.js";
import { live } from "./state.js";
import { sessionStats } from "./stats.js";
import { SupervisorLink, type SocketInput } from "./supervisor-link.js";
import { callerProof, hex, sessionKey } from "./supervisor-auth.js";
import { supervisorEvent } from "./supervisor-events.js";
import { conversationView, sessionView, turnOutcome } from "./view.js";

const scriptedStart = (
  kind: typeof AgentKind.Type,
): [typeof AgentConfig.Type, { name: string; email: string }] => [
  kind === "codex"
    ? { kind: "codex", scripted: true, model: "scripted" }
    : { kind: "claude", scripted: true, model: "scripted" },
  { name: "Scotty e2e", email: "e2e@scotty.invalid" },
];

export class SessionContainer extends Cloudflare.Container<SessionContainer>()(
  "SessionContainer",
  // deploy/deployer.ts makes the app; each start names its image and size
  // (src/places/cloudflare.ts), so the declaration holds no image.
  Effect.map(Stack, ({ stage }) => ({
    name: `scotty-${stage}-sessions`,
    schedulingPolicy: "durable_object" as const,
  })),
) {}

export const SessionArtifacts = Cloudflare.R2.Bucket(
  "SessionArtifacts",
  // Teardown removes the stage with its files; nothing in it outlives the stage.
  Effect.map(Stack, ({ stage }) => ({ name: `scotty-${stage}-artifacts`, forceDestroy: true })),
);

// The deployer sets SCOTTY_MAX_RUNNING from the stage's maxRunning. It is read from the raw env:
// Alchemy's Config inside a DO JSON-parses "2" into a number, which Config.Int then refuses.
const MaxRunning = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
// The deployer makes SCOTTY_SUPERVISOR_SECRET once per stage, as a Worker secret; read raw for
// the same reason.
const SupervisorSecret = Schema.String.check(Schema.isMinLength(32));
// The supervisor was unreachable, or answered `path` with a non-2xx `status`.
class SupervisorFailure extends Schema.TaggedError<SupervisorFailure>()("SupervisorFailure", {
  path: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

// Live snapshots replay the log, so a burst of events shares one.
const pushEvery = Duration.millis(250);

export default class SessionObject extends Cloudflare.DurableObject<SessionObject>()(
  "SessionObject",
  Effect.gen(function* () {
    const storage = yield* Cloudflare.DurableObjectState;
    const credentials = yield* CredsObject;
    // This class's own namespace, to ask another session whether it still runs.
    const sessions = yield* Cloudflare.DurableObjectScope;
    const env = yield* Cloudflare.WorkerEnvironment;
    yield* bindSessionContainer(SessionContainer);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(SessionArtifacts);
    return Effect.gen(function* () {
      const rawMax: unknown = env["SCOTTY_MAX_RUNNING"];
      const max = yield* Schema.decodeUnknownEffect(MaxRunning)(rawMax);
      const rawSecret: unknown = env["SCOTTY_SUPERVISOR_SECRET"];
      const secret = yield* Schema.decodeUnknownEffect(SupervisorSecret)(rawSecret);
      // The container handle exists only at run time.
      const container = storage.container;
      if (container === undefined) return yield* Effect.die("Session container binding missing");
      const log = yield* openLog(storage);
      const id = () => log.state.created?.branch.slice("scotty/".length) ?? "";
      const context = yield* Effect.context<RuntimeContext | Cloudflare.DurableObjectState>();

      const places = {
        cloudflare: cloudflarePlace(container, storage.raw.exports),
      } satisfies Record<typeof PlaceKind.Type, Place>;
      // Logs written before `created.place` ran on Cloudflare.
      const where = () => places[log.state.created?.place ?? defaultPlace];
      // The session's machine at its place; logs written before places kept handles have none.
      class NoMachine extends Schema.TaggedError<NoMachine>()("NoMachine", {}) {}
      const port = (n: number) =>
        Effect.gen(function* () {
          const handle = log.state.place?.handle;
          if (handle === undefined) return yield* new NoMachine();
          return where().port(handle, n);
        });
      // k for this session, given to its machine at create; the proof for a generation is kept
      // per instance. Neither is logged or stored.
      let key: { session: string; bytes: Uint8Array<ArrayBuffer> } | undefined;
      const keyBytes = Effect.gen(function* () {
        if (key?.session === id()) return key.bytes;
        const session = id();
        const bytes = yield* Effect.promise(() => sessionKey(secret, session));
        key = { session, bytes };
        return bytes;
      });
      let proof: { session: string; gen: number; value: string } | undefined;
      const auth = (gen: number) =>
        Effect.gen(function* () {
          if (proof?.session === id() && proof.gen === gen)
            return { [supervisorAuthHeader]: proof.value };
          const bytes = yield* keyBytes;
          const value = yield* Effect.promise(() => callerProof(bytes, gen));
          proof = { session: id(), gen, value };
          return { [supervisorAuthHeader]: value };
        });
      // Live sockets get a fresh snapshot after appends, at most one per `pushEvery`; the owner's
      // Creds DO hears when the list-visible view changes. Neither is state: a lost push is
      // repaired by the next one, or by the snapshot a reconnect gets.
      let pushQueued = false;
      let listed = "";
      const snapshot = () =>
        JSON.stringify({
          kind: "snapshot",
          seq: log.state.lastSeq,
          session: sessionView(id(), log.state),
          conversation: conversationView(log.state, log.history),
        });
      const push = Effect.gen(function* () {
        pushQueued = false;
        const sockets = yield* storage.getWebSockets();
        const frame = sockets.length > 0 ? snapshot() : "";
        for (const socket of sockets) yield* socket.send(frame).pipe(Effect.ignoreCause);
        if (log.state.created === undefined) return;
        const view = sessionView(id(), log.state);
        const serialized = JSON.stringify(view);
        if (serialized === listed) return;
        yield* credentials.getByName("owner").sessionChanged(view);
        // Only a delivered view counts; a failed one is sent again with the next push.
        listed = serialized;
      }).pipe(Effect.ignoreCause);
      const changed = Effect.gen(function* () {
        if (pushQueued) return;
        pushQueued = true;
        yield* storage.waitUntil(Effect.sleep(pushEvery).pipe(Effect.andThen(push)));
      });
      const append = (draft: Draft, src: string) =>
        log.append(draft, src).pipe(Effect.tap(() => changed));
      const saveKey = () => `saves/${id()}.tar`;
      const supervisor = (gen: number, path: string, init?: { method: "PUT"; body: ArrayBuffer }) =>
        Effect.gen(function* () {
          const target = yield* port(7000);
          const headers = yield* auth(gen);
          return yield* Effect.tryPromise({
            try: () => target.fetch(`http://container${path}`, { ...init, headers }),
            catch: () => new SupervisorFailure({ path }),
          });
        }).pipe(
          Effect.catchTag("NoMachine", () => Effect.fail(new SupervisorFailure({ path }))),
          Effect.flatMap((response) =>
            response.ok
              ? Effect.succeed(response)
              : Effect.fail(new SupervisorFailure({ path, status: response.status })),
          ),
        );

      let link: SupervisorLink;
      // Work queued for an older generation, or for a session that has ended, does nothing.
      const current = (gen: number) => log.state.gen === gen && live(log.state);
      // Share one snapshot between container egress and agent MCP config for this generation.
      // After DO hibernation, the start command reads again if this instance has no snapshot.
      let startConnections: { gen: number; items: readonly ConnectionMetadata[] } | undefined;
      const connectionsFor = (gen: number) =>
        Effect.gen(function* () {
          if (startConnections?.gen === gen) return startConnections.items;
          const items = yield* credentials.getByName("owner").connections();
          startConnections = { gen, items };
          return items;
        });
      // Place work runs after the caller returns, one operation at a time, so a wake waits for
      // the stop's pause. Its outcome arrives as a later event.
      const lifecycle = yield* Semaphore.make(1);
      // When the owner last reached the container through the terminal or a preview. Kept in
      // memory only: a request keeps the Session DO resident until the idle alarm reads it.
      let used = 0;
      const outside = new Set<Command["kind"]>([
        "create",
        "resume",
        "connect",
        "pause",
        "remove",
        "release",
        "check",
        "discard",
        "dial",
        "start",
        "watch",
        "idle",
      ]);
      // Awaits the running container's exit, so a crash or exit is recorded when it happens,
      // not when someone next looks. One watcher at a time; a new one replaces the last.
      // Nothing closes the isolate's scope, so the handle gets a scope of its own that goes away
      // with this instance instead of adding a finalizer per activation.
      const watcher = yield* FiberHandle.make<void, never>().pipe(
        Scope.provide(yield* Scope.make()),
      );
      // Records how the watched machine ended, unless the generation has moved on. A lost watch
      // says nothing about the machine; the watch deadline asks the place again.
      const exited = (gen: number, waiting: Effect.Effect<MachineExit>) =>
        waiting.pipe(
          Effect.flatMap((exit) =>
            exit.reason === "lost"
              ? Effect.logWarning("container watch lost")
              : current(gen)
                ? append({ kind: "container.stopped", gen, ...exit }, "session").pipe(
                    Effect.flatMap(dispatch),
                  )
                : Effect.void,
          ),
          // Nothing joins the watcher, so a failure to record the exit is logged here. A newer
          // watcher interrupting this one is not a failure.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("recording container exit failed", cause),
          ),
          Effect.provide(context),
        );
      // Called once the supervisor answers, when the machine surely exists. Where the place
      // reports exits, one watcher at a time awaits it; elsewhere the watch deadline asks.
      const watch = (gen: number) =>
        Effect.gen(function* () {
          const handle = log.state.place?.handle;
          if (!current(gen) || handle === undefined) return;
          const watching = where().watch;
          if (watching !== undefined)
            yield* FiberHandle.run(watcher, exited(gen, yield* watching(handle)));
          yield* append({ kind: "container.watched", gen }, "session");
          // A failed watch is not a failed dial; the next dial or watch deadline tries again.
        }).pipe(Effect.ignoreCause({ log: "Error", message: "watch failed" }));
      // The running slot, claimed by every create and resume. A full cap first drops the claims of
      // sessions that no longer run, so a lost release can't hold a slot; a session that doesn't
      // answer keeps its claim. Refused, the session stops with reason cap.
      const claimSlot = (gen: number) =>
        Effect.gen(function* () {
          const owner = credentials.getByName("owner");
          let claim = yield* owner.claim(id(), max);
          if (!claim.granted) {
            const stale = yield* Effect.filter(
              claim.claims,
              (held) =>
                sessions
                  .getByName(held.id)
                  .fetch(HttpServerRequest.fromWeb(new Request("http://session/running")))
                  .pipe(
                    Effect.map((response) => response.status === 410),
                    Effect.orElseSucceed(() => false),
                  ),
              { concurrency: "unbounded" },
            );
            if (stale.length > 0) {
              yield* owner.dropClaims(stale);
              claim = yield* owner.claim(id(), max);
            }
          }
          if (!claim.granted && current(gen))
            yield* dispatch(
              yield* append({ kind: "container.stopped", gen, reason: "cap", max }, "session"),
            );
          return claim.granted;
        });
      // A new machine takes a moment to listen, longer on a new host; retry until the fold's
      // container deadline before reporting dial.failed.
      const reach = (gen: number) =>
        Effect.gen(function* () {
          const headers = yield* auth(gen);
          const target = yield* port(7000);
          yield* link
            .dial(
              () => target,
              gen,
              0,
              headers,
              () => current(gen),
            )
            .pipe(
              Effect.timeout("10 seconds"),
              Effect.retry({
                schedule: Schedule.spaced("500 millis").pipe(
                  Schedule.upTo({ duration: Duration.millis(deadlines.container) }),
                ),
                // Not the place's status: it can still read not running just after a create.
                while: () => current(gen),
              }),
            );
          yield* watch(gen);
        });
      const release = Effect.suspend(() => credentials.getByName("owner").release(id())).pipe(
        Effect.ignoreCause,
      );
      // The place's answer about a machine, as the event that records it.
      const answered = (handle: string, answer: "paused" | "gone") =>
        append(
          { kind: answer === "paused" ? "place.paused" : "place.gone", handle },
          "session",
        ).pipe(Effect.flatMap(dispatch));
      // Read through a call: the log changes under every yield.
      const machine = () => log.state.place;
      // A machine its place says is gone: recorded, then the generation stops, unless it moved on.
      const gone = (gen: number, handle: string | undefined) =>
        Effect.gen(function* () {
          if (handle !== undefined) yield* answered(handle, "gone");
          if (current(gen))
            yield* dispatch(
              yield* append({ kind: "container.stopped", gen, reason: "gone" }, "session"),
            );
        });
      const pausing = (handle: string) =>
        log.state.place?.handle === handle && log.state.place.status === "pausing";
      const dispatch = (action: Command | undefined): Effect.Effect<void, never, RuntimeContext> =>
        action !== undefined && outside.has(action.kind)
          ? storage.waitUntil(lifecycle.withPermit(perform(action)))
          : perform(action);
      const perform = (action: Command | undefined): Effect.Effect<void, never, RuntimeContext> =>
        Effect.gen(function* () {
          if (!action) return;
          switch (action.kind) {
            case "create": {
              if (!current(action.gen) || log.state.place !== undefined) return;
              // A handle let go is removed first; a failed remove doesn't hold up the create.
              if (action.remove !== undefined)
                yield* where()
                  .remove(action.remove)
                  .pipe(Effect.ignoreCause({ log: "Warn", message: "remove failed" }));
              if (!(yield* claimSlot(action.gen))) return;
              const connections = (yield* connectionsFor(action.gen))
                .filter((connection) => connection.kind !== "inbound")
                .map((connection) => connection.name);
              const handle = yield* where().create({
                session: id(),
                gen: action.gen,
                repo: log.state.created?.repo ?? "",
                size: log.state.size,
                connections,
                key: hex(yield* keyBytes),
              });
              yield* dispatch(
                yield* append({ kind: "place.created", gen: action.gen, handle }, "session"),
              );
              if (!current(action.gen) || machine()?.handle !== handle) return;
              yield* reach(action.gen);
              return;
            }
            case "resume": {
              const place = log.state.place;
              if (
                !current(action.gen) ||
                place?.handle !== action.handle ||
                place.status !== "live"
              )
                return;
              if (!(yield* claimSlot(action.gen))) return;
              const answer = yield* where().resume(action.handle);
              if (answer === "gone") return yield* answered(action.handle, "gone");
              if (current(action.gen)) yield* reach(action.gen);
              return;
            }
            case "connect":
              if (current(action.gen)) yield* reach(action.gen);
              return;
            // Every stop gives the running slot back, even when the place call fails.
            case "pause":
              yield* Effect.ensuring(
                Effect.gen(function* () {
                  if (!pausing(action.handle)) return;
                  yield* answered(action.handle, yield* where().pause(action.handle));
                }),
                release,
              );
              return;
            case "remove":
              yield* Effect.ensuring(where().remove(action.handle), release);
              return;
            case "release":
              yield* release;
              return;
            // An unanswered pause: a machine still running is paused again.
            case "check": {
              if (!pausing(action.handle)) return;
              const status = yield* where().status(action.handle);
              const answer = status === "running" ? yield* where().pause(action.handle) : status;
              if (pausing(action.handle)) yield* answered(action.handle, answer);
              return;
            }
            case "discard":
              yield* where().remove(action.handle);
              return;
            case "dial": {
              // A dial queued behind the start may find the socket already connected.
              if (!current(action.gen) || log.state.connected) return;
              const headers = yield* auth(action.gen);
              const target = yield* port(7000);
              yield* link
                .dial(
                  () => target,
                  action.gen,
                  action.after,
                  headers,
                  () => current(action.gen),
                )
                .pipe(Effect.timeout("10 seconds"));
              yield* watch(action.gen);
              return;
            }
            case "start": {
              if (!current(action.gen)) return;
              // Sent over the socket only; never appended to the event log.
              const owner = credentials.getByName("owner");
              const agentConfig = {
                codex: (settings: typeof AgentSettings.Type) =>
                  owner
                    .sessionToken()
                    .pipe(Effect.map((chatgpt) => codex.startConfig(chatgpt, settings))),
                claude: (settings: typeof AgentSettings.Type) =>
                  owner
                    .claudeToken()
                    .pipe(Effect.map((token) => claude.startConfig(token, settings))),
              } satisfies Record<typeof AgentKind.Type, unknown>;
              // The stage's model and effort for this agent, from the Worker's plain vars.
              const stage = {
                codex: {
                  model: "SCOTTY_CODEX_MODEL",
                  effort: "SCOTTY_CODEX_EFFORT",
                  fallback: defaultCodexSettings,
                },
                claude: {
                  model: "SCOTTY_CLAUDE_MODEL",
                  effort: "SCOTTY_CLAUDE_EFFORT",
                  fallback: defaultClaudeSettings,
                },
              }[action.agentKind];
              const settings = yield* Schema.decodeUnknownEffect(AgentSettings)({
                model: yield* Config.String(stage.model).pipe(
                  Config.withDefault(stage.fallback.model),
                ),
                effort: yield* Config.String(stage.effort).pipe(
                  Config.withDefault(stage.fallback.effort),
                ),
              });
              // The scripted stand-in needs no account, so e2e runs without the owner's sign-ins.
              const signedIn = yield* Effect.exit(
                action.scripted === true
                  ? Effect.succeed(scriptedStart(action.agentKind))
                  : Effect.all([agentConfig[action.agentKind](settings), owner.gitIdentity()], {
                      concurrency: "unbounded",
                    }),
              );
              if (Exit.isFailure(signedIn)) {
                if (current(action.gen))
                  yield* dispatch(
                    yield* append(
                      {
                        kind: "failed",
                        phase: "credentials",
                        code: "signin_required",
                        retryable: true,
                      },
                      "session",
                    ),
                  );
                return;
              }
              const [configured, git] = signedIn.value;
              const [connections, skills] = yield* Effect.all(
                [connectionsFor(action.gen), credentials.getByName("owner").sessionSkills()],
                { concurrency: "unbounded" },
              );
              const mcp = connections
                .filter((connection) => connection.kind === "mcp")
                .map((connection) => ({
                  name: connection.name,
                  url: internalUrl(connection.name, "mcp"),
                }));
              const agent = {
                ...configured,
                mcp,
                skillsOff: skills.off,
                ...(configured.kind === "claude" && skills.style !== undefined
                  ? { style: skills.style }
                  : {}),
              };
              // The deployer always sets SCOTTY_HATCH_BASE to the stage's domain.
              const hatchBase = yield* Effect.orDie(Config.String("SCOTTY_HATCH_BASE"));
              // A machine that kept the session's disk resumes from it. Otherwise resume only when
              // the save reached the new machine, and start clean when it didn't.
              // The save, the instructions and the skills are independent uploads to separate
              // files, so they go together. Skills go one at a time to bound the DO's memory:
              // each tarball is held whole while it uploads.
              const restore =
                action.resume === undefined
                  ? Effect.succeed(false)
                  : action.fromDisk === true
                    ? Effect.succeed(true)
                    : bucket.get(saveKey()).pipe(
                        Effect.flatMap((saved) =>
                          saved === null
                            ? Effect.succeed(false)
                            : saved.arrayBuffer().pipe(
                                Effect.flatMap((body) =>
                                  supervisor(action.gen, `/save?gen=${action.gen}`, {
                                    method: "PUT",
                                    body,
                                  }),
                                ),
                                Effect.as(true),
                              ),
                        ),
                        Effect.orElseSucceed(() => false),
                      );
              // Settings as they are now; a running session keeps what it started with.
              // A failed read fails the start (start_failed, retryable) rather than drop a setting.
              const readInstructions = Effect.orDie(
                bucket
                  .get(instructionsKey)
                  .pipe(
                    Effect.flatMap((saved) => (saved === null ? Effect.succeed("") : saved.text())),
                  ),
              );
              const install = Effect.forEach(skills.sources, (source) =>
                bucket.get(sourceKey(source.repo, source.commit)).pipe(
                  Effect.flatMap((tarball) =>
                    tarball === null
                      ? Effect.succeed([])
                      : tarball.arrayBuffer().pipe(
                          Effect.flatMap((body) =>
                            supervisor(
                              action.gen,
                              `/skills?gen=${action.gen}&commit=${source.commit}`,
                              {
                                method: "PUT",
                                body,
                              },
                            ),
                          ),
                          Effect.as([{ commit: source.commit, path: source.path }]),
                        ),
                  ),
                  Effect.orDie,
                ),
              );
              const [restored, instructions, installed] = yield* Effect.all(
                [restore, readInstructions, install],
                { concurrency: "unbounded" },
              );
              const message: ToSupervisorMessage = {
                type: "start",
                gen: action.gen,
                n: 1,
                repo: action.repo,
                base: action.base,
                branch: action.branch,
                agent,
                git,
                hatch: `https://{port}-${id()}.${hatchBase}`,
                instructions,
                skills: installed.flat(),
                ...(restored && action.resume !== undefined ? { resume: action.resume } : {}),
              };
              if (current(action.gen)) link.send(message);
              return;
            }
            case "ack":
              link.send({ type: "ack", gen: action.gen, n: 1, ack: action.ack });
              return;
            case "resend":
              for (const resend of action.requests) {
                if (resend.kind === "prompt")
                  link.send({ type: "prompt", gen: action.gen, n: 1, ...resend });
                else link.send({ type: "interrupt", gen: action.gen, n: 1, req: resend.req });
              }
              return;
            case "prompt":
              if (log.state.gen !== undefined)
                link.send({ type: "prompt", gen: log.state.gen, n: 1, ...action });
              return;
            case "interrupt":
              if (log.state.gen !== undefined)
                link.send({ type: "interrupt", gen: log.state.gen, n: 1, req: action.req });
              return;
            case "save": {
              link.send({ type: "ack", gen: action.gen, n: 1, ack: action.ack });
              const turn = action.turn;
              // The tar can take seconds; the result arrives as a later event.
              yield* storage.waitUntil(
                supervisor(action.gen, `/save?gen=${action.gen}`).pipe(
                  Effect.flatMap((response) => Effect.tryPromise(() => response.arrayBuffer())),
                  Effect.flatMap((tar) => bucket.put(saveKey(), tar)),
                  Effect.matchEffect({
                    onSuccess: () => append({ kind: "save.done", turn }, "session"),
                    onFailure: () =>
                      append({ kind: "save.failed", turn, code: "save_failed" }, "session"),
                  }),
                ),
              );
              return;
            }
            case "idle": {
              if (!current(action.gen)) return;
              // An unanswered supervisor counts as no terminal: the session sleeps. The fold
              // ignores the stop if a prompt or use arrived meanwhile.
              const terminals = yield* supervisor(action.gen, "/terminals").pipe(
                Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
                Effect.flatMap(Schema.decodeUnknownEffect(Terminals)),
                Effect.map(({ open }) => open),
                Effect.timeout("5 seconds"),
                Effect.orElseSucceed(() => 0),
              );
              if (terminals > 0 || Date.now() - used < idleWindow(log.state)) {
                yield* append({ kind: "active" }, "session");
                return;
              }
              yield* dispatch(
                yield* append(
                  {
                    kind: "container.stopped",
                    gen: action.gen,
                    reason: "idle",
                    idleSeq: action.seq,
                  },
                  "session",
                ),
              );
              return;
            }
            case "watch": {
              const handle = log.state.place?.handle;
              if (!current(action.gen)) return;
              const status = handle === undefined ? "running" : yield* where().status(handle);
              if (status === "running") return yield* watch(action.gen);
              yield* gone(action.gen, status === "gone" ? handle : undefined);
              return;
            }
          }
        }).pipe(
          // A start that hangs (an R2 read, a supervisor PUT) must not hold the lifecycle permit.
          action?.kind === "start" ? Effect.timeout("30 seconds") : (effect) => effect,
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (action === undefined || !("gen" in action) || !current(action.gen)) return;
              // Error text only: R2, RPC, place and supervisor failures carry no credentials.
              if (action.kind === "start") yield* Effect.logError("start failed", cause);
              if (action.kind === "create" && log.state.place === undefined) {
                yield* Effect.logError("create failed", cause);
                yield* dispatch(
                  yield* append(
                    {
                      kind: "failed",
                      phase: "container",
                      code: "container_start",
                      retryable: true,
                    },
                    "session",
                  ),
                );
              } else if (
                action.kind === "create" ||
                action.kind === "resume" ||
                action.kind === "connect" ||
                action.kind === "dial"
              ) {
                // A dial that fails because the machine is gone is a stop, not a retry.
                const handle = log.state.place?.handle;
                const status =
                  handle === undefined
                    ? "gone"
                    : yield* where()
                        .status(handle)
                        .pipe(Effect.orElseSucceed(() => "running" as const));
                if (status === "gone") yield* gone(action.gen, handle);
                else
                  yield* dispatch(
                    yield* append({ kind: "dial.failed", gen: action.gen }, "session"),
                  );
              } else if (action.kind === "start") {
                yield* dispatch(
                  yield* append(
                    { kind: "failed", phase: "start", code: "start_failed", retryable: true },
                    "session",
                  ),
                );
              }
            }),
          ),
          Effect.orDie,
        );

      const onSocket = (input: SocketInput) =>
        Effect.gen(function* () {
          if (input.kind === "closed") {
            yield* dispatch(yield* append({ kind: "socket.closed", gen: input.gen }, "supervisor"));
            return;
          }
          const message = input.value;
          if (message.type === "ack") return;
          if (message.gen !== log.state.gen) return;
          const event = yield* supervisorEvent(message);
          if (event) yield* dispatch(yield* append(event, "supervisor"));
        });
      link = new SupervisorLink((input) =>
        onSocket(input).pipe(Effect.orDie, Effect.provide(context)),
      );
      if (
        log.state.gen !== undefined &&
        (log.state.phase === "provisioning" || log.state.phase === "running")
      ) {
        yield* dispatch(yield* append({ kind: "sup.redial", gen: log.state.gen }, "session"));
      }
      return {
        // Makes the session, or prompts it, or answers a request id it has already seen. The
        // Durable Object runs one call at a time, so concurrent callers with one id agree.
        // Without `create`, a session not yet made is left alone and answered "uncreated".
        start: (input: {
          req: string;
          prompt: string;
          repo: string;
          agentKind: typeof AgentKind.Type;
          // The size and place the request named. A creating start makes the session with them; a
          // retried create that names others is a conflict; a steer by session key ignores them.
          size?: typeof Size.Type;
          place?: typeof PlaceKind.Type;
          create?: {
            id: string;
            baseBranch: string;
            title: string;
            image: string;
            place: typeof PlaceKind.Type;
            // The repository's default, used when the request names no size.
            repoSize?: typeof Size.Type;
            scripted?: true;
            idleAfter?: number;
            origin?: Origin;
          };
        }) =>
          Effect.gen(function* () {
            const step = startStep(log.state, { ...input, agent: input.agentKind });
            const answer = (
              kind: "created" | "steered" | "duplicate" | "unavailable" | "conflict",
            ) => ({
              kind,
              session: sessionView(id(), log.state),
            });
            if (step === "create") {
              const create = input.create;
              if (create === undefined) return { kind: "uncreated" as const };
              const size = input.size ?? create.repoSize;
              yield* dispatch(
                yield* append(
                  {
                    kind: "created",
                    agentKind: input.agentKind,
                    branch: `scotty/${create.id}`,
                    repo: input.repo,
                    baseBranch: create.baseBranch,
                    title: create.title,
                    prompt: input.prompt,
                    req: input.req,
                    image: create.image,
                    place: create.place,
                    ...(size === undefined ? {} : { size }),
                    ...(create.scripted === true ? { scripted: true } : {}),
                    ...(create.origin === undefined ? {} : { origin: create.origin }),
                    ...(create.idleAfter === undefined ? {} : { idleAfter: create.idleAfter }),
                  },
                  "api",
                ),
              );
              yield* dispatch(yield* append({ kind: "container.start", gen: 1 }, "session"));
              return answer("created");
            }
            if (step !== "prompt") return answer(step);
            yield* dispatch(
              yield* append(
                {
                  kind: "prompt.requested",
                  req: input.req,
                  turn: log.state.currentTurn,
                  text: input.prompt,
                  images: [],
                },
                "api",
              ),
            );
            // A prompt the session refused (it failed, or its turn moved on) did not go in.
            const status = log.state.requests.find((item) => item.req === input.req)?.status;
            return answer(
              status === "pending" || status === "delivered" ? "steered" : "unavailable",
            );
          }),
        request: (input: {
          kind: "prompt" | "interrupt";
          req: string;
          // Absent: the session's current turn, for a caller that has not read it.
          turn?: string;
          text: string;
        }) =>
          Effect.gen(function* () {
            const turn = input.turn ?? log.state.currentTurn;
            const draft: Draft =
              input.kind === "prompt"
                ? {
                    kind: "prompt.requested",
                    req: input.req,
                    turn,
                    text: input.text,
                    images: [],
                  }
                : { kind: "interrupt.requested", req: input.req, turn };
            yield* dispatch(yield* append(draft, "api"));
            return {
              status:
                log.state.requests.find((request) => request.req === input.req)?.status ??
                "unknown",
            };
          }),
        stop: (req?: string, target?: { repo: string; agent: typeof AgentKind.Type }) =>
          Effect.gen(function* () {
            const answer = (kind: "ended" | "absent" | "conflict") => ({
              kind,
              version: 1,
              session: sessionView(id(), log.state),
            });
            const created = log.state.created;
            if (created === undefined || log.state.gen === undefined) return answer("absent");
            if (
              target !== undefined &&
              (created.repo !== target.repo || created.agentKind !== target.agent)
            )
              return answer("conflict");
            const duplicate =
              req !== undefined &&
              log.history.some((event) => event.kind === "container.stopped" && event.req === req);
            if (duplicate) return answer("ended");
            yield* dispatch(
              yield* append(
                {
                  kind: "container.stopped",
                  gen: log.state.gen,
                  reason: target === undefined ? "user" : "ended",
                  ...(req === undefined ? {} : { req }),
                },
                "api",
              ),
            );
            return answer("ended");
          }),
        // Absent `size` keeps the current one.
        resume: (size?: typeof Size.Type) =>
          Effect.gen(function* () {
            const conflict = resizeConflict(log.state, size);
            if (conflict !== undefined) return { kind: conflict };
            yield* dispatch(
              yield* append(
                { kind: "resume.requested", ...(size === undefined ? {} : { size }) },
                "api",
              ),
            );
            return { kind: "resumed" as const, version: 1, session: sessionView(id(), log.state) };
          }),
        // The Worker calls this only after the bytes are in R2.
        attach: (file: {
          file: string;
          name: string;
          type: string;
          size: number;
          caption?: string;
        }) => append({ kind: "file.attached", ...file }, "files").pipe(Effect.asVoid),
        // Deleting removes the machine and drops the log, the save and the files; a live session
        // must be stopped first. A log with no `created` is left by a delete that stopped
        // partway, and goes too. A machine that won't go fails the delete, which can be retried.
        remove: () =>
          Effect.gen(function* () {
            const live = log.state.phase !== "stopped" && log.state.phase !== "failed";
            if (live && log.state.created !== undefined) return false;
            const handles = [log.state.place?.handle, log.state.gone?.handle].filter(
              (handle) => handle !== undefined,
            );
            yield* lifecycle.withPermit(
              Effect.forEach(handles, (handle) => where().remove(handle), { discard: true }),
            );
            const files = yield* bucket.list({ prefix: `files/${id()}/` });
            yield* bucket.delete([saveKey(), ...files.objects.map((file) => file.key)]);
            yield* storage.storage.deleteAlarm();
            yield* storage.storage.deleteAll();
            for (const socket of yield* storage.getWebSockets())
              yield* socket.close(1000, "Session deleted").pipe(Effect.ignoreCause);
            return true;
          }),
        view: () => Effect.sync(() => ({ version: 1, session: sessionView(id(), log.state) })),
        conversation: () => Effect.sync(() => conversationView(log.state, log.history)),
        // How an automation run's turn went: its steer's, or the first prompt's; null once deleted.
        outcome: (req?: string) =>
          Effect.sync(() => (log.state.created === undefined ? null : turnOutcome(log.state, req))),
        log: () => Effect.sync(() => log.history),
        // Read-only: what the log says about this session's runs, for the stats page.
        stats: () => Effect.sync(() => sessionStats(log.history)),
        // A preview request from the Worker, whose Host is `<port>-<id>.<base>`, or the
        // terminal socket at `/api/sessions/<id>/terminal`. It never starts a container and
        // appends nothing.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.toWeb(
            yield* HttpServerRequest.HttpServerRequest,
          ).pipe(Effect.orDie);
          const url = new URL(request.url);
          const label = /^(\d{1,5})-/.exec(url.hostname);
          // Another session asking, when the cap is full, whether this one still holds its slot.
          // The Worker forwards only previews, the terminal and `/live`, so only a DO gets here.
          if (label === null && url.pathname === "/running")
            return HttpServerResponse.empty({
              status: live(log.state) && log.state.gen !== undefined ? 204 : 410,
            });
          // Watching isn't using: a live socket leaves the idle window alone.
          if (label === null && url.pathname.endsWith("/live")) {
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
              return HttpServerResponse.text("Expected a WebSocket", { status: 426 });
            const [response, socket] = yield* Cloudflare.upgrade();
            // A failed first send leaves the socket to the next push.
            yield* socket.send(snapshot()).pipe(Effect.ignoreCause);
            return response;
          }
          const unavailable = HttpServerResponse.text("Session not running", { status: 502 });
          if (log.state.phase !== "running") return unavailable;
          used = Date.now();
          if (label?.[1] === undefined) {
            const size = `cols=${url.searchParams.get("cols")}&rows=${url.searchParams.get("rows")}`;
            const gen = log.state.gen ?? 0;
            const target = `http://container/terminal?gen=${gen}&${size}`;
            const headers = new Headers(request.headers);
            for (const [name, value] of Object.entries(yield* auth(gen))) headers.set(name, value);
            return yield* port(7000).pipe(
              Effect.flatMap((terminal) =>
                Effect.tryPromise(() => terminal.fetch(target, { headers })),
              ),
              Effect.map((response) => HttpServerResponse.raw(response)),
              Effect.orElseSucceed(() => unavailable),
            );
          }
          const number = Number(label[1]);
          // Dev servers such as Vite refuse a Host they don't know, so the target is localhost.
          const headers = new Headers(request.headers);
          headers.delete("host");
          const target = `http://localhost:${number}${url.pathname}${url.search}`;
          const init = {
            method: request.method,
            headers,
            body: request.body,
            redirect: "manual" as const,
          };
          return yield* port(number).pipe(
            Effect.flatMap((preview) => Effect.tryPromise(() => preview.fetch(target, init))),
            // raw hands the Response back untouched, so a 101 keeps its webSocket.
            Effect.map((response) => HttpServerResponse.raw(response)),
            Effect.orElseSucceed(() =>
              HttpServerResponse.text(`Nothing is answering on port ${number} yet`, {
                status: 502,
              }),
            ),
          );
        }),
        // Live sockets only listen.
        webSocketMessage: (socket: Cloudflare.WebSocket) =>
          socket.close(1008, "Live sockets take no messages").pipe(Effect.ignoreCause),
        webSocketClose: (socket: Cloudflare.WebSocket) =>
          socket.close(1000, "").pipe(Effect.ignoreCause),
        alarm: () =>
          Effect.gen(function* () {
            const due = deadline(log.state);
            if (due === undefined || due > Date.now()) return;
            const op = log.state.pending.find((item) => item.due === due)?.op;
            if (op) yield* dispatch(yield* append({ kind: "timeout", op }, "alarm"));
          }),
      };
    }).pipe(Effect.provide(SqliteClient.layer({ storage: storage.raw.storage })), Effect.orDie);
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
