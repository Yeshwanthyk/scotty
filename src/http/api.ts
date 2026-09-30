import { Effect, Exit, Result, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import type * as Cloudflare from "alchemy/Cloudflare";
import { AgentKind } from "../session/events.js";
import { maxSearch, SearchQuery } from "../session/search.js";
import { NewConnection, connectionView, connectionName, Key } from "../creds/connections.js";
import { githubHint, Prompt, Repo, startSession } from "./start.js";
import { automationName, AutomationName, Definition } from "../automations/automation.js";
import { fireRun, runRequest } from "../automations/fire.js";
import { version } from "../version.js";
import {
  instructionsKey,
  maxInstructionBytes,
  maxSkillBytes,
  readSkill,
  sha256,
  skillKey,
  skillName,
} from "../settings/skill.js";

const Create = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  repo: Repo,
  prompt: Prompt,
  provider: Schema.Literal("cloudflare"),
  agent: Schema.optional(AgentKind),
  // The agent's scripted stand-in, for e2e: no ChatGPT, Claude or GitHub sign-in needed.
  scripted: Schema.optional(Schema.Literal(true)),
  // A second create with the same key steers the session the first one made.
  key: Schema.optional(Key),
});
const connectionPath = /^\/api\/connections\/([^/]+)$/;
const RequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((id) => id.trim() !== "" && !id.startsWith("initial:"), {
    expected: "a non-blank request id that does not start with initial:",
  }),
);
const decodeRequestId = Schema.decodeUnknownEffect(RequestId);
const Steer = Schema.Struct({
  text: Prompt,
  turn: Schema.String,
  req: Schema.optional(RequestId),
});
const Interrupt = Schema.Struct({ turn: Schema.String, req: Schema.optional(RequestId) });
const path =
  /^\/api\/sessions\/([a-z0-9-]{6,32})(?:\/(steer|interrupt|stop|resume|conversation|log|hatch\/(\d{1,5})|files\/([a-f0-9]{32})))?$/;
const GitHubToken = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{20,255}$/)),
});
const ClaudeToken = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^sk-ant-oat01-[A-Za-z0-9_-]{20,300}$/)),
});
const claudeHint = "scotty login claude";
const Instructions = Schema.Struct({
  text: Schema.String.check(
    Schema.makeFilter((text) => new TextEncoder().encode(text).byteLength <= maxInstructionBytes, {
      expected: "at most 64 KiB of UTF-8 text",
    }),
  ),
});
const SkillSwitch = Schema.Struct({ enabled: Schema.Boolean });
const skillPath = /^\/api\/skills\/([^/]+)$/;
const NewAutomation = Schema.Struct({ name: AutomationName, ...Definition.fields });
const AutomationSwitch = Schema.Struct({ enabled: Schema.Boolean });
const automationPath = /^\/api\/automations\/([^/]+)(\/run)?$/;
const definitionHint =
  "when is {kind: calendar, cron, tz} | {kind: interval, minutes} | {kind: event, connection}";

const bad = (message: string, status = 400, hint?: string) =>
  HttpServerResponse.json(
    { error: { message, code: status === 404 ? "not_found" : "bad_request", hint } },
    { status },
  );

