import { sameImages, type PromptImage } from "../../protocol/prompt.js";
import { cloudflarePlace } from "../places/cloudflare.js";
import type { Place, PlaceKind, Size } from "../places/place.js";
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
  Option,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  Terminals,
  type AgentConfig,
  type ToSupervisorMessage,
} from "../../protocol/supervisor.js";
import CredsObject from "../creds/object.js";
import { type ConnectionMetadata, internalUrl } from "../creds/connections.js";
import * as claude from "./agents/claude.js";
import * as codex from "./agents/codex.js";
import { AgentSettings, stageAgentDefaults } from "./agents/agent-settings.js";
import type { AgentKind, Origin } from "./events.js";
import { instructionsKey, sourceKey } from "../settings/skills.js";
import type { Command } from "./commands.js";
import { bindSessionContainer } from "./container-binding.js";
import { deadlines, idleWindow, inactivityTimeout } from "./deadlines.js";
import { deadline, resizeConflict, startStep } from "./fold.js";
import { openLog, type Draft } from "./log.js";
import { live } from "./state.js";
import { sessionStats } from "./stats.js";
import { SupervisorLink, type SocketInput } from "./supervisor-link.js";
import { supervisorEvent } from "./supervisor-events.js";
import { conversationView, sessionView, turnOutcome } from "./view.js";

const scriptedStart: (
  kind: typeof AgentKind.Type,
) => [typeof AgentConfig.Type, { name: string; email: string }] = (kind) => [
  kind === "codex"
    ? { kind: "codex", scripted: true, model: "scripted" }
    : { kind: "claude", scripted: true, model: "scripted" },
  { name: "Scotty e2e", email: "e2e@scotty.invalid" },
];

export class SessionContainer extends Cloudflare.Container<SessionContainer>()(
  "SessionContainer",
  Effect.map(Stack, ({ stage }) => ({
    name: `scotty-${stage}-sessions`,
    schedulingPolicy: "durable_object" as const,
  })),
) {}

export const SessionArtifacts = Cloudflare.R2.Bucket(
  "SessionArtifacts",
  Effect.map(Stack, ({ stage }) => ({ name: `scotty-${stage}-artifacts`, forceDestroy: true })),
);

const MaxRunning = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

