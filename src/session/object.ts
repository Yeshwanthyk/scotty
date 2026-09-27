import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Config, Effect } from "effect";
import type { ToSupervisorMessage } from "../../protocol/supervisor.js";
import CredsObject from "../creds/object.js";
import type { Command } from "./commands.js";
import { bindSessionContainer } from "./container-binding.js";
import { deadline } from "./fold.js";
import { openLog, type Draft } from "./log.js";
import { SupervisorLink, type SocketInput } from "./supervisor-link.js";
import { supervisorEvent } from "./supervisor-events.js";
import { conversationView, sessionView } from "./view.js";

export class SessionContainer extends Cloudflare.Container<SessionContainer>()(
  "SessionContainer",
  // Runtime-only default; alchemy.run.ts rejects a missing SCOTTY_IMAGE before any deploy.
  Config.String("SCOTTY_IMAGE").pipe(
    Config.withDefault(""),
    Effect.map((image) => ({
      image,
      registryId: "registry.cloudflare.com",
      instanceType: "basic" as const,
    })),
  ),
) {}

export const SessionArtifacts = Cloudflare.R2.Bucket("SessionArtifacts");

export default class SessionObject extends Cloudflare.DurableObject<SessionObject>()(
  "SessionObject",
  Effect.gen(function* () {
    const storage = yield* Cloudflare.DurableObjectState;
    const credentials = yield* CredsObject;
    yield* bindSessionContainer(SessionContainer);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(SessionArtifacts);
    return Effect.gen(function* () {
      // The container handle exists only at run time, not while Alchemy plans the deploy.
      const container = storage.container;
      if (container === undefined) return yield* Effect.die("Session container binding missing");
      // ctx.exports is typed {} without a GlobalProps declaration; its default export is the
      // Worker's loopback, which takes props (work/spikes/7a/RESULT.md).
      const isLoopback = (
        value: unknown,
      ): value is (options: {
        props: { session: string; repo: string };
      }) => Parameters<NonNullable<typeof container>["interceptOutboundHttp"]>[1] =>
        typeof value === "function";
      const log = yield* openLog(storage);
      const id = () => log.state.created?.branch.slice("scotty/".length) ?? "";
      const context = yield* Effect.context<RuntimeContext | Cloudflare.DurableObjectState>();

      const append = log.append;
      const saveKey = () => `saves/${id()}.tar`;
      const supervisor = (path: string, init?: { method: "PUT"; body: ArrayBuffer }) =>
        Effect.tryPromise(() =>
          container.getTcpPort(7000).fetch(`http://container${path}`, init),
        ).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.succeed(response)
              : Effect.fail(new Error(`Supervisor ${path} returned ${response.status}`)),
          ),
        );

      let link: SupervisorLink;
      const dispatch = (action: Command | undefined): Effect.Effect<void, never, RuntimeContext> =>
        Effect.gen(function* () {
          if (!action) return;
          switch (action.kind) {
            case "container.start": {
              if (action.fresh && container.running)
                yield* Effect.promise(() => container.destroy());
              if (!container.running) {
                // A new container needs the interceptor; Alchemy's wrapper drops this promise.
                const loopback: unknown = Reflect.get(storage.raw.exports, "default");
                if (!isLoopback(loopback)) return yield* Effect.die("no ctx.exports.default");
                const repo = log.state.created?.repo ?? "";
                const fetcher = loopback({ props: { session: id(), repo } });
                yield* Effect.tryPromise(() =>
                  container.interceptOutboundHttp("github.internal", fetcher),
                );
                yield* Effect.try({
                  try: () => container.start({ enableInternet: true }),
                  catch: () => new Error("Container start failed"),
                });
              }
              const port = Cloudflare.fromCloudflareFetcher(container.getTcpPort(7000));
              yield* link.dial(port, action.gen, 0);
              return;
            }
            case "dial": {
              const port = Cloudflare.fromCloudflareFetcher(container.getTcpPort(7000));
              yield* link.dial(port, action.gen, action.after);
              return;
            }
            case "start": {
              // Sent over the socket only; never appended to the event log.
              const chatgpt = yield* credentials.getByName("owner").sessionToken();
              const git = yield* credentials.getByName("owner").gitIdentity();
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
              const message: ToSupervisorMessage = {
                type: "start",
                gen: action.gen,
                n: 1,
                repo: action.repo,
                base: action.base,
                branch: action.branch,
                agent: {
                  kind: "codex",
                  model: "gpt-5.5",
                  effort: "medium",
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                  token: chatgpt.token,
                  accountId: chatgpt.accountId,
                },
                git,
                ...(restored && action.resume !== undefined ? { resume: action.resume } : {}),
              };
              link.send(message);
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
              if (container.running) yield* Effect.promise(() => container.destroy());
              return;
          }
        }).pipe(
          Effect.catchCause(() =>
            Effect.gen(function* () {
              if (action?.kind === "container.start" || action?.kind === "dial") {
                // A dial that fails because the container is gone is a stop, not a retry.
                const kind = container.running ? "dial.failed" : "container.stopped";
                yield* dispatch(yield* append({ kind, gen: action.gen }, "session"));
              } else if (action?.kind === "start") {
                yield* append(
                  {
                    kind: "failed",
                    phase: "credentials",
                    code: "signin_required",
                    retryable: false,
                  },
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
        const restart = yield* append({ kind: "sup.redial", gen: log.state.gen }, "session");
        yield* storage.waitUntil(dispatch(restart));
      }
      return {
        create: (input: {
          id: string;
          repo: string;
          baseBranch: string;
          title: string;
          prompt: string;
          image: string;
        }) =>
          Effect.gen(function* () {
            if (log.state.created) return sessionView(id(), log.state);
            yield* dispatch(
              yield* append(
                {
                  kind: "created",
                  agentKind: "codex",
                  branch: `scotty/${input.id}`,
                  repo: input.repo,
                  baseBranch: input.baseBranch,
                  title: input.title,
                  prompt: input.prompt,
                  image: input.image,
                },
                "api",
              ),
            );
            yield* dispatch(yield* append({ kind: "container.start", gen: 1 }, "session"));
            return sessionView(id(), log.state);
          }),
        request: (input: {
          kind: "prompt" | "interrupt";
          req: string;
          turn: string;
          text: string;
        }) =>
          Effect.gen(function* () {
            const draft: Draft =
              input.kind === "prompt"
                ? {
                    kind: "prompt.requested",
                    req: input.req,
                    turn: input.turn,
                    text: input.text,
                    images: [],
                  }
                : { kind: "interrupt.requested", req: input.req, turn: input.turn };
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
        view: () => Effect.sync(() => ({ version: 1, session: sessionView(id(), log.state) })),
        conversation: () => Effect.sync(() => conversationView(log.state, log.history)),
        log: () => Effect.sync(() => log.history),
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
