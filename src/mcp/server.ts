import { RuntimeContext } from "alchemy";
import { Effect, Result, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as Cloudflare from "alchemy/Cloudflare";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import { AgentKind } from "../session/events.js";
import { Size } from "../places/place.js";
import { titleFrom } from "../session/title.js";
import { apiHandler } from "../http/api.js";
import { Prompt, Repo } from "../http/start.js";
import { version } from "../version.js";

// MCP over Streamable HTTP, stateless: each POST is one JSON-RPC message answered with JSON, so any
// Worker isolate can serve it. Access Managed OAuth signs the client in before a request gets here.
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
});
const Initialize = Schema.Struct({ protocolVersion: Schema.String });
const Call = Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Unknown) });

// The parts of the API's replies a model needs; Schema drops the rest.
const Session = Schema.Struct({
  identity: Schema.Struct({ id: Schema.String }),
  authority: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("stable"), lifecycle: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("transitioning"), action: Schema.String }),
  ]),
  display: Schema.Struct({
    title: Schema.String,
    repository: Schema.String,
    agentKind: Schema.String,
    activeAt: Schema.String,
  }),
  progress: Schema.Struct({ working: Schema.Boolean }),
});
const List = Schema.Struct({ sessions: Schema.Array(Session) });
const View = Schema.Struct({ session: Session });
const Conversation = Schema.Struct({
  currentTurn: Schema.String,
  turns: Schema.Array(
    Schema.Struct({ state: Schema.String, user: Schema.String, assistant: Schema.String }),
  ),
});
const brief = (session: typeof Session.Type) => ({
  id: session.identity.id,
  title: session.display.title,
  repo: session.display.repository,
  agent: session.display.agentKind,
  status:
    session.authority.kind === "transitioning"
      ? session.authority.action
      : session.authority.lifecycle,
  working: session.progress.working,
  activeAt: session.display.activeAt,
});

const Id = Schema.Struct({ id: Schema.String });

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };
const text = (value: string, isError?: true): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError === undefined ? {} : { isError }),
});

const rpc = (id: string | number, body: { result: unknown } | { error: unknown }) =>
  HttpServerResponse.json({ jsonrpc: "2.0", id, ...body });

