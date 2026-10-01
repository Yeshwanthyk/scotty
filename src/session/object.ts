import { cloudflarePlace } from "../places/cloudflare.js";
import type { Place, PlaceKind } from "../places/place.js";
import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Cause, Config, Duration, Effect, Exit, Schedule, Schema, Semaphore } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { AgentConfig, ToSupervisorMessage } from "../../protocol/supervisor.js";
import CredsObject from "../creds/object.js";
import { type ConnectionMetadata, internalUrl } from "../creds/connections.js";
import * as claude from "./agents/claude.js";
import * as codex from "./agents/codex.js";
import { CodexSettings, defaultCodexSettings } from "./agents/codex-settings.js";
import type { AgentKind, Origin } from "./events.js";
import { instructionsKey, skillKey } from "../settings/skill.js";
import type { Command } from "./commands.js";
import { bindSessionContainer } from "./container-binding.js";
import { deadlines } from "./deadlines.js";
import { deadline, startStep } from "./fold.js";
import { openLog, type Draft } from "./log.js";
import { live } from "./state.js";
import { SupervisorLink, type SocketInput } from "./supervisor-link.js";
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
  Effect.gen(function* () {
    // deploy/deployer.ts sets SCOTTY_IMAGE on the Worker; the default is never used.
    const image = yield* Config.String("SCOTTY_IMAGE").pipe(Config.withDefault(""));
    const { stage } = yield* Stack;
    return {
      name: `scotty-${stage}-sessions`,
      image,
      registryId: "registry.cloudflare.com",
      instanceType: "standard-1" as const,
    };
  }),
) {}

export const SessionArtifacts = Cloudflare.R2.Bucket(
  "SessionArtifacts",
  // Teardown removes the stage with its files; nothing in it outlives the stage.
  Effect.map(Stack, ({ stage }) => ({ name: `scotty-${stage}-artifacts`, forceDestroy: true })),
);

