import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Effect, Schema } from "effect";
import { access, CliFailure, failure, target } from "../cli/client.js";
import { prompt, sessionAgent } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";

// Scotty's own MCP server, driven by the official MCP client the way claude.ai or Claude Code
// would, but with a cloudflared Access token in place of the OAuth sign-in.
const Created = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const Read = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    working: Schema.Boolean,
    turns: Schema.Array(
      Schema.Struct({ state: Schema.String, user: Schema.String, assistant: Schema.String }),
    ),
  }),
);
const Listed = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })));
const tools = [
  "list_sessions",
  "new_session",
  "read_session",
  "steer_session",
  "interrupt_session",
  "stop_session",
  "resume_session",
];

const fail = (message: string) => failure("scotty-mcp", message, "scotty doctor");
const check = (ok: boolean, message: string) => (ok ? Effect.void : Effect.fail(fail(message)));
const attempt = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => fail(`${what}: ${error instanceof Error ? error.message : "failed"}`),
  });

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const endpoint = new URL("/mcp", url);

  // 1. Without a token, Access answers for Managed OAuth: a 401 that points a client at sign-in.
  const bare = yield* attempt("unauthenticated POST", () =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      redirect: "manual",
    }),
  );
  yield* check(
    bare.status === 401 && bare.headers.get("www-authenticate") !== null,
    `An unauthenticated client got ${bare.status}, not a 401 with WWW-Authenticate`,
  );

  // 2. Signed in, the client initializes and sees every tool.
  const token = yield* access(endpoint.href);
  const mcp = new Client({ name: "scotty-e2e", version: "1.0.0" });
  yield* attempt("connect", () =>
    mcp.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { "cf-access-token": token } },
      }),
    ),
  );
  const listed = yield* attempt("tools/list", () => mcp.listTools());
  const names = listed.tools.map((tool) => tool.name);
  yield* check(
    tools.every((name) => names.includes(name)),
    `tools/list returned ${names.join(", ")}`,
  );
  yield* check(
    listed.tools.find((tool) => tool.name === "read_session")?.annotations?.readOnlyHint === true,
    "read_session is not marked read-only",
  );

  const reply = (name: string, args: Record<string, unknown>) =>
    attempt(name, () => mcp.callTool({ name, arguments: args }));
  const call = (name: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const result = yield* reply(name, args);
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      if (result.isError === true) return yield* fail(`${name}: ${text}`);
      return text;
    });
  const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string) =>
    Schema.decodeUnknownEffect(schema)(text).pipe(
      Effect.mapError(() => fail(`Unexpected tool reply: ${text.slice(0, 300)}`)),
    );
  const read = (id: string) =>
    call("read_session", { id }).pipe(Effect.flatMap((text) => decode(Read, text)));
  const until = (id: string, done: (value: typeof Read.Type) => boolean) =>
    Effect.gen(function* () {
      const started = Date.now();
      while (Date.now() - started < 420_000) {
        const value = yield* read(id);
        if (done(value)) return value;
        if (value.status === "failed") return yield* fail("The session failed");
        yield* Effect.sleep("2 seconds");
      }
      return yield* fail("Timed out waiting on read_session");
    });

  // 3. A new session answers its prompt, and read_session shows the answer once it stops working.
  const first = `MCP-${crypto.randomUUID().slice(0, 8)}`;
  const created = yield* decode(
    Created,
    yield* call("new_session", {
      repo: fixtureRepo,
      prompt: prompt(`Reply with only the word ${first}.`, `say ${first}`),
      ...sessionAgent,
    }),
  );
  const { id } = created;
  console.log(`Session ${id}`);
  yield* until(id, (value) => value.turns.at(-1)?.state === "completed" && !value.working).pipe(
    Effect.flatMap((value) =>
      check(value.turns.at(-1)?.assistant.includes(first) === true, "The first answer is missing"),
    ),
  );

  // 4. steer_session finds the current turn itself.
  const second = `MCP-${crypto.randomUUID().slice(0, 8)}`;
  yield* call("steer_session", {
    id,
    text: prompt(`Reply with only the word ${second}.`, `say ${second}`),
  });
  yield* until(
    id,
    (value) =>
      value.turns.at(-1)?.user.includes(second) === true &&
      value.turns.at(-1)?.state === "completed",
  ).pipe(
    Effect.flatMap((value) =>
      check(
        value.turns.at(-1)?.assistant.includes(second) === true,
        "The steered answer is missing",
      ),
    ),
  );

  // 5. The list has the session; an unknown id is a tool error, not a protocol one.
  const sessions = yield* decode(Listed, yield* call("list_sessions", {}));
  yield* check(
    sessions.some((session) => session.id === id),
    "list_sessions does not show the session",
  );
  const missing = yield* reply("read_session", { id: "missing0" });
  yield* check(missing.isError === true, "read_session of an unknown id did not report an error");

  // 6. stop_session stops it.
  yield* call("stop_session", { id });
  yield* until(id, (value) => value.status === "stopped");
  yield* attempt("close", () => mcp.close());
  console.log("MCP: signed-out 401, tools listed, new, read, steer, list and stop all worked");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Scotty MCP e2e failed");
  process.exitCode = 1;
});
