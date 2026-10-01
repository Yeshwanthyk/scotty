import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  access,
  CliFailure,
  client,
  ConnectionCreated,
  ConnectionRemoved,
  Connections,
  Log as RawLog,
  Conversation,
  Created,
  failure,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { agent, real } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("reach", message, "scotty log <id>"));
// Keep unexpected fields too, so a contract decoder cannot hide a leaked credential.
const RawConnection = Schema.StructWithRest(
  Schema.Struct({ name: Schema.String, kind: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const RawConnections = Schema.Struct({ connections: Schema.Array(RawConnection) });
const RawConversation = Schema.Record(Schema.String, Schema.Unknown);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const Probe = Schema.Struct({
  status: Schema.Number,
  method: Schema.String,
  url: Schema.String,
  bodyHash: Schema.String,
  headerHashes: Schema.Record(Schema.String, Schema.String),
  mcpSession: Schema.NullOr(Schema.String),
  mcpVersion: Schema.NullOr(Schema.String),
  lastEvent: Schema.NullOr(Schema.String),
});
const id = crypto.randomUUID().slice(0, 8);
const tokenName = `reach-token-${id}`;
const mcpName = `reach-mcp-${id}`;
// Disposable sentinels, not live service credentials. Echoed auth is hashed inside the stand-in.
const token = `reach-token-secret-${crypto.randomUUID()}`;
const mcp = `reach-mcp-secret-${crypto.randomUUID()}`;
// Reach reads every MCP POST as JSON-RPC, so the probe body is one.
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
const script = (method: "GET" | "POST" | "DELETE", kind: "token" | "mcp") =>
  `call ${JSON.stringify({
    url: `http://${kind === "token" ? tokenName : mcpName}.internal/api/${kind === "mcp" ? "mcp" : "anything/reach"}?marker=${id}`,
    method,
    headers: {
      Authorization: "Bearer incoming-auth",
      "X-Api-Key": "incoming-key",
      "X-Reach-Token": "incoming-token",
      "Content-Type": "application/json",
      "Mcp-Session-Id": `session-${id}`,
      "Mcp-Protocol-Version": "2025-06-18",
      "Last-Event-ID": `event-${id}`,
    },
    ...(method === "POST" ? { body } : {}),
  })}\nsay {{out}}`;

const program = Effect.gen(function* () {
  if (real) return yield* check(false, "Reach uses the scripted echo probe; omit --real");
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const owned: string[] = [];
  let session: string | undefined;
  const cleanup = Effect.gen(function* () {
    if (session !== undefined)
      yield* request(`/api/sessions/${session}/stop`, View, { method: "POST" }).pipe(Effect.ignore);
    for (const name of owned)
      yield* request(`/api/connections/${name}`, ConnectionRemoved, { method: "DELETE" }).pipe(
        Effect.ignore,
      );
  });
  yield* Effect.gen(function* () {
    // httpbingo is a public echo service. No Scotty production route exists for the test.
    for (const input of [
      {
        kind: "token" as const,
        name: tokenName,
        host: "httpbingo.org",
        header: "X-Reach-Token",
        secret: token,
      },
      {
        kind: "mcp" as const,
        name: mcpName,
        url: "https://httpbingo.org/anything/reach",
        secret: mcp,
        policy: { kind: "all" },
      },
    ]) {
      const added = yield* request("/api/connections", RawConnection, {
        method: "POST",
        body: input,
      });
      owned.push(input.name);
      yield* Schema.decodeUnknownEffect(ConnectionCreated)(added);
      yield* check(
        !JSON.stringify(added).includes(input.secret),
        "Creation returned a pasted secret",
      );
    }
    const listed = yield* request("/api/connections", RawConnections);
    yield* Schema.decodeUnknownEffect(Connections)(listed);
    yield* check(
      !JSON.stringify(listed).includes(token) && !JSON.stringify(listed).includes(mcp),
      "Connection listing returned a secret",
    );
    const created = yield* request("/api/sessions", Created, {
      method: "POST",
      key: crypto.randomUUID(),
      body: {
        title: `e2e reach (${agent})`,
        repo: fixtureRepo,
        agent,
        scripted: true,
        prompt: script("GET", "token"),
        provider: "cloudflare",
      },
    });
    session = created.id;
    const prefix = `/api/sessions/${session}`;
    const poll = waiter(request, prefix);
    const events = () => request(`${prefix}/log`, Log);
    const answer = (turn: string) =>
      Effect.gen(function* () {
        yield* poll(events, (log) =>
          log.some((event) => event.kind === "turn.ended" && event.turn === turn),
        );
        const conversation = yield* request(`${prefix}/conversation`, Conversation);
        return conversation.turns.at(-1)?.assistant ?? "";
      });
    const verify = (text: string, method: string, kind: "token" | "mcp") =>
      Effect.gen(function* () {
        const probe = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Probe))(text).pipe(
          Effect.mapError(() =>
            failure("reach", "Probe did not return a safe echo summary", "scotty log <id>"),
          ),
        );
        yield* check(
          probe.status === 200 &&
            probe.method === method &&
            probe.url.includes(`/anything/reach?marker=${id}`),
          "Method, path or query was not forwarded",
        );
        yield* check(
          probe.headerHashes[kind === "token" ? "x-reach-token" : "authorization"] ===
            hash(kind === "token" ? token : `Bearer ${mcp}`),
          "Upstream did not receive the stored credential",
        );
        yield* check(
          probe.headerHashes["x-api-key"] === undefined &&
            (kind !== "token" || probe.headerHashes.authorization === undefined),
          "Incoming auth was not stripped",
        );
        yield* check(
          probe.mcpSession === `session-${id}` &&
            probe.mcpVersion === "2025-06-18" &&
            probe.lastEvent === `event-${id}`,
          "MCP headers were lost",
        );
        if (method === "POST")
          yield* check(probe.bodyHash === hash(body), "Request body was changed");
      });
    yield* verify(yield* answer("0"), "GET", "token");
    let turn = 0;
    const steer = (text: string) =>
      Effect.gen(function* () {
        turn += 1;
        const req = crypto.randomUUID();
        yield* request(`${prefix}/steer`, Reply, {
          method: "POST",
          key: req,
          body: { req, turn: String(turn), text },
        });
        return yield* answer(String(turn));
      });
    for (const method of ["GET", "POST", "DELETE"] as const)
      yield* verify(yield* steer(script(method, "mcp")), method, "mcp");
    // The probe never receives a sentinel as input. Reading env/configs can expose a bad delivery.
    const environment = yield* steer(
      'run env; find "$HOME/.codex" "$HOME/.claude" -maxdepth 2 -type f \\( -name "config.toml" -o -name ".mcp.json" -o -name "settings.json" \\) -exec cat {} \\; 2>/dev/null; true\nsay {{out}}',
    );
    const conversation = yield* request(`${prefix}/conversation`, RawConversation);
    const log = yield* request(`${prefix}/log`, RawLog);
    for (const text of [environment, JSON.stringify(conversation), JSON.stringify(log)])
      yield* check(
        !text.includes(token) && !text.includes(mcp),
        "Secret found in container environment/config, conversation or event log",
      );
    // A cold resume must reinstall the interceptor, with the same metadata-only agent config.
    yield* poll(events, (log) =>
      log.some((event) => event.kind === "save.done" && event.turn === String(turn)),
    );
    yield* request(`${prefix}/stop`, View, { method: "POST" });
    yield* verify(yield* steer(script("GET", "mcp")), "GET", "mcp");
    const resumed = yield* request(`${prefix}/log`, RawLog);
    yield* check(
      !JSON.stringify(resumed).includes(token) && !JSON.stringify(resumed).includes(mcp),
      "Secret in resumed event log",
    );
    console.log(
      `Reach (${agent}): token, MCP GET/POST/DELETE, auth cleanup, body, headers, cold resume and secret isolation passed`,
    );
  }).pipe(Effect.ensuring(cleanup));
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Reach e2e failed");
  process.exitCode = 1;
});
