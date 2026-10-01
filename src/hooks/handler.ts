import { Effect, Option, Schema, Stream } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as Cloudflare from "alchemy/Cloudflare";
import { connectionName, type DeliveryReason, Key } from "../creds/connections.js";
import type CredsObject from "../creds/object.js";
import type { DeliveryVerification } from "../creds/object.js";
import { AgentKind } from "../session/events.js";
import type SessionObject from "../session/object.js";
import { Prompt, Repo, startSession } from "../http/start.js";
import { titleFrom } from "../session/title.js";
import { automationDelivery } from "../automations/fire.js";
import { maxBodyBytes, readDelivery, SigningValues } from "./signature.js";

export const hookPath = /^\/hooks\/([^/]+)$/;

const Payload = Schema.Struct({
  repo: Repo,
  prompt: Prompt,
  key: Schema.optional(Key),
  agent: Schema.optional(AgentKind),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  // The agent's scripted stand-in, for e2e, as on the API.
  scripted: Schema.optional(Schema.Literal(true)),
});
const decodePayload = Schema.decodeUnknownEffect(Payload);
const decodeEventPayload = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

// A sender sees only the status and a code; the details are in `scotty deliveries`.
const refuse = (status: number, code: string) =>
  HttpServerResponse.json({ error: { code, message: code.replaceAll("_", " ") } }, { status });
const refusalStatus: Record<
  Exclude<DeliveryVerification, "ok" | "own_github_identity"> | "missing_headers" | "bad_body",
  number
> = {
  unknown_connection: 404,
  missing_headers: 400,
  bad_body: 400,
  bad_signature: 401,
  stale_timestamp: 401,
};

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
    if (!connectionName.test(name)) return yield* refuse(404, "unknown_connection");
    if (request.method !== "POST") return yield* refuse(405, "use_post");
    const config = yield* credential.inboundConfig(name);
    let delivery = "";
    const reject = (status: number, reason: typeof DeliveryReason.Type) =>
      credential
        .recordDelivery({ id: delivery, connection: name, outcome: "rejected", reason })
        .pipe(Effect.andThen(refuse(status, reason)));
    if (config === null) return yield* reject(404, "unknown_connection");
    // Reads until the cap is passed and stops there; Content-Length is the sender's claim only.
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* request.stream.pipe(
      Stream.takeWhile((chunk) => {
        size += chunk.byteLength;
        chunks.push(chunk);
        return size <= maxBodyBytes;
      }),
      Stream.runDrain,
    );
    if (size > maxBodyBytes) {
      if (config.delivery.kind === "header")
        delivery = Option.getOrElse(
          Schema.decodeUnknownOption(SigningValues.fields.id)(
            request.headers[config.delivery.name.toLowerCase()],
          ),
          () => "",
        );
      return yield* reject(413, "too_large");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoded = readDelivery(config, request.headers, bytes);
    if (decoded.verdict !== "ok") {
      delivery = decoded.id;
      return yield* reject(refusalStatus[decoded.verdict], decoded.verdict);
    }
    delivery = decoded.values.id;
    const verdict = yield* credential.verifyDelivery({
      connection: name,
      values: decoded.values,
      body: bytes,
      payload: decoded.payload,
    });
    if (verdict === "own_github_identity") {
      yield* credential.recordDelivery({
        id: delivery,
        connection: name,
        outcome: "skipped",
        reason: verdict,
      });
      return yield* HttpServerResponse.json({ status: "skipped", reason: verdict });
    }
    if (verdict !== "ok") return yield* reject(refusalStatus[verdict], verdict);
    let json: unknown = decoded.payload;
    if (config.event !== null && config.event.kind === "header") {
      const payload = decodeEventPayload(json);
      if (Option.isNone(payload)) return yield* reject(400, "bad_body");
      json = { ...payload.value, event: decoded.values.event };
    }
    // A connection that automations listen on hands its deliveries to them.
    const automated = yield* automationDelivery(
      sessions,
      credential,
      name,
      delivery,
      json,
      config.unhandled,
    );
    if (automated !== undefined) return automated;
    const payload = yield* decodePayload(json).pipe(Effect.option);
    if (Option.isNone(payload)) return yield* reject(400, "bad_body");
    const { repo, prompt, key, agent, title, scripted } = payload.value;
    const started = yield* startSession(sessions, credential, {
      repo,
      prompt,
      title: title ?? titleFrom(prompt),
      agent: agent ?? "codex",
      ...(scripted === true ? { scripted } : {}),
      ...(key === undefined ? {} : { key }),
      // A retried delivery is answered with what the first one did.
      retry: `hook:${name}:${delivery}`,
      origin: {
        kind: "hook",
        connection: name,
        delivery,
        ...(key === undefined ? {} : { key }),
      },
    });
    if (started.kind === "refused")
      return yield* reject(started.code === "repository_not_found" ? 422 : 502, started.code);
    if (started.kind === "conflict") return yield* reject(409, "key_conflict");
    // A session that took no prompt (failed, or its turn moved on): the sender should know.
    if (started.kind === "unavailable") return yield* reject(409, "session_unavailable");
    const duplicate = started.kind === "duplicate";
    yield* credential.recordDelivery({
      id: delivery,
      connection: name,
      outcome: duplicate ? "duplicate" : "accepted",
      session: started.id,
    });
    return yield* HttpServerResponse.json(
      duplicate
        ? { status: "duplicate", session: started.id }
        : { status: "accepted", session: started.id, steered: started.kind === "steered" },
    );
  });
}
