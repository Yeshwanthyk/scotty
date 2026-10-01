import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type CredsObject from "./object.js";
import { ToolPolicy } from "./connections.js";

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;
const Id = Schema.Union([Schema.String, Schema.Number, Schema.Null]);
const Rpc = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.optionalKey(Id),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
    rest,
  ),
  Schema.StructWithRest(
    Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Id, result: Schema.Unknown }),
    rest,
  ),
  Schema.StructWithRest(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Id,
      error: Schema.StructWithRest(
        Schema.Struct({ code: Schema.Number, message: Schema.String }),
        rest,
      ),
    }),
    rest,
  ),
]);
const Request = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Id),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const CallParams = Schema.Struct({ name: Schema.String });
const Tools = Schema.StructWithRest(
  Schema.Struct({
    tools: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Record(Schema.String, Schema.Unknown),
          annotations: Schema.optionalKey(
            Schema.StructWithRest(
              Schema.Struct({ readOnlyHint: Schema.optionalKey(Schema.Boolean) }),
              rest,
            ),
          ),
        }),
        rest,
      ),
    ),
    nextCursor: Schema.optionalKey(Schema.String),
  }),
  rest,
);
const ToolResult = Schema.StructWithRest(
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Id, result: Tools }),
  rest,
);
const ListShape = Schema.Struct({ result: Schema.Struct({ tools: Schema.Json }) });
class McpProxyFailure extends Schema.TaggedError<McpProxyFailure>()("McpProxyFailure", {}) {}
const allowed = (policy: typeof ToolPolicy.Type, tool: (typeof Tools.Type)["tools"][number]) =>
  policy.kind === "all" ||
  (policy.kind === "named"
    ? policy.tools.includes(tool.name)
    : tool.annotations?.readOnlyHint === true);

const filterMessage = (rpc: typeof Rpc.Type, policy: typeof ToolPolicy.Type) => {
  if (Option.isNone(Schema.decodeUnknownOption(ListShape)(rpc))) return rpc;
  const list = Schema.decodeUnknownSync(ToolResult)(rpc);
  return {
    ...list,
    result: { ...list.result, tools: list.result.tools.filter((tool) => allowed(policy, tool)) },
  };
};

// SSE callbacks are a stream host boundary. Keep event IDs and comments; rewrite only MCP data.
const mcpStream = (
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  message: (value: typeof Rpc.Type) => unknown,
) => {
  let buffer = "";
  let lines: string[] = [];
  const frame = () => {
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.join("\n").trim() === "") return `${lines.join("\n")}\n\n`;
    const value = Schema.decodeUnknownSync(Schema.fromJsonString(Rpc))(data.join("\n"));
    const output = [
      ...lines.filter((line) => !line.startsWith("data:")),
      `data: ${JSON.stringify(message(value))}`,
    ];
    return `${output.join("\n")}\n\n`;
  };
  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          try {
            buffer += chunk;
            for (;;) {
              const ending = /\r\n|\r|\n/.exec(buffer);
              if (ending === null || (ending[0] === "\r" && ending.index === buffer.length - 1))
                break;
              const line = buffer.slice(0, ending.index);
              buffer = buffer.slice(ending.index + ending[0].length);
              if (line !== "") lines.push(line);
              else {
                controller.enqueue(frame());
                lines = [];
              }
            }
          } catch {
            controller.error(new McpProxyFailure({}));
          }
        },
        flush() {
          // SSE dispatches only complete events. An incomplete tail must not bypass filtering.
          buffer = "";
          lines = [];
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
};

const readTools = async (response: Response, id: string) => {
  if (!response.ok) {
    await response.body?.cancel();
    throw new McpProxyFailure({});
  }
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    const list = Schema.decodeUnknownSync(ToolResult)(await response.json());
    if (list.id !== id) throw new McpProxyFailure({});
    return list.result;
  }
  if (
    !(response.headers.get("content-type") ?? "").includes("text/event-stream") ||
    response.body === null
  )
    throw new McpProxyFailure({});
  let found: typeof Tools.Type | undefined;
  const reader = mcpStream(response.body, (value) => {
    const list = Schema.decodeUnknownOption(ToolResult)(value);
    if (Option.isSome(list) && list.value.id === id) found = list.value.result;
    return value;
  }).getReader();
  try {
    while (found === undefined) {
      if ((await reader.read()).done) throw new McpProxyFailure({});
    }
    return found;
  } finally {
    await reader.cancel();
  }
};
const readOnly = (target: URL, headers: Headers, name: string, signal: AbortSignal) =>
  Effect.tryPromise({
    try: async () => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        const id = crypto.randomUUID();
        const listHeaders = new Headers(headers);
        listHeaders.set("Content-Type", "application/json");
        listHeaders.set("Accept", "application/json, text/event-stream");
        const response = await fetch(target, {
          method: "POST",
          headers: listHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/list",
            ...(cursor === undefined ? {} : { params: { cursor } }),
          }),
          signal,
          redirect: "manual",
        });
        const list = await readTools(response, id);
        const tool = list.tools.find((tool) => tool.name === name);
        if (tool !== undefined) return tool.annotations?.readOnlyHint === true;
        if (list.nextCursor === undefined || seen.has(list.nextCursor)) return false;
        cursor = list.nextCursor;
        seen.add(cursor);
      }
    },
    catch: () => new McpProxyFailure({}),
  });
