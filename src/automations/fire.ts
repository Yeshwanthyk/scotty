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

// Starts or steers the session a received run names, and records the answer on the run. The
// run id is the start's retry key, so firing a run twice sends it once.
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
    const key = run.key === null ? {} : { key: run.key };
    const started = yield* startSession(sessions, credential, {
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
    const outcome: {
      status: "started" | "steered" | "failed";
      reason?: string;
      session?: string;
    } =
      started.kind === "created" || started.kind === "steered" || started.kind === "duplicate"
        ? { status: created ? "started" : "steered", session: started.id }
        : started.kind === "refused"
          ? { status: "failed", reason: `repository unavailable: ${started.message}` }
          : started.kind === "conflict"
            ? {
                status: "failed",
                reason: "key or retry id used by another repo, agent or prompt",
                session: started.id,
              }
            : { status: "failed", reason: "session not taking prompts", session: started.id };
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
    const received = yield* credential.receiveEvent(connection, delivery, payload);
    if (received === null && kind === "webhook") return undefined;
    const runs = received ?? [];
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
    const fresh = runs.length === 0 || runs.some((run) => run.fresh);
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