export default class SessionObject extends Cloudflare.DurableObject<SessionObject>()(
  "SessionObject",
  Effect.gen(function* () {
    const storage = yield* Cloudflare.DurableObjectState;
    const credentials = yield* CredsObject;
    yield* bindSessionContainer(SessionContainer);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(SessionArtifacts);
    return Effect.gen(function* () {
      // The container handle exists only at run time.
      const container = storage.container;
      if (container === undefined) return yield* Effect.die("Session container binding missing");
      const log = yield* openLog(storage);
      const id = () => log.state.created?.branch.slice("scotty/".length) ?? "";
      const context = yield* Effect.context<RuntimeContext | Cloudflare.DurableObjectState>();

      const append = log.append;
      const places = {
        cloudflare: cloudflarePlace(container, storage.raw.exports),
      } satisfies Record<typeof PlaceKind.Type, Place>;
      // Logs written before `created.place` ran on Cloudflare.
      const where = () => places[log.state.created?.place ?? "cloudflare"];
      const saveKey = () => `saves/${id()}.tar`;
      const supervisor = (path: string, init?: { method: "PUT"; body: ArrayBuffer }) =>
        Effect.tryPromise(() => where().port(7000).fetch(`http://container${path}`, init)).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.succeed(response)
              : Effect.fail(new Error(`Supervisor ${path} returned ${response.status}`)),
          ),
        );

      let link: SupervisorLink;
      // Work queued for an older generation, or for a session that has ended, does nothing.
      const current = (gen: number) => log.state.gen === gen && live(log.state);
      const port = () => where().port(7000);
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
      // Container work runs after the caller returns, one operation at a time, so a resume
      // waits for the stop's destroy. Its outcome arrives as a later event.
      const lifecycle = yield* Semaphore.make(1);
      const outside = new Set<Command["kind"]>(["container.start", "dial", "start", "destroy"]);
      const dispatch = (action: Command | undefined): Effect.Effect<void, never, RuntimeContext> =>
        action !== undefined && outside.has(action.kind)
          ? storage.waitUntil(lifecycle.withPermit(perform(action)))
          : perform(action);
      const perform = (action: Command | undefined): Effect.Effect<void, never, RuntimeContext> =>
        Effect.gen(function* () {
          if (!action) return;
          switch (action.kind) {
            case "container.start": {
              if (!current(action.gen)) return;
              if (action.fresh && (yield* where().running())) yield* where().destroy();
              if (!(yield* where().running())) {
                const connections = (yield* connectionsFor(action.gen))
                  .filter((connection) => connection.kind !== "webhook")
                  .map((connection) => connection.name);
                yield* where().start({
                  session: id(),
                  repo: log.state.created?.repo ?? "",
                  connections,
                });
              }
              // A new container takes a moment to listen, longer on a new host; retry until the
              // fold's container deadline before reporting dial.failed.
              yield* link
                .dial(port(), action.gen, 0, () => current(action.gen))
                .pipe(
                  Effect.timeout("10 seconds"),
                  Effect.retry({
                    schedule: Schedule.spaced("500 millis").pipe(
                      Schedule.upTo({ duration: Duration.millis(deadlines.container) }),
                    ),
                    // Not container.running: it can still read false just after start().
                    while: () => current(action.gen),
                  }),
                );
              return;
            }
            case "dial": {
              // A dial queued behind the start may find the socket already connected.
              if (!current(action.gen) || log.state.connected) return;
              yield* link
                .dial(port(), action.gen, action.after, () => current(action.gen))
                .pipe(Effect.timeout("10 seconds"));
              return;
            }
            case "start": {
              if (!current(action.gen)) return;
              // Sent over the socket only; never appended to the event log.
              const owner = credentials.getByName("owner");
              const codexSettings =
                action.scripted !== true && action.agentKind === "codex"
                  ? yield* Schema.decodeUnknownEffect(CodexSettings)({
                      model: yield* Config.String("SCOTTY_CODEX_MODEL").pipe(
                        Config.withDefault(defaultCodexSettings.model),
                      ),
                      effort: yield* Config.String("SCOTTY_CODEX_EFFORT").pipe(
                        Config.withDefault(defaultCodexSettings.effort),
                      ),
                    })
                  : defaultCodexSettings;
              const agentConfig = {
                codex: () =>
                  owner
                    .sessionToken()
                    .pipe(Effect.map((chatgpt) => codex.startConfig(chatgpt, codexSettings))),
                claude: () => owner.claudeToken().pipe(Effect.map(claude.startConfig)),
              } satisfies Record<typeof AgentKind.Type, unknown>;
              // The scripted stand-in needs no account, so e2e runs without the owner's sign-ins.
              const signedIn = yield* Effect.exit(
                action.scripted === true
                  ? Effect.succeed(scriptedStart(action.agentKind))
                  : Effect.all([agentConfig[action.agentKind](), owner.gitIdentity()]),
              );
              if (Exit.isFailure(signedIn)) {
                if (current(action.gen))
                  yield* append(
                    {
                      kind: "failed",
                      phase: "credentials",
                      code: "signin_required",
                      retryable: true,
                    },
                    "session",
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
              const agent = { ...configured, mcp };
              // The deployer always sets SCOTTY_HATCH_BASE to the stage's domain.
              const hatchBase = yield* Effect.orDie(Config.String("SCOTTY_HATCH_BASE"));
              // Resume only when the save reached the new container; otherwise start clean.
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
              // Settings as they are now; a running session keeps what it started with.
              // A failed read fails the start (start_failed, retryable) rather than drop a setting.
              const saved = yield* Effect.orDie(bucket.get(instructionsKey));
              const instructions = saved === null ? "" : yield* Effect.orDie(saved.text());
              const skills = (yield* credentials.getByName("owner").skills()).filter(
                (skill) => skill.enabled,
              );
              const installed = yield* Effect.forEach(skills, (skill) =>
                bucket.get(skillKey(skill.name)).pipe(
                  Effect.flatMap((zip) =>
                    zip === null
                      ? Effect.succeed([])
                      : zip.arrayBuffer().pipe(
                          Effect.flatMap((body) =>
                            supervisor(
                              `/skill?gen=${action.gen}&name=${encodeURIComponent(skill.name)}`,
                              { method: "PUT", body },
                            ),
                          ),
                          Effect.as([skill.name]),
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
              // The tar can take seconds; the result arrives as a later event (R1).
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
              if (yield* where().running()) yield* where().destroy();
              return;
          }
        }).pipe(
          // A start that hangs (an R2 read, a supervisor PUT) must not hold the lifecycle permit.
          action?.kind === "start" ? Effect.timeout("30 seconds") : (effect) => effect,
          Effect.catchTag("ContainerStartFailed", () =>
            action?.kind === "container.start" && current(action.gen)
              ? append(
                  { kind: "failed", phase: "container", code: "container_start", retryable: true },
                  "session",
                ).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (action === undefined || !("gen" in action) || !current(action.gen)) return;
              // Error text only: R2, RPC and supervisor failures carry no credentials.
              if (action.kind === "start") console.error(`start failed: ${Cause.pretty(cause)}`);
              if (action.kind === "container.start" || action.kind === "dial") {
                // A dial that fails because the container is gone is a stop, not a retry.
                const kind = (yield* where().running()) ? "dial.failed" : "container.stopped";
                yield* dispatch(yield* append({ kind, gen: action.gen }, "session"));
              } else if (action.kind === "start") {
                yield* append(
                  { kind: "failed", phase: "start", code: "start_failed", retryable: true },
                  "session",
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
        Effect.runPromise(Effect.provide(onSocket(input).pipe(Effect.orDie), context)),
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
          create?: {
            id: string;
            baseBranch: string;
            title: string;
            image: string;
            place: typeof PlaceKind.Type;
            scripted?: true;
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
                    ...(create.scripted === true ? { scripted: true } : {}),
                    ...(create.origin === undefined ? {} : { origin: create.origin }),
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
        stop: () =>
          Effect.gen(function* () {
            if (log.state.gen !== undefined)
              yield* dispatch(
                yield* append({ kind: "container.stopped", gen: log.state.gen }, "api"),
              );
            return { version: 1, session: sessionView(id(), log.state) };
          }),
        resume: () =>
          Effect.gen(function* () {
            yield* dispatch(yield* append({ kind: "resume.requested" }, "api"));
            return { version: 1, session: sessionView(id(), log.state) };
          }),
        // The Worker calls this only after the bytes are in R2.
        attach: (file: {
          file: string;
          name: string;
          type: string;
          size: number;
          caption?: string;
        }) => append({ kind: "file.attached", ...file }, "files").pipe(Effect.asVoid),
        // Deleting drops the log, the save and the files; a live session must be stopped first.
        // A log with no `created` is left by a delete that stopped partway, and goes too.
        remove: () =>
          Effect.gen(function* () {
            const live = log.state.phase !== "stopped" && log.state.phase !== "failed";
            if (live && log.state.created !== undefined) return false;
            const files = yield* bucket.list({ prefix: `files/${id()}/` });
            yield* bucket.delete([saveKey(), ...files.objects.map((file) => file.key)]);
            yield* storage.storage.deleteAlarm();
            yield* storage.storage.deleteAll();
            return true;
          }),
        view: () => Effect.sync(() => ({ version: 1, session: sessionView(id(), log.state) })),
        conversation: () => Effect.sync(() => conversationView(log.state, log.history)),
        // How an automation run's turn went: its steer's, or the first prompt's; null once deleted.
        outcome: (req?: string) =>
          Effect.sync(() => (log.state.created === undefined ? null : turnOutcome(log.state, req))),
        log: () => Effect.sync(() => log.history),
        // A preview request from the Worker, whose Host is `<port>-<id>.<base>`, or the
        // terminal socket at `/api/sessions/<id>/terminal`. It never starts a container and
        // appends nothing.
        fetch: Effect.gen(function* () {
          const unavailable = HttpServerResponse.text("Session not running", { status: 502 });
          if (log.state.phase !== "running") return unavailable;
          const request = yield* HttpServerRequest.toWeb(
            yield* HttpServerRequest.HttpServerRequest,
          ).pipe(Effect.orDie);
          const url = new URL(request.url);
          const label = /^(\d{1,5})-/.exec(url.hostname);
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
          // Dev servers such as Vite refuse a Host they don't know, so the target is localhost.
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
            // raw hands the Response back untouched, so a 101 keeps its webSocket.
            Effect.map((response) => HttpServerResponse.raw(response)),
            Effect.orElseSucceed(() =>
              HttpServerResponse.text(`Nothing is answering on port ${port} yet`, { status: 502 }),
            ),
          );
        }),
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
