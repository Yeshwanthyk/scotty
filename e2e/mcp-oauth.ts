import { Effect, Schema } from "effect";
import {
  access,
  client,
  CliFailure,
  ConnectionCreated,
  ConnectionRemoved,
  Connections,
  Conversation,
  Created,
  failure,
  Log as RawLog,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { readConfig } from "../cli/config.js";
import { ConnectionAuthorization, ToolPolicy } from "../src/creds/connections.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { agent, real } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok
    ? Effect.void
    : Effect.fail(failure("mcp_oauth", message, "scotty connections --json; scotty log <id>"));
const ToolList = Schema.Struct({
  status: Schema.Literal(200),
  message: Schema.Struct({
    result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  }),
});
const Reading = Schema.Struct({
  generation: Schema.Number,
  writes: Schema.Number,
  unauthorized: Schema.Number,
});
const ReadResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.fromJsonString(Reading) }),
    ),
  }),
});
const ToolRead = Schema.Struct({ status: Schema.Literal(200), message: ReadResult });
const Refused = Schema.Struct({
  status: Schema.Literal(200),
  message: Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) }),
});
const name = `oauth-${crypto.randomUUID().slice(0, 8)}`;
const script = (method: string, tool?: string, sse = false) =>
  `call ${JSON.stringify({
    url: `http://${name}.internal/api/mcp`,
    method: "POST",
    response: "mcp",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": method,
      ...(tool === undefined ? {} : { "Mcp-Name": tool }),
      ...(sse ? { "X-Test-Sse": "yes" } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      ...(tool === undefined ? {} : { params: { name: tool, arguments: {} } }),
    }),
  })}\nsay {{out}}`;
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(() => failure("mcp_oauth", "Unexpected MCP probe response", "scotty log <id>")),
  );
const prefixes = ["mcp-oauth-access-", "mcp-oauth-refresh-"];
const noTokens = (value: unknown) =>
  check(
    prefixes.every((prefix) => !JSON.stringify(value).includes(prefix)),
    "OAuth token reached public metadata or session evidence",
  );

const program = Effect.gen(function* () {
  if (real) return yield* check(false, "This recipe uses the scripted agent; omit --real");
  const config = yield* readConfig;
  if (config?.mcpOAuthTest === undefined || config.stage === "main")
    return yield* check(false, "Configure mcpOAuthTest with an explicit host on a test stage");
  const url = yield* target(process.env.SCOTTY_URL);
  yield* check(
    new URL(url).host === config.host,
    "SCOTTY_URL must match the configured test stage",
  );
  const accessToken = yield* access(url);
  const request = client({ url, token: accessToken });
  const server = `https://${config.mcpOAuthTest.host}`;
  let session: string | undefined;
  let owned = false;
  const cleanup = Effect.gen(function* () {
    if (session !== undefined)
      yield* request(`/api/sessions/${session}/stop`, View, { method: "POST" }).pipe(Effect.ignore);
    if (owned)
      yield* request(`/api/connections/${name}`, ConnectionRemoved, { method: "DELETE" }).pipe(
        Effect.ignore,
      );
  });
  yield* Effect.gen(function* () {
    const created = yield* request("/api/connections", ConnectionCreated, {
      method: "POST",
      body: { kind: "mcp", name, url: `${server}/mcp` },
    });
    owned = true;
    yield* check(
      created.kind === "mcp" &&
        created.signIn === "signed-out" &&
        created.policy.kind === "read-only",
      "OAuth connection did not default to disconnected/read-only",
    );
    yield* noTokens(created);
    const start = yield* request(`/api/connections/${name}/connect`, ConnectionAuthorization, {
      method: "POST",
    });
    const authorization = new URL(start.authorizationUrl);
    const clientId = yield* Schema.decodeUnknownEffect(Schema.String)(
      authorization.searchParams.get("client_id"),
    );
    const configure = (mode: "unavailable" | "non-rotating" | "unauthorized") =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() =>
          fetch(`${server}/configure`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client: clientId, mode }),
          }),
        );
        yield* check(response.ok, "Could not configure the test token endpoint");
      });
    yield* check(
      authorization.origin === server &&
        authorization.searchParams.get("resource") === `${server}/mcp` &&
        authorization.searchParams.get("code_challenge_method") === "S256",
      "Discovery, resource indicator or PKCE missing",
    );
    const approved = yield* Effect.tryPromise(() => fetch(authorization, { redirect: "manual" }));
    const callback = yield* Schema.decodeUnknownEffect(Schema.String)(
      approved.headers.get("location"),
    );
    yield* check(
      new URL(callback).origin === new URL(url).origin &&
        new URL(callback).pathname === `/api/connections/${name}/callback`,
      "Wrong callback host/path",
    );
    const follow = (href: string) =>
      Effect.tryPromise(() =>
        fetch(href, { headers: { "cf-access-token": accessToken }, redirect: "manual" }),
      );
    const completed = yield* follow(callback);
    yield* check(
      completed.status === 303 && completed.headers.get("location") === "/settings/connections",
      "OAuth callback failed",
    );
    yield* check((yield* follow(callback)).status === 400, "Reused state accepted");
    const unknown = new URL(callback);
    unknown.searchParams.set("state", crypto.randomUUID());
    yield* check((yield* follow(unknown.href)).status === 400, "Unknown state accepted");
    const connected = yield* request("/api/connections", Connections);
    yield* noTokens(connected);
    yield* check(
      connected.connections.some(
        (item) => item.name === name && item.kind === "mcp" && item.signIn === "signed-in",
      ),
      "Connection did not report signed-in",
    );
    const started = yield* request("/api/sessions", Created, {
      method: "POST",
      key: crypto.randomUUID(),
      body: {
        title: `e2e MCP OAuth (${agent})`,
        repo: fixtureRepo,
        agent,
        scripted: true,
        provider: "cloudflare",
        prompt: script("tools/list"),
      },
    });
    session = started.id;
    console.log(`MCP OAuth (${agent}) session: ${session}`);
    const prefix = `/api/sessions/${session}`;
    const poll = waiter(request, prefix);
    const events = () => request(`${prefix}/log`, Log);
    const answer = (turn: string) =>
      Effect.gen(function* () {
        yield* poll(events, (log) =>
          log.some((event) => event.kind === "turn.ended" && event.turn === turn),
        );
        return (
          (yield* request(`${prefix}/conversation`, Conversation)).turns.at(-1)?.assistant ?? ""
        );
      });
    let turn = 0;
    const steer = (text: string) =>
      Effect.gen(function* () {
        const req = crypto.randomUUID();
        turn += 1;
        yield* request(`${prefix}/steer`, Reply, {
          method: "POST",
          key: req,
          body: { req, turn: String(turn), text },
        });
        return yield* answer(String(turn));
      });
    const listed = (text: string) =>
      Effect.gen(function* () {
        const value = yield* decode(ToolList, text);
        yield* check(
          value.message.result.tools.map((tool) => tool.name).join(",") === "read",
          "Disallowed tool appeared in tools/list",
        );
      });
    const read = (text: string) =>
      Effect.gen(function* () {
        const value = yield* decode(ToolRead, text);
        const reading = value.message.result.content[0]?.text;
        if (reading === undefined)
          return yield* failure("mcp_oauth", "Read tool returned no content", "scotty log <id>");
        return reading;
      });
    yield* listed(yield* answer("0"));
    yield* listed(yield* steer(script("tools/list", undefined, true)));
    const before = yield* read(yield* steer(script("tools/call", "read", true)));
    yield* check(before.writes === 0, "Unexpected upstream write");
    for (const method of ["TOOLS/call", "tools/List"])
      yield* decode(
        Refused,
        yield* steer(script(method, method === "TOOLS/call" ? "write" : undefined)),
      );
    const blocked = yield* decode(Refused, yield* steer(script("tools/call", "write")));
    yield* check(blocked.message.error.code < 0, "Blocked call was not a JSON-RPC error");
    yield* check(
      (yield* read(yield* steer(script("tools/call", "read")))).writes === 0,
      "Blocked write was forwarded",
    );
    // Both calls arrive after expiry; a rotating server rejects a second use of the refresh token.
    const callBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "refresh",
      method: "tools/call",
      params: { name: "read", arguments: {} },
    });
    const parallel = `const result = await Promise.all([1, 2].map(async () => (await fetch(${JSON.stringify(`http://${name}.internal/api/mcp`)}, {method: "POST", headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "tools/call", "Mcp-Name": "read"}, body: ${JSON.stringify(callBody)}})).json())); console.log(JSON.stringify(result));`;
    const refreshed = yield* decode(
      Schema.Array(ReadResult),
      yield* steer(`sleep 71\nrun bun -e '${parallel}'\nsay {{out}}`),
    );
    const generations = refreshed.map((result) => result.result.content[0]?.text.generation);
    yield* check(
      generations.length === 2 &&
        generations[0] !== undefined &&
        generations[0] > before.generation &&
        generations[0] === generations[1],
      "Expired token was not replaced by one shared refresh",
    );
    yield* configure("non-rotating");
    yield* configure("unavailable");
    yield* decode(
      Schema.Struct({ status: Schema.Literal(401) }),
      yield* steer(`sleep 11\n${script("tools/call", "read")}`),
    );
    yield* check(
      (yield* request("/api/connections", Connections)).connections.some(
        (item) => item.name === name && item.kind === "mcp" && item.signIn === "signed-in",
      ),
      "Transient refresh failure discarded the sign-in",
    );
    const recovered = yield* read(yield* steer(script("tools/call", "read")));
    yield* check(recovered.generation > (generations[0] ?? 0), "Refresh did not retry after 503");
    const reused = yield* read(yield* steer(`sleep 11\n${script("tools/call", "read")}`));
    yield* check(
      reused.generation > recovered.generation,
      "Omitted refresh token was not retained",
    );
    const policy = (value: typeof ToolPolicy.Type) =>
      request(
        `/api/connections/${name}/policy`,
        Schema.Struct({ name: Schema.String, policy: ToolPolicy }),
        { method: "PUT", body: value },
      );
    yield* policy({ kind: "all" });
    yield* decode(Refused, yield* steer(script("TOOLS/call", "write")));
    yield* check(
      (yield* read(yield* steer(script("tools/call", "write")))).writes === 1,
      "All policy refused a write",
    );
    yield* configure("unauthorized");
    const retried = yield* read(yield* steer(script("tools/call", "read")));
    yield* check(
      retried.generation > reused.generation && retried.unauthorized === 1,
      "Upstream 401 was not refreshed and retried once",
    );
    yield* policy({ kind: "named", tools: ["read"] });
    yield* listed(yield* steer(script("tools/list", undefined, true)));
    yield* decode(Refused, yield* steer(script("tools/call", "write")));
    const last = yield* read(yield* steer(script("tools/call", "read")));
    yield* check(last.writes === 1, "Named policy forwarded a blocked write");
    const environment = yield* steer(
      'run env; find "$HOME/.codex" "$HOME/.claude" -maxdepth 2 -type f \\( -name "config.toml" -o -name ".mcp.json" -o -name "settings.json" \\) -exec cat {} \\; 2>/dev/null; true\nsay {{out}}',
    );
    yield* noTokens(environment);
    yield* noTokens(
      yield* request(`${prefix}/conversation`, Schema.Record(Schema.String, Schema.Unknown)),
    );
    yield* noTokens(yield* request(`${prefix}/log`, RawLog));
    const invalidated = yield* Effect.tryPromise(() =>
      fetch(`${server}/invalidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId }),
      }),
    );
    yield* check(invalidated.ok, "Could not invalidate the test refresh grant");
    const failed = yield* decode(
      Schema.Struct({ status: Schema.Literal(401) }),
      yield* steer(`sleep 11\n${script("tools/call", "read")}`),
    );
    yield* check(failed.status === 401, "Failed refresh was allowed through");
    const status = yield* request("/api/connections", Connections);
    yield* check(
      status.connections.some(
        (item) => item.name === name && item.kind === "mcp" && item.signIn === "needs-sign-in",
      ),
      "Failed refresh did not require sign-in",
    );
    yield* noTokens(status);
    console.log(
      `MCP OAuth (${agent}): PKCE, single-use state, JSON/SSE policy, method casing, shared refresh, transient recovery, non-rotating grants, 401 retry and secret isolation passed`,
    );
  }).pipe(Effect.ensuring(cleanup));
});
Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "MCP OAuth e2e failed");
  process.exitCode = 1;
});
