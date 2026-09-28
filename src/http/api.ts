import { Effect, Exit, Result, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import type * as Cloudflare from "alchemy/Cloudflare";
import { fixtureRepo } from "../../protocol/supervisor.js";
import { defaultBranch } from "./repository.js";
import {
  instructionsKey,
  maxInstructionBytes,
  maxSkillBytes,
  readSkill,
  sha256,
  skillKey,
  skillName,
} from "../settings/skill.js";

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
  /^\/api\/sessions\/([a-z0-9-]{6,32})(?:\/(steer|interrupt|stop|resume|conversation|log|hatch\/(\d{1,5})|files\/([a-f0-9]{32})))?$/;
const GitHubToken = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{20,255}$/)),
});
const githubHint = "scotty auth login github";
const Instructions = Schema.Struct({
  text: Schema.String.check(
    Schema.makeFilter((text) => new TextEncoder().encode(text).byteLength <= maxInstructionBytes, {
      expected: "at most 64 KiB of UTF-8 text",
    }),
  ),
});
const SkillSwitch = Schema.Struct({ enabled: Schema.Boolean });
const skillPath = /^\/api\/skills\/([^/]+)$/;

const bad = (message: string, status = 400, hint?: string) =>
  HttpServerResponse.json(
    { error: { message, code: status === 404 ? "not_found" : "bad_request", hint } },
    { status },
  );

type ByteRange = { offset: number; length?: number } | { suffix: number };

// One `bytes=a-b`, `bytes=a-` or `bytes=-n` range; anything else is served whole, as RFC 9110 allows.
const byteRange = (header: string | undefined): ByteRange | undefined => {
  const parts = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (parts === null) return undefined;
  const [, first = "", last = ""] = parts;
  if (first === "") return last === "" ? undefined : { suffix: Number(last) };
  const offset = Number(first);
  if (last === "") return { offset };
  return Number(last) < offset ? undefined : { offset, length: Number(last) - offset + 1 };
};

// The start and length R2 serves for that range, clamped to the object.
const served = (range: ByteRange | undefined, size: number) => {
  if (range === undefined) return [0, size] as const;
  if ("suffix" in range)
    return [Math.max(0, size - range.suffix), Math.min(range.suffix, size)] as const;
  return [
    range.offset,
    Math.min(range.length ?? size - range.offset, size - range.offset),
  ] as const;
};

// Port 7000 is the supervisor's; a preview never reaches it.
export const hatchPort = (port: number) =>
  Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 7000;
export const hatchHost = (base: string, port: number, id: string) => `${port}-${id}.${base}`;

