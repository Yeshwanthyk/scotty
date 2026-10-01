import { Effect } from "effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as Cloudflare from "alchemy/Cloudflare";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import { startSession } from "../http/start.js";
import { titleFrom } from "../session/title.js";

type Credential = ReturnType<Cloudflare.DurableObject<CredsObject>["getByName"]>;

// The start's retry key, and so the request id of the prompt a steered run sends.
export const runRequest = (id: string) => `run:${id}`;

// The run id names a start, prompt or stop request, so retries keep its first answer.
export function fireRun(
  sessions: Cloudflare.DurableObject<SessionObject>,
  credential: Credential,
  id: string,
) {
  return Effect.gen(function* () {
    const run = yield* credential.takeRun(id);
    if (run === null) return null;
    if (run.kind === "settled")
      return {
        status: run.status,
        ...(run.reason === null ? {} : { reason: run.reason }),
        ...(run.session === null ? {} : { session: run.session }),
      };
    const outcome = yield* Effect.gen(function* () {
      if (run.action === "end") {
        const stopped = yield* sessions.getByName(run.session).stop(runRequest(id));
        return stopped.session.identity.id === ""
          ? { status: "skipped" as const, reason: "no_session" }
          : { status: "ended" as const, session: run.session };
      }
      const key = run.key === null ? {} : { key: run.key };
      const started =
        run.action === "wake"
          ? {
              ...(yield* sessions.getByName(run.session).start({
                req: runRequest(id),
                prompt: run.prompt,
                repo: run.repo,
                agentKind: run.agent,
              })),
              id: run.session,
            }
          : yield* startSession(sessions, credential, {
              ...(run.session === null ? {} : { id: run.session }),
              ...(run.branch === null ? {} : { branch: run.branch }),
              repo: run.repo,
              prompt: run.prompt,
              title: titleFrom(run.prompt),
              agent: run.agent,
              ...(run.scripted === 1 ? { scripted: true } : {}),
              ...key,
              retry: runRequest(id),
              origin: { kind: "automation", automation: run.automation, run: id, ...key },
            });
      // A duplicate may be the first create or a later steer. The creator's request in the
      // session log tells which, even when the reply or the run's settlement was lost.
      const created =
        started.kind === "duplicate"
          ? (yield* sessions.getByName(started.id).log()).some(
              (event) => event.kind === "created" && event.req === runRequest(id),
            )
          : started.kind === "created";
      const answer: {
        status: "started" | "steered" | "skipped" | "failed";
        reason?: string;
        session?: string;
      } =
        started.kind === "created" || started.kind === "steered" || started.kind === "duplicate"
          ? { status: created ? "started" : "steered", session: started.id }
          : started.kind === "uncreated"
            ? { status: "skipped", reason: "no_session" }
            : started.kind === "refused"
              ? { status: "failed", reason: `repository unavailable: ${started.message}` }
              : started.kind === "conflict"
                ? {
                    status: "failed",
                    reason: "key or retry id used by another repo, agent or prompt",
                    session: started.id,
                  }
                : { status: "failed", reason: "session not taking prompts", session: started.id };
      return answer;
    });
    const settled = yield* credential.settleRun(id, outcome);
    return settled === null
      ? null
      : {
          status: settled.status,
          ...(settled.reason === null ? {} : { reason: settled.reason }),
          ...(settled.session === null ? {} : { session: settled.session }),
        };
  });
}

// A delivery to a connection that automations listen on goes to them, one run each; the
// connection then starts nothing itself. A GitHub connection only feeds automations.
export function automationDelivery(
  sessions: Cloudflare.DurableObject<SessionObject>,
  credential: Credential,
  connection: string,
  delivery: string,
  payload: unknown,
  kind: "webhook" | "github",
) {
  return Effect.gen(function* () {
    const runs = yield* credential.receiveEvent(connection, delivery, payload);
    if (runs === null) {
      if (kind === "webhook") return undefined;
      yield* credential.recordDelivery({
        id: delivery,
        connection,
        outcome: "skipped",
        reason: "no_automation",
      });
      return yield* HttpServerResponse.json({ status: "skipped", reason: "no_automation" });
    }
    // A received run without an answer yet is fired again; the run id keeps that a no-op.
    const answered = yield* Effect.forEach(
      runs,
      (run) =>
        run.status === "received"
          ? fireRun(sessions, credential, run.id).pipe(
              Effect.map((outcome) => ({
                ...run,
                ...outcome,
                reason: outcome?.reason ?? null,
                session: outcome?.session ?? null,
              })),
            )
          : Effect.succeed(run),
      { concurrency: "unbounded" },
    );
    const fresh = runs.some((run) => run.fresh);
    const session = answered.find((run) => run.session !== null)?.session ?? null;
    yield* credential.recordDelivery({
      id: delivery,
      connection,
      outcome: fresh ? "accepted" : "duplicate",
      ...(session === null ? {} : { session }),
    });
    return yield* HttpServerResponse.json({
      status: fresh ? "accepted" : "duplicate",
      runs: answered.map((run) => ({
        id: run.id,
        automation: run.automation,
        status: run.status,
        reason: run.reason,
        session: run.session,
      })),
    });
  });
}