const filtered = (upstream: Response, policy: typeof ToolPolicy.Type) =>
  Effect.tryPromise({
    try: async () => {
      if (policy.kind === "all") return upstream;
      const headers = new Headers(upstream.headers);
      const type = headers.get("content-type") ?? "";
      if (!upstream.ok || upstream.body === null) return upstream;
      headers.delete("content-length");
      headers.delete("content-encoding");
      if (type.includes("application/json"))
        return new Response(
          JSON.stringify(
            filterMessage(Schema.decodeUnknownSync(Rpc)(await upstream.json()), policy),
          ),
          {
            status: upstream.status,
            headers,
          },
        );
      if (type.includes("text/event-stream"))
        return new Response(
          mcpStream(upstream.body, (value) => filterMessage(value, policy)),
          { status: upstream.status, headers },
        );
      await upstream.body.cancel();
      throw new McpProxyFailure({});
    },
    catch: () => new McpProxyFailure({}),
  });
const refused = (id: typeof Id.Type, message: string) =>
  HttpServerResponse.json({ jsonrpc: "2.0", id, error: { code: -32600, message } });
const dropped =
  "host authorization proxy-authorization cookie x-api-key x-auth-token x-github-token x-forwarded-for connection keep-alive proxy-connection te trailer transfer-encoding upgrade".split(
    " ",
  );
const clean = (incoming: Headers) => {
  const headers = new Headers(incoming);
  for (const name of (headers.get("connection") ?? "").split(","))
    if (name.trim() !== "") headers.delete(name.trim());
  for (const name of dropped) headers.delete(name);
  return headers;
};

export const reachHandler = (
  request: HttpServerRequest.HttpServerRequest,
  connection: string,
  credentials: Cloudflare.DurableObject<CredsObject>,
) =>
  Effect.gen(function* () {
    const incoming = new URL(request.url, "http://connection.internal");
    const credential = yield* credentials.getByName("owner").reachCredential(connection);
    if (credential === null) return HttpServerResponse.text("Not found\n", { status: 404 });
    const config = credential.config;
    const base = config.kind === "token" ? "/api/" : "/api/mcp";
    if (
      !(
        incoming.pathname === base ||
        incoming.pathname.startsWith(base.endsWith("/") ? base : `${base}/`)
      )
    )
      return HttpServerResponse.text("Not found\n", { status: 404 });
    if (config.kind === "mcp" && !["GET", "POST", "DELETE"].includes(request.method))
      return HttpServerResponse.text("Use GET, POST or DELETE\n", { status: 405 });
    if (config.kind === "mcp" && credential.secret === "")
      return HttpServerResponse.text("Connect this MCP server in Settings\n", { status: 401 });
    const target = new URL(config.kind === "token" ? `https://${config.host}/` : config.url);
    const suffix = incoming.pathname.slice(base.length);
    target.pathname =
      config.kind === "token"
        ? `/${suffix}`
        : suffix === ""
          ? target.pathname
          : `${target.pathname.replace(/\/$/, "")}${suffix}`;
    for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
    const raw = yield* HttpServerRequest.toWeb(request);
    const headers = clean(raw.headers);
    const [name = "authorization", scheme] = (
      config.kind === "token" ? config.header : "Authorization: Bearer"
    ).split(": ");
    headers.set(name, scheme === undefined ? credential.secret : `${scheme} ${credential.secret}`);
    let body: BodyInit | null = raw.body;
    if (config.kind === "mcp" && config.policy.kind !== "all" && request.method === "POST") {
      const text = yield* Effect.tryPromise(() => raw.text());
      const rpc = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Request))(text);
      body = text;
      if (rpc.method === "tools/call") {
        const params = yield* Schema.decodeUnknownEffect(CallParams)(rpc.params);
        const permits =
          config.policy.kind === "named"
            ? config.policy.tools.includes(params.name)
            : yield* readOnly(target, headers, params.name, raw.signal);
        if (!permits)
          return yield* refused(rpc.id ?? null, "Tool is outside this connection's policy");
      }
      headers.delete("content-length");
    }
    const response = yield* Effect.tryPromise(() =>
      fetch(target, {
        method: request.method,
        headers,
        body,
        signal: raw.signal,
        redirect: "manual",
      }),
    );
    if (config.kind === "mcp" && response.status === 401)
      yield* credentials.getByName("owner").mcpUnauthorized(connection, credential.secret);
    const upstream = config.kind === "mcp" ? yield* filtered(response, config.policy) : response;
    const responseHeaders = new Headers(upstream.headers);
    for (const name of (responseHeaders.get("connection") ?? "").split(","))
      if (name.trim() !== "") responseHeaders.delete(name.trim());
    for (const name of [
      "connection",
      "keep-alive",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "set-cookie",
    ])
      responseHeaders.delete(name);
    return HttpServerResponse.fromWeb(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
    );
  }).pipe(
    Effect.catchTags({
      UnknownError: () => Effect.succeed(HttpServerResponse.text("Bad gateway\n", { status: 502 })),
      McpProxyFailure: () =>
        Effect.succeed(HttpServerResponse.text("Cannot verify MCP tools\n", { status: 502 })),
      SchemaError: () =>
        HttpServerResponse.json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP message" } },
          { status: 400 },
        ),
    }),
  );