const ExitStatus = Schema.Struct({ exitCode: Schema.Int });
class SupervisorFailure extends Schema.TaggedError<SupervisorFailure>()("SupervisorFailure", {
  path: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

const pushEvery = Duration.millis(250);

export default class SessionObject extends Cloudflare.DurableObject<SessionObject>()(
  "SessionObject",
  Effect.gen(function* () {
    const storage = yield* Cloudflare.DurableObjectState;
    const credentials = yield* CredsObject;
    const sessions = yield* Cloudflare.DurableObjectScope;
    const env = yield* Cloudflare.WorkerEnvironment;
    yield* bindSessionContainer(SessionContainer);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(SessionArtifacts);
    return Effect.gen(function* () {
      const rawMax: unknown = env["SCOTTY_MAX_RUNNING"];
      const max = yield* Schema.decodeUnknownEffect(MaxRunning)(rawMax);
      const container = storage.container;
      if (container === undefined) return yield* Effect.die("Session container binding missing");
      const log = yield* openLog(storage);
      const id = () => log.state.created?.branch.slice("scotty/".length) ?? "";
      const context = yield* Effect.context<RuntimeContext | Cloudflare.DurableObjectState>();

      const places = {
        cloudflare: cloudflarePlace(container, storage.raw.exports),
      } satisfies Record<typeof PlaceKind.Type, Place>;
      const where = () => places[log.state.created?.place ?? "cloudflare"];
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
      const supervisor = (path: string, init?: { method: "PUT"; body: ArrayBuffer }) =>
        Effect.tryPromise({
          try: () => where().port(7000).fetch(`http://container${path}`, init),
          catch: () => new SupervisorFailure({ path }),
        }).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.succeed(response)
              : Effect.fail(new SupervisorFailure({ path, status: response.status })),
          ),
        );

      let link: SupervisorLink;
      const current = (gen: number) => log.state.gen === gen && live(log.state);
      const port = () => where().port(7000);
      let startConnections: { gen: number; items: readonly ConnectionMetadata[] } | undefined;
      const connectionsFor = (gen: number) =>
        Effect.gen(function* () {
          if (startConnections?.gen === gen) return startConnections.items;
          const items = yield* credentials.getByName("owner").connections();
          startConnections = { gen, items };
          return items;
        });
      const lifecycle = yield* Semaphore.make(1);
      let used = 0;
      const outside = new Set<Command["kind"]>([
        "container.start",
        "dial",
        "start",
        "destroy",
        "watch",
        "idle",
      ]);
      const watcher = yield* FiberHandle.make<void, never>().pipe(
        Scope.provide(yield* Scope.make()),
      );
      const exited = (gen: number) => {
        const record = (end: { reason: "exited" } | { reason: "crashed"; exitCode: number }) =>
          current(gen)
            ? append({ kind: "container.stopped", gen, ...end }, "session").pipe(
                Effect.flatMap(dispatch),
              )
            : Effect.void;
        return Effect.tryPromise({
          try: () => container.monitor(),
          catch: (cause) => cause,
        }).pipe(
          Effect.matchEffect({
            onSuccess: () => record({ reason: "exited" }),
            onFailure: (cause) =>
              Option.match(Schema.decodeUnknownOption(ExitStatus)(cause), {
                onNone: () => Effect.logWarning("container watch lost", cause),
                onSome: ({ exitCode }) => record({ reason: "crashed", exitCode }),
              }),
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("recording container exit failed", cause),
          ),
          Effect.provide(context),
        );
      };
      const watch = (gen: number) =>
        Effect.gen(function* () {
          if (!current(gen)) return;
          yield* Effect.tryPromise(() => container.setInactivityTimeout(inactivityTimeout));
          yield* FiberHandle.run(watcher, exited(gen));
          yield* append({ kind: "container.watched", gen }, "session");
        }).pipe(Effect.ignoreCause({ log: "Error", message: "watch failed" }));
      const dispatch: (
        action: Command | undefined,
      ) => Effect.Effect<void, never, RuntimeContext> = (action) =>
        action !== undefined && outside.has(action.kind)
          ? storage.waitUntil(lifecycle.withPermit(perform(action)))
          : perform(action);
      const perform: (action: Command | undefined) => Effect.Effect<void, never, RuntimeContext> = (
        action,
      ) =>
        Effect.gen(function* () {
          if (!action) return;
          switch (action.kind) {
            case "container.start": {
              if (!current(action.gen)) return;
              if (action.fresh && (yield* where().running())) yield* where().destroy();
              if (!(yield* where().running())) {
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
                if (!claim.granted) {
                  if (current(action.gen))
                    yield* dispatch(
                      yield* append(
                        { kind: "container.stopped", gen: action.gen, reason: "cap", max },
                        "session",
                      ),
                    );
                  return;
                }
                const connections = (yield* connectionsFor(action.gen))
                  .filter((connection) => connection.kind !== "inbound")
                  .map((connection) => connection.name);
                yield* where().start({
                  session: id(),
                  repo: log.state.created?.repo ?? "",
                  size: log.state.size,
                  connections,
                });
              }
              if (current(action.gen))
                yield* append({ kind: "container.dial.started", gen: action.gen }, "session");
              let attempt = log.history.filter(
                (event) => event.kind === "container.dial.attempt" && event.gen === action.gen,
              ).length;
              const dial = Effect.gen(function* () {
                const observed = ++attempt <= 16;
                if (observed)
                  yield* append(
                    { kind: "container.dial.attempt", gen: action.gen, attempt },
                    "session",
                  );
                const started = Date.now();
                yield* link
                  .dial(port, action.gen, 0, () => current(action.gen))
                  .pipe(
                    Effect.timeout("10 seconds"),
                    Effect.onExit((exit) =>
                      observed
                        ? append(
                            {
                              kind: "container.dial.result",
                              gen: action.gen,
                              attempt,
                              elapsedMs: Date.now() - started,
                              outcome: Exit.isSuccess(exit)
                                ? current(action.gen)
                                  ? "connected"
                                  : "stale"
                                : Cause.hasInterruptsOnly(exit.cause)
                                  ? "interrupted"
                                  : Option.exists(
                                        Cause.findErrorOption(exit.cause),
                                        Cause.isTimeoutError,
                                      )
                                    ? "timeout"
                                    : "failed",
                            },
                            "session",
                          ).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  );
              });
              yield* dial.pipe(
                Effect.retry({
                  schedule: Schedule.spaced("500 millis").pipe(
                    Schedule.upTo({ duration: Duration.millis(deadlines.container) }),
                  ),
                  while: () => current(action.gen),
                }),
              );
              yield* watch(action.gen);
              return;
            }
            case "dial": {
              if (!current(action.gen) || log.state.connected) return;
              yield* link
                .dial(port, action.gen, action.after, () => current(action.gen))
                .pipe(Effect.timeout("10 seconds"));
              yield* watch(action.gen);
              return;
            }
            case "start": {
              if (!current(action.gen)) return;
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
              const defaults = yield* stageAgentDefaults(yield* owner.agentDefaults());
              const settings = defaults[action.agentKind];
              const signedIn = yield* Effect.exit(
                action.scripted === true
                  ? Effect.succeed(scriptedStart(action.agentKind))
                  : Effect.all([agentConfig[action.agentKind](settings), owner.gitIdentity()]),
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
              const mcp = (yield* connectionsFor(action.gen))
                .filter((connection) => connection.kind === "mcp")
                .map((connection) => ({
                  name: connection.name,
                  url: internalUrl(connection.name, "mcp"),
                }));
              const skills = yield* credentials.getByName("owner").sessionSkills();
              const agent = {
                ...configured,
                mcp,
                skillsOff: skills.off,
                ...(configured.kind === "claude" && skills.style !== undefined
                  ? { style: skills.style }
                  : {}),
              };
              const hatchBase = yield* Effect.orDie(Config.String("SCOTTY_HATCH_BASE"));
              const restored =
                action.resume === undefined
                  ? false
                  : yield* bucket.get(saveKey()).pipe(
                      Effect.flatMap((saved) =>
                        saved === null
                          ? Effect.succeed(false)
                          : saved.arrayBuffer().pipe(
                              Effect.flatMap((body) =>
                                supervisor(`/save?gen=${action.gen}`, { method: "PUT", body }),
                              ),
                              Effect.as(true),
                            ),
                      ),
                      Effect.orElseSucceed(() => false),
                    );
              const saved = yield* Effect.orDie(bucket.get(instructionsKey));
              const instructions = saved === null ? "" : yield* Effect.orDie(saved.text());
              const installed = yield* Effect.forEach(skills.sources, (source) =>
                bucket.get(sourceKey(source.repo, source.commit)).pipe(
                  Effect.flatMap((tarball) =>
                    tarball === null
                      ? Effect.succeed([])
                      : tarball.arrayBuffer().pipe(
                          Effect.flatMap((body) =>
                            supervisor(`/skills?gen=${action.gen}&commit=${source.commit}`, {
                              method: "PUT",
                              body,
                            }),
                          ),
                          Effect.as([{ commit: source.commit, path: source.path }]),
                        ),
                  ),
                  Effect.orDie,
                ),
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
              yield* storage.waitUntil(
                supervisor(`/save?gen=${action.gen}`).pipe(
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
            case "destroy":
              yield* Effect.ensuring(
                Effect.gen(function* () {
                  if (yield* where().running()) yield* where().destroy();
                }),
                credentials.getByName("owner").release(id()).pipe(Effect.ignoreCause),
              );
              return;
            case "idle": {
              if (!current(action.gen)) return;
              const terminals = yield* supervisor("/terminals").pipe(
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
            case "watch":
              if (!current(action.gen)) return;
              if (yield* where().running()) return yield* watch(action.gen);
              yield* dispatch(
                yield* append(
                  { kind: "container.stopped", gen: action.gen, reason: "gone" },
                  "session",
                ),
              );
              return;
          }
        }).pipe(
          action?.kind === "start" ? Effect.timeout("30 seconds") : (effect) => effect,
          Effect.catchTag("ContainerStartFailed", () =>
            action?.kind === "container.start" && current(action.gen)
              ? append(
                  { kind: "failed", phase: "container", code: "container_start", retryable: true },
                  "session",
                ).pipe(Effect.flatMap(dispatch))
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (action === undefined || !("gen" in action) || !current(action.gen)) return;
              if (action.kind === "start") yield* Effect.logError("start failed", cause);
              if (action.kind === "container.start" || action.kind === "dial") {
                yield* dispatch(
                  yield* append(
                    (yield* where().running())
                      ? { kind: "dial.failed", gen: action.gen }
                      : { kind: "container.stopped", gen: action.gen, reason: "gone" },
                    "session",
                  ),
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
        start: (input: {
          req: string;
          prompt: string;
          images?: readonly PromptImage[];
          repo: string;
          agentKind: typeof AgentKind.Type;
          size?: typeof Size.Type;
          create?: {
            id: string;
            baseBranch: string;
            title: string;
            image: string;
            place: typeof PlaceKind.Type;
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
                    images: input.images ?? [],
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
                  images: input.images ?? [],
                },
                "api",
              ),
            );
            const status = log.state.requests.find((item) => item.req === input.req)?.status;
            return answer(
              status === "pending" || status === "delivered" ? "steered" : "unavailable",
            );
          }),
        request: (input: {
          kind: "prompt" | "interrupt";
          req: string;
          turn?: string;
          text: string;
          images?: readonly PromptImage[];
        }) =>
          Effect.gen(function* () {
            const turn = input.turn ?? log.state.currentTurn;
            const seen = log.state.requests.find((request) => request.req === input.req);
            if (
              seen !== undefined &&
              (seen.kind !== input.kind ||
                seen.turn !== turn ||
                (seen.kind === "prompt" &&
                  (seen.text !== input.text || !sameImages(seen.images, input.images))))
            )
              return { status: "conflict" };
            const draft: Draft =
              input.kind === "prompt"
                ? {
                    kind: "prompt.requested",
                    req: input.req,
                    turn,
                    text: input.text,
                    images: input.images ?? [],
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
        attach: (file: {
          file: string;
          name: string;
          type: string;
          size: number;
          caption?: string;
        }) => append({ kind: "file.attached", ...file }, "files").pipe(Effect.asVoid),
        remove: () =>
          Effect.gen(function* () {
            const live = log.state.phase !== "stopped" && log.state.phase !== "failed";
            if (live && log.state.created !== undefined) return false;
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
        outcome: (req?: string) =>
          Effect.sync(() => (log.state.created === undefined ? null : turnOutcome(log.state, req))),
        log: () => Effect.sync(() => log.history),
        stats: () => Effect.sync(() => sessionStats(log.history)),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.toWeb(
            yield* HttpServerRequest.HttpServerRequest,
          ).pipe(Effect.orDie);
          const url = new URL(request.url);
          const label = /^(\d{1,5})-/.exec(url.hostname);
          if (label === null && url.pathname === "/running")
            return HttpServerResponse.empty({
              status: live(log.state) && log.state.gen !== undefined ? 204 : 410,
            });
          if (label === null && url.pathname.endsWith("/live")) {
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
              return HttpServerResponse.text("Expected a WebSocket", { status: 426 });
            const [response, socket] = yield* Cloudflare.upgrade();
            yield* socket.send(snapshot()).pipe(Effect.ignoreCause);
            return response;
          }
          const unavailable = HttpServerResponse.text("Session not running", { status: 502 });
          if (log.state.phase !== "running") return unavailable;
          used = Date.now();
          if (label?.[1] === undefined) {
            const size = `cols=${url.searchParams.get("cols")}&rows=${url.searchParams.get("rows")}`;
            const target = `http://container/terminal?gen=${log.state.gen}&${size}`;
            return yield* Effect.tryPromise(() =>
              where().port(7000).fetch(target, { headers: request.headers }),
            ).pipe(
              Effect.map((response) => HttpServerResponse.raw(response)),
              Effect.orElseSucceed(() => unavailable),
            );
          }
          const port = Number(label[1]);
          const headers = new Headers(request.headers);
          headers.delete("host");
          const target = `http://localhost:${port}${url.pathname}${url.search}`;
          const init = {
            method: request.method,
            headers,
            body: request.body,
            redirect: "manual" as const,
          };
          return yield* Effect.tryPromise(() => where().port(port).fetch(target, init)).pipe(
            Effect.map((response) => HttpServerResponse.raw(response)),
            Effect.orElseSucceed(() =>
              HttpServerResponse.text(`Nothing is answering on port ${port} yet`, { status: 502 }),
            ),
          );
        }),
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