const idempotencyKey = (header: string | undefined) =>
  decodeRequestId(header ?? crypto.randomUUID()).pipe(
    Effect.catchTag("SchemaError", () =>
      bad(
        "Idempotency-Key must be non-blank, at most 256 characters, and must not start with initial:",
      ),
    ),
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
const hatchHost = (base: string, port: number, id: string) => `${port}-${id}.${base}`;

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
    if (url.pathname === "/api/credentials/claude" && request.method === "GET")
      return yield* HttpServerResponse.json(yield* credential.claudeStatus());
    if (url.pathname === "/api/credentials/claude" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(ClaudeToken)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", () =>
          bad("Expected a token from claude setup-token (sk-ant-oat01-…)", 400, claudeHint),
        ),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      return yield* HttpServerResponse.json(yield* credential.setClaude(body.token));
    }
    if (url.pathname === "/api/version" && request.method === "GET")
      return yield* HttpServerResponse.json({ version });
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
    const origin = `https://${request.headers["host"] ?? ""}`;
    if (url.pathname === "/api/connections" && request.method === "GET")
      return yield* HttpServerResponse.json({
        connections: (yield* credential.connections()).map((connection) =>
          connectionView(connection, origin),
        ),
      });
    if (url.pathname === "/api/connections" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(NewConnection)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", () =>
          bad(
            "Expected a named webhook, token {host, header, secret}, or mcp {url, secret}; use an HTTPS target and a non-reserved lowercase name",
          ),
        ),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      const added = yield* credential.addConnection(body);
      if (added.status === "exists")
        return yield* HttpServerResponse.json(
          {
            error: {
              message: `A connection named ${body.name} exists`,
              code: "exists",
              hint: `scotty connections`,
            },
          },
          { status: 409 },
        );
      return yield* HttpServerResponse.json({
        ...connectionView(added, origin),
        ...(added.kind === "webhook" ? { secret: added.secret } : {}),
      });
    }
    const connectionMatch = connectionPath.exec(url.pathname);
    if (connectionMatch !== null && request.method === "DELETE") {
      const name = connectionMatch[1] ?? "";
      if (!connectionName.test(name) || !(yield* credential.removeConnection(name)))
        return yield* bad("Not found", 404);
      return yield* HttpServerResponse.json({ name, removed: true });
    }
    if (url.pathname === "/api/deliveries" && request.method === "GET") {
      const connection = url.searchParams.get("connection") ?? undefined;
      if (connection !== undefined && !connectionName.test(connection))
        return yield* bad("Not a connection name");
      return yield* HttpServerResponse.json({
        deliveries: yield* credential.deliveries(connection),
      });
    }
    if (url.pathname === "/api/automations" && request.method === "GET")
      return yield* HttpServerResponse.json({ automations: yield* credential.automations() });
    if (url.pathname === "/api/automations" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(NewAutomation)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message, 400, definitionHint)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      const { name, ...definition } = body;
      if (!(yield* credential.putAutomation(name, definition, false)))
        return yield* HttpServerResponse.json(
          {
            error: {
              message: `An automation named ${name} exists`,
              code: "exists",
              hint: "scotty automation ls",
            },
          },
          { status: 409 },
        );
      return yield* HttpServerResponse.json({ name, enabled: false }, { status: 201 });
    }
    const automationMatch = automationPath.exec(url.pathname);
    if (automationMatch !== null) {
      const name = automationMatch[1] ?? "";
      if (!automationName.test(name)) return yield* bad("Not found", 404);
      if (automationMatch[2] !== undefined && request.method === "POST") {
        const run = yield* credential.runAutomation(name);
        if (run === null) return yield* bad("Not found", 404);
        const outcome =
          run.status === "received" ? yield* fireRun(sessions, credential, run.id) : null;
        return yield* HttpServerResponse.json({
          id: run.id,
          automation: run.automation,
          status: outcome?.status ?? run.status,
          reason: outcome === null ? run.reason : (outcome.reason ?? null),
          session: outcome === null ? run.session : (outcome.session ?? null),
        });
      }
      if (automationMatch[2] === undefined && request.method === "PUT") {
        const body = yield* Schema.decodeUnknownEffect(Definition)(yield* request.json).pipe(
          Effect.catchTag("SchemaError", (error) => bad(error.message, 400, definitionHint)),
        );
        if (HttpServerResponse.isHttpServerResponse(body)) return body;
        if (!(yield* credential.putAutomation(name, body, true)))
          return yield* bad("Not found", 404);
        return yield* HttpServerResponse.json({ name, enabled: false });
      }
      if (automationMatch[2] === undefined && request.method === "PATCH") {
        const body = yield* Schema.decodeUnknownEffect(AutomationSwitch)(yield* request.json).pipe(
          Effect.catchTag("SchemaError", () => bad("Expected {enabled: true|false}")),
        );
        if (HttpServerResponse.isHttpServerResponse(body)) return body;
        if (!(yield* credential.enableAutomation(name, body.enabled)))
          return yield* bad("Not found", 404);
        return yield* HttpServerResponse.json({ name, enabled: body.enabled });
      }
      if (automationMatch[2] === undefined && request.method === "DELETE") {
        if (!(yield* credential.removeAutomation(name))) return yield* bad("Not found", 404);
        return yield* HttpServerResponse.json({ name, removed: true });
      }
    }
    // Each run that reached a session carries how its turn went, read from that session.
    if (url.pathname === "/api/runs" && request.method === "GET") {
      const automation = url.searchParams.get("automation") ?? undefined;
      if (automation !== undefined && !automationName.test(automation))
        return yield* bad("Not an automation name");
      const runs = yield* credential.runs(automation);
      return yield* HttpServerResponse.json({
        runs: yield* Effect.forEach(
          runs,
          (run) =>
            Effect.gen(function* () {
              const outcome =
                run.session !== null && (run.status === "started" || run.status === "steered")
                  ? yield* sessions
                      .getByName(run.session)
                      .outcome(run.status === "steered" ? runRequest(run.id) : undefined)
                  : null;
              return { ...run, outcome };
            }),
          { concurrency: 16 },
        ),
      });
    }
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const retry = yield* idempotencyKey(request.headers["idempotency-key"]);
      if (HttpServerResponse.isHttpServerResponse(retry)) return retry;
      const body = yield* Schema.decodeUnknownEffect(Create)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      const started = yield* startSession(sessions, credential, {
        repo: body.repo,
        prompt: body.prompt,
        title: body.title,
        agent: body.agent ?? "codex",
        place: body.provider,
        ...(body.scripted === true ? { scripted: true } : {}),
        ...(body.key === undefined
          ? {}
          : { key: body.key, origin: { kind: "api", key: body.key } }),
        retry,
      });
      if (started.kind === "refused") return yield* bad(started.message, 400, started.hint);
      if (started.kind === "conflict")
        return yield* HttpServerResponse.json(
          {
            error: {
              message:
                "That key or idempotency key belongs to a session for another repository, agent or prompt",
              code: "key_conflict",
              hint: `scotty read ${started.id}`,
            },
          },
          { status: 409 },
        );
      if (started.kind === "unavailable")
        return yield* HttpServerResponse.json(
          {
            error: {
              message: "The session for that key is not taking prompts",
              code: "session_unavailable",
              hint: `scotty read ${started.id}`,
            },
          },
          { status: 409 },
        );
      const created = started.session;
      return yield* HttpServerResponse.json({
        id: started.id,
        title: created.display.title,
        branch: created.display.branch,
        provider: created.display.place,
        status: created.authority.kind === "stable" ? created.authority.lifecycle : "booting",
        url: `/s/${started.id}`,
        steered: started.kind === "steered",
      });
    }
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      const searched = Schema.decodeUnknownExit(SearchQuery)(
        (url.searchParams.get("q") ?? "").trim(),
      );
      if (Exit.isFailure(searched))
        return yield* bad(`Search text is at most ${maxSearch} characters`, 400);
      const query = searched.value;
      const ids = query === "" ? yield* credential.sessions() : yield* credential.search(query);
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
      const retry = yield* idempotencyKey(request.headers["idempotency-key"]);
      if (HttpServerResponse.isHttpServerResponse(retry)) return retry;
      const body = yield* Schema.decodeUnknownEffect(Steer)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      return yield* HttpServerResponse.json(
        yield* stub.request({
          kind: "prompt",
          req: body.req ?? retry,
          turn: body.turn,
          text: body.text,
        }),
      );
    }
    if (request.method === "POST" && subpath === "interrupt") {
      const retry = yield* idempotencyKey(request.headers["idempotency-key"]);
      if (HttpServerResponse.isHttpServerResponse(retry)) return retry;
      const body = yield* Schema.decodeUnknownEffect(Interrupt)(yield* request.json).pipe(
        Effect.catchTag("SchemaError", (error) => bad(error.message)),
      );
      if (HttpServerResponse.isHttpServerResponse(body)) return body;
      return yield* HttpServerResponse.json(
        yield* stub.request({
          kind: "interrupt",
          req: body.req ?? retry,
          turn: body.turn,
          text: "",
        }),
      );
    }
    return yield* bad("Not found", 404);
  }).pipe(Effect.catch(() => bad("Request could not be completed")));
}