export function apiHandler(
  request: HttpServerRequest.HttpServerRequest,
  sessions: Cloudflare.DurableObject<SessionObject>,
  credentials: Cloudflare.DurableObject<CredsObject>,
  bucket: Cloudflare.R2.ReadWriteBucketClient,
  hatchBase: string,
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
    if (url.pathname === "/api/credentials/github" && request.method === "GET")
      return yield* HttpServerResponse.json(yield* credential.gitHubStatus());
    if (url.pathname === "/api/credentials/github" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(GitHubToken)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", () => bad("Expected a GitHub token", 400, githubHint)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      const result = yield* credential.setGitHub(body.token);
      if (result.status === "refused")
        return yield* bad(`GitHub answered HTTP ${result.httpStatus}`, 400, githubHint);
      return yield* HttpServerResponse.json(result);
    }
    if (url.pathname === "/api/settings" && request.method === "GET") {
      const saved = yield* bucket.get(instructionsKey);
      return yield* HttpServerResponse.json({
        instructions: saved === null ? "" : yield* saved.text(),
        skills: yield* credential.skills(),
        email: request.headers["cf-access-authenticated-user-email"] ?? null,
      });
    }
    if (url.pathname === "/api/settings/instructions" && request.method === "PUT") {
      const body = yield* Schema.decodeUnknownEffect(Instructions)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", () => bad("Instructions must be at most 64 KiB of text")),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      if (body.text.trim() === "") yield* bucket.delete(instructionsKey);
      else yield* bucket.put(instructionsKey, body.text);
      return yield* HttpServerResponse.json({ saved: true });
    }
    if (url.pathname === "/api/skills" && request.method === "PUT") {
      if (Number(request.headers["content-length"] ?? maxSkillBytes + 1) > maxSkillBytes)
        return yield* bad("A skill zip must be at most 5 MiB", 413);
      const zip = new Uint8Array(yield* request.arrayBuffer);
      if (zip.byteLength > maxSkillBytes)
        return yield* bad("A skill zip must be at most 5 MiB", 413);
      const skill = yield* Effect.promise(() => readSkill(zip));
      if (typeof skill === "string") return yield* bad(skill);
      const digest = yield* Effect.promise(() => sha256(zip));
      yield* bucket.put(skillKey(skill.name), zip);
      yield* credential.putSkill({ ...skill, sha256: digest, size: zip.byteLength });
      return yield* HttpServerResponse.json({ ...skill, sha256: digest, size: zip.byteLength });
    }
    const skillMatch = skillPath.exec(url.pathname);
    if (skillMatch !== null) {
      const name = skillMatch[1] ?? "";
      if (!skillName.test(name)) return yield* bad("Not found", 404);
      if (request.method === "PATCH") {
        const body = yield* Schema.decodeUnknownEffect(SkillSwitch)(yield* request.json).pipe(
          Effect.catchTag("SchemaError", () => bad("Expected {enabled: true|false}")),
        );
        if (HttpServerResponse.isHttpServerResponse(body)) return body;
        if (!(yield* credential.setSkill(name, body.enabled))) return yield* bad("Not found", 404);
        return yield* HttpServerResponse.json({ name, enabled: body.enabled });
      }
      if (request.method === "DELETE") {
        if (!(yield* credential.removeSkill(name))) return yield* bad("Not found", 404);
        yield* bucket.delete(skillKey(name));
        return yield* HttpServerResponse.json({ name, removed: true });
      }
    }
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(Create)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      const baseBranch =
        body.repo === fixtureRepo
          ? "main"
          : yield* Effect.gen(function* () {
              const token = yield* credential.gitHubToken();
              if (token === null) return yield* bad("GitHub token missing", 400, githubHint);
              return yield* defaultBranch(body.repo, token).pipe(
                Effect.catchTag("RepositoryFailure", (error) =>
                  bad(error.message, 400, githubHint),
                ),
              );
            });
      if (HttpServerResponse.isHttpServerResponse(baseBranch)) return baseBranch;
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
      // Each view may wake a cold Durable Object; one at a time, a long list outlasts the CLI.
      // A session that cannot open is left out rather than failing the whole list.
      const opened = yield* Effect.forEach(
        ids,
        (entry) => Effect.exit(sessions.getByName(entry.id).view()),
        { concurrency: 16 },
      );
      const views = opened.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : []));
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
    if (request.method === "DELETE" && subpath === undefined) {
      if (!(yield* stub.remove()))
        return yield* HttpServerResponse.json(
          {
            error: {
              message: "Session is still running",
              code: "running",
              hint: `scotty stop ${id}`,
            },
          },
          { status: 409 },
        );
      yield* credential.forget(id);
      return yield* HttpServerResponse.json({ id, removed: true });
    }
    if (request.method === "GET" && subpath === "conversation")
      return yield* HttpServerResponse.json(yield* stub.conversation());
    if (request.method === "GET" && subpath === "log")
      return yield* HttpServerResponse.json(yield* stub.log());
    if (request.method === "GET" && match[3] !== undefined) {
      const port = Number(match[3]);
      if (!hatchPort(port)) return yield* bad("Port must be 1024–65535 and not 7000");
      const { session } = yield* stub.view();
      if (session.authority.kind !== "stable" || session.authority.lifecycle !== "running")
        return yield* HttpServerResponse.json(
          {
            error: {
              message: "Session is not running",
              code: "not_running",
              hint: `scotty resume ${id}`,
            },
          },
          { status: 409 },
        );
      return yield* HttpServerResponse.json({ url: `https://${hatchHost(hatchBase, port, id)}` });
    }
    if (request.method === "GET" && match[4] !== undefined) {
      // iOS Safari plays a video only when a Range request gets a 206 with Content-Length.
      const wanted = byteRange(request.headers["range"]);
      const got = yield* bucket
        .get(`files/${id}/${match[4]}`, wanted === undefined ? {} : { range: wanted })
        .pipe(Effect.result);
      if (Result.isFailure(got))
        return yield* wanted === undefined
          ? bad("Could not read the file", 502)
          : bad("Range not satisfiable", 416);
      const object = got.success;
      if (object === null) return yield* bad("Not found", 404);
      const [start, length] = served(wanted, object.size);
      const status = wanted === undefined ? 200 : 206;
      const headers = {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "accept-ranges": "bytes",
        ...(status === 206
          ? { "content-range": `bytes ${start}-${start + length - 1}/${object.size}` }
          : {}),
      };
      // A stream is sent chunked, without the Content-Length Safari needs; files are at most 25 MB.
      const bytes = yield* object.bytes().pipe(Effect.orDie);
      return HttpServerResponse.uint8Array(bytes, { status, headers });
    }
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
