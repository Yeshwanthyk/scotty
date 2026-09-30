import { Effect, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as Cloudflare from "alchemy/Cloudflare";
import { connectionName, Key } from "../creds/connections.js";
import type CredsObject from "../creds/object.js";
import { AgentKind } from "../session/events.js";
import type SessionObject from "../session/object.js";
import { Repo, startSession } from "../http/start.js";
import { maxBodyBytes } from "./signature.js";

export const hookPath = /^\/hooks\/([^/]+)$/;

const Payload = Schema.Struct({
  repo: Repo,
  prompt: Schema.String.check(Schema.isMinLength(1)),
  key: Schema.optional(Key),
  agent: Schema.optional(AgentKind),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload));

// The first line of the prompt, cut at a word near 60 characters.
const titleFrom = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
};

// A sender sees only the status and a code; the details are in `scotty deliveries`.
const refuse = (status: number, code: string) =>
  HttpServerResponse.json({ error: { code, message: code.replaceAll("_", " ") } }, { status });

// POST /hooks/:name. Only a verified delivery reaches a session; every one that names a
// connection is recorded, accepted or not.
export function hookHandler(
  request: HttpServerRequest.HttpServerRequest,
  name: string,
  sessions: Cloudflare.DurableObject<SessionObject>,
  credentials: Cloudflare.DurableObject<CredsObject>,
) {
  return Effect.gen(function* () {
    const credential = credentials.getByName("owner");
    const known =
      connectionName.test(name) &&
      (yield* credential.connections()).some((connection) => connection.name === name);
    if (!known) return yield* refuse(404, "unknown_connection");
    if (request.method !== "POST") return yield* refuse(405, "use_post");
    const delivery = request.headers["webhook-id"] ?? "";
    const timestamp = request.headers["webhook-timestamp"] ?? "";
    const signature = request.headers["webhook-signature"] ?? "";
    const reject = (status: number, reason: string) =>
      credential
        .recordDelivery({ id: delivery, connection: name, outcome: "rejected", reason })
        .pipe(Effect.andThen(refuse(status, reason)));
    if (delivery === "" || timestamp === "" || signature === "" || delivery.length > 256)
      return yield* reject(400, "missing_headers");
    if (Number(request.headers["content-length"] ?? 0) > maxBodyBytes)
      return yield* reject(413, "too_large");
    const bytes = new Uint8Array(yield* request.arrayBuffer);
    if (bytes.byteLength > maxBodyBytes) return yield* reject(413, "too_large");
    const body = new TextDecoder().decode(bytes);
    const verdict = yield* credential.verifyDelivery({
      connection: name,
      id: delivery,
      timestamp,
      signature,
      body,
    });
    if (verdict === "unknown") return yield* refuse(404, "unknown_connection");
    if (verdict !== "ok") return yield* reject(401, verdict);
    const earlier = yield* credential.acceptedDelivery(name, delivery);
    if (earlier !== null) {
      yield* credential.recordDelivery({
        id: delivery,
        connection: name,
        outcome: "duplicate",
        session: earlier,
      });
      return yield* HttpServerResponse.json({ status: "duplicate", session: earlier });
    }
    const payload = yield* decodePayload(body).pipe(Effect.option);
    if (payload._tag === "None") return yield* reject(400, "bad_body");
    const { repo, prompt, key, agent, title } = payload.value;
    const started = yield* startSession(sessions, credential, {
      repo,
      prompt,
      title: title ?? titleFrom(prompt),
      agent: agent ?? "codex",
      ...(key === undefined ? {} : { key }),
      // A retried delivery reserves the same session, or sends the same steer, and so does nothing new.
      retry: `hook:${name}:${delivery}`,
      origin: {
        kind: "hook",
        connection: name,
        delivery,
        ...(key === undefined ? {} : { key }),
      },
    });
    if (started.kind === "refused") return yield* reject(502, "repository_unavailable");
    if (started.kind === "conflict") return yield* reject(409, "key_conflict");
    // A failed session takes no prompt; the sender should know rather than be told it went in.
    if (started.kind === "steered" && started.status === "stale")
      return yield* reject(409, "session_unavailable");
    yield* credential.recordDelivery({
      id: delivery,
      connection: name,
      outcome: "accepted",
      session: started.id,
    });
    return yield* HttpServerResponse.json({
      status: "accepted",
      session: started.id,
      steered: started.kind === "steered",
    });
  });
}
