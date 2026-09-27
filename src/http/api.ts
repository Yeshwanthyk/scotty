import { Effect, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import type * as Cloudflare from "alchemy/Cloudflare";
import { defaultBranch } from "./repository.js";

const Prompt = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256 * 1024),
  Schema.makeFilter((text) => new TextEncoder().encode(text).byteLength <= 256 * 1024, {
    expected: "at most 256 KiB of UTF-8 text",
  }),
);

const Create = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  prompt: Prompt,
  provider: Schema.Literal("cloudflare"),
});
const Steer = Schema.Struct({
  text: Prompt,
  turn: Schema.String,
  req: Schema.optional(Schema.String),
});
const Interrupt = Schema.Struct({ turn: Schema.String, req: Schema.optional(Schema.String) });
const path =
  /^\/api\/sessions\/([a-z0-9-]{6,32})(?:\/(steer|interrupt|stop|resume|conversation|log))?$/;
const bad = (message: string, status = 400) =>
  HttpServerResponse.json(
    { error: { message, code: status === 404 ? "not_found" : "bad_request" } },
    { status },
  );

export function apiHandler(
  request: HttpServerRequest.HttpServerRequest,
  sessions: Cloudflare.DurableObject<SessionObject>,
  credentials: Cloudflare.DurableObject<CredsObject>,
) {
  return Effect.gen(function* () {
    const url = new URL(request.url, "https://scotty.internal");
    const credential = credentials.getByName("owner");
    if (url.pathname === "/api/credentials/chatgpt" && request.method === "GET")
      return yield* HttpServerResponse.json(yield* credential.chatGptStatus());
    if (url.pathname === "/api/credentials/chatgpt/start" && request.method === "POST")
      return yield* HttpServerResponse.json(yield* credential.startChatGpt());
    if (url.pathname === "/api/credentials/chatgpt/poll" && request.method === "POST")
      return yield* HttpServerResponse.json(yield* credential.pollChatGpt());
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(Create)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      const baseBranch = yield* defaultBranch(body.repo);
      const idempotency = request.headers["idempotency-key"] ?? crypto.randomUUID();
      const id = yield* credential.reserve(idempotency, crypto.randomUUID().replaceAll("-", ""));
      const stub = sessions.getByName(id);
      const created = yield* stub.create({
        id,
        repo: body.repo,
        baseBranch,
        title: body.title,
        prompt: body.prompt,
        image: "default",
      });
      return yield* HttpServerResponse.json({
        id,
        title: created.display.title,
        branch: created.display.branch,
        provider: "cloudflare",
        status: created.authority.kind === "stable" ? created.authority.lifecycle : "booting",
        url: `/s/${id}`,
      });
    }
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      const ids = yield* credential.sessions();
      const views = yield* Effect.forEach(ids, (entry) => sessions.getByName(entry.id).view());
      return yield* HttpServerResponse.json({
        version: 1,
        sessions: views.map((view) => ({
          ...view.session,
          projection: { projectedAt: new Date().toISOString() },
        })),
      });
    }
    const match = path.exec(url.pathname);
    if (!match) return yield* bad("Not found", 404);
    const id = match[1];
    if (id === undefined) return yield* bad("Not found", 404);
    if (!(yield* credential.hasSession(id))) return yield* bad("Not found", 404);
    const stub = sessions.getByName(id);
    const subpath = match[2];
    if (request.method === "GET" && subpath === undefined)
      return yield* HttpServerResponse.json(yield* stub.view());
    if (request.method === "GET" && subpath === "conversation")
      return yield* HttpServerResponse.json(yield* stub.conversation());
    if (request.method === "GET" && subpath === "log")
      return yield* HttpServerResponse.json(yield* stub.log());
    if (request.method === "POST" && subpath === "stop")
      return yield* HttpServerResponse.json(yield* stub.stop());
    if (request.method === "POST" && subpath === "resume")
      return yield* HttpServerResponse.json(yield* stub.resume());
    if (request.method === "POST" && subpath === "steer") {
      const body = yield* Schema.decodeUnknownEffect(Steer)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      return yield* HttpServerResponse.json(
        yield* stub.request({
          kind: "prompt",
          req: body.req ?? request.headers["idempotency-key"] ?? crypto.randomUUID(),
          turn: body.turn,
          text: body.text,
        }),
      );
    }
    if (request.method === "POST" && subpath === "interrupt") {
      const body = yield* Schema.decodeUnknownEffect(Interrupt)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      return yield* HttpServerResponse.json(
        yield* stub.request({
          kind: "interrupt",
          req: body.req ?? request.headers["idempotency-key"] ?? crypto.randomUUID(),
          turn: body.turn,
          text: "",
        }),
      );
    }
    return yield* bad("Not found", 404);
  }).pipe(Effect.catch(() => bad("Request could not be completed")));
}