export function mcpHandler(
  request: HttpServerRequest.HttpServerRequest,
  sessions: Cloudflare.DurableObject<SessionObject>,
  credentials: Cloudflare.DurableObject<CredsObject>,
  bucket: Cloudflare.R2.ReadWriteBucketClient,
  hatchBase: string,
) {
  // One API call in-process, so the tools keep the API's checks and errors.
  const api = (method: string, path: string, body?: unknown) =>
    Effect.gen(function* () {
      const web = new Request(`https://scotty.internal${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const reply = yield* apiHandler(
        HttpServerRequest.fromWeb(web),
        sessions,
        credentials,
        bucket,
        hatchBase,
      ).pipe(Effect.orDie, Effect.provide(RuntimeContext.phantom));
      const response = HttpServerResponse.toWeb(reply);
      return { ok: response.ok, text: yield* Effect.promise(() => response.text()) };
    });
  const json = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, path: string) =>
    api("GET", path).pipe(
      Effect.map((reply) =>
        reply.ok
          ? Result.mapError(
              Schema.decodeUnknownResult(Schema.fromJsonString(schema))(reply.text),
              () => text("Scotty sent a reply this server could not read", true),
            )
          : Result.fail(text(reply.text, true)),
      ),
    );
  const passThrough = (method: string, path: string, body?: unknown) =>
    api(method, path, body).pipe(
      Effect.map((reply) => (reply.ok ? text(reply.text) : text(reply.text, true))),
    );
  const turnThen = (id: string, then: (turn: string) => Effect.Effect<ToolResult>) =>
    json(Conversation, `/api/sessions/${id}/conversation`).pipe(
      Effect.flatMap((got) =>
        Result.isFailure(got) ? Effect.succeed(got.failure) : then(got.success.currentTurn),
      ),
    );

  const tool = <S extends Schema.ConstraintDecoder<unknown>>(
    name: string,
    description: string,
    input: S,
    readOnly: boolean,
    run: (args: S["Type"]) => Effect.Effect<ToolResult>,
  ) => ({
    definition: {
      name,
      description,
      inputSchema: Schema.toJsonSchemaDocument(input).schema,
      annotations: { readOnlyHint: readOnly },
    },
    call: (args: unknown) => {
      const decoded = Schema.decodeUnknownResult(input)(args ?? {});
      return Result.isFailure(decoded)
        ? Effect.succeed(text(decoded.failure.message, true))
        : run(decoded.success);
    },
  });

  const tools = [
    tool(
      "list_sessions",
      "List Scotty's coding sessions, newest activity first. `search` matches titles, repositories and prompts.",
      Schema.Struct({ search: Schema.optionalKey(Schema.String) }),
      true,
      ({ search }) =>
        json(
          List,
          `/api/sessions${search === undefined ? "" : `?q=${encodeURIComponent(search.trim())}`}`,
        ).pipe(
          Effect.map((got) =>
            Result.isFailure(got)
              ? got.failure
              : text(
                  JSON.stringify(
                    got.success.sessions
                      .map(brief)
                      .sort((a, b) => b.activeAt.localeCompare(a.activeAt)),
                  ),
                ),
          ),
        ),
    ),
    tool(
      "new_session",
      "Start a coding agent on a GitHub repository (owner/repo) with a prompt. It works in a cloud container; follow it with read_session.",
      Schema.Struct({
        repo: Repo,
        prompt: Prompt,
        agent: Schema.optionalKey(AgentKind),
        size: Schema.optionalKey(Size).annotate({
          description:
            "The container size; default standard-1 (1/2 vCPU, 4 GiB). Bigger than standard-4 needs a runner.",
        }),
        // Scotty's own e2e tests run the agent's scripted stand-in.
        scripted: Schema.optionalKey(Schema.Literal(true)).annotate({
          description: "Only for Scotty's own tests: run a scripted stand-in, not the agent.",
        }),
      }),
      false,
      ({ repo, prompt, agent, size, scripted }) =>
        passThrough("POST", "/api/sessions", {
          repo,
          prompt,
          title: titleFrom(prompt),
          provider: "cloudflare",
          ...(agent === undefined ? {} : { agent }),
          ...(size === undefined ? {} : { size }),
          ...(scripted === undefined ? {} : { scripted }),
        }),
    ),
    tool(
      "read_session",
      "Read a session's state and its last messages. `working: true` means the agent is still on the latest prompt.",
      Schema.Struct({
        id: Schema.String,
        last: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        ).annotate({ description: "How many turns to show, 1 to 50; default 1." }),
      }),
      true,
      ({ id, last }) =>
        Effect.gen(function* () {
          const view = yield* json(View, `/api/sessions/${id}`);
          if (Result.isFailure(view)) return view.failure;
          const conversation = yield* json(Conversation, `/api/sessions/${id}/conversation`);
          if (Result.isFailure(conversation)) return conversation.failure;
          return text(
            JSON.stringify({
              ...brief(view.success.session),
              turns: conversation.success.turns.slice(-(last ?? 1)),
            }),
          );
        }),
    ),
    tool(
      "steer_session",
      "Send the session's agent another prompt. If it is working, this steers the current turn.",
      Schema.Struct({ id: Schema.String, text: Prompt }),
      false,
      ({ id, text: prompt }) =>
        turnThen(id, (turn) =>
          passThrough("POST", `/api/sessions/${id}/steer`, { text: prompt, turn }),
        ),
    ),
    tool(
      "interrupt_session",
      "Stop the agent's current turn. The session stays up for more prompts.",
      Id,
      false,
      ({ id }) =>
        turnThen(id, (turn) => passThrough("POST", `/api/sessions/${id}/interrupt`, { turn })),
    ),
    tool(
      "stop_session",
      "Stop the session's container. Its work is kept; resume_session starts it again.",
      Id,
      false,
      ({ id }) => passThrough("POST", `/api/sessions/${id}/stop`),
    ),
    tool(
      "resume_session",
      "Start a stopped session's container again. A size changes its container; a running session must be stopped first.",
      Schema.Struct({
        ...Id.fields,
        size: Schema.optionalKey(Size).annotate({
          description:
            "The container size; default the session's current one. Bigger than standard-4 needs a runner.",
        }),
      }),
      false,
      ({ id, size }) =>
        passThrough(
          "POST",
          `/api/sessions/${id}/resume`,
          size === undefined ? undefined : { size },
        ),
    ),
  ];

  return Effect.gen(function* () {
    if (request.method !== "POST")
      return HttpServerResponse.text("Use POST", { status: 405, headers: { allow: "POST" } });
    const message = Schema.decodeUnknownResult(Schema.fromJsonString(Message))(yield* request.text);
    if (Result.isFailure(message))
      return yield* HttpServerResponse.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
        { status: 400 },
      );
    const { id, method, params } = message.success;
    // Notifications and responses need no answer.
    if (id === undefined || method === undefined) return HttpServerResponse.empty({ status: 202 });
    if (method === "initialize") {
      const asked = Schema.decodeUnknownResult(Initialize)(params);
      const protocolVersion =
        Result.isSuccess(asked) && versions.includes(asked.success.protocolVersion)
          ? asked.success.protocolVersion
          : versions[0];
      return yield* rpc(id, {
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "scotty", version },
        },
      });
    }
    if (method === "ping") return yield* rpc(id, { result: {} });
    if (method === "tools/list")
      return yield* rpc(id, { result: { tools: tools.map((entry) => entry.definition) } });
    if (method === "tools/call") {
      const call = Schema.decodeUnknownResult(Call)(params);
      const found = Result.isSuccess(call)
        ? tools.find((entry) => entry.definition.name === call.success.name)
        : undefined;
      if (Result.isFailure(call) || found === undefined)
        return yield* rpc(id, { error: { code: -32602, message: "Unknown tool" } });
      return yield* rpc(id, { result: yield* found.call(call.success.arguments) });
    }
    return yield* rpc(id, { error: { code: -32601, message: `Method not found: ${method}` } });
  });
}
