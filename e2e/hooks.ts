import { Effect, Schema } from "effect";
import {
  access,
  CliFailure,
  client,
  ConnectionCreated,
  Connections,
  ConnectionRemoved,
  Conversation,
  Deliveries,
  List,
  View,
  failure,
  target,
} from "../cli/client.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";
import { fixtureRepo } from "../protocol/supervisor.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("hooks", message, "scotty deliveries"));

const Answer = Schema.fromJsonString(Schema.Struct({ session: Schema.String }));
const answered = (text: string) =>
  Schema.decodeUnknownEffect(Answer)(text).pipe(Effect.map((x) => x.session));
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

// A Standard Webhooks delivery, signed with the connection's secret. /hooks/* is outside Access,
// so it carries no Access token.
const deliver = (url: string, name: string, secret: string, body: unknown, tamper = false) =>
  Effect.promise(async () => {
    const id = `msg_${crypto.randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const text = JSON.stringify(body);
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${tamper ? `${text} ` : text}`),
    );
    const response = await fetch(`${url}/hooks/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${base64(new Uint8Array(signed))}`,
      },
      body: text,
    });
    return { id, status: response.status, body: await response.text() };
  });

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const name = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const connection = yield* request("/api/connections", ConnectionCreated, {
    method: "POST",
    body: { kind: "webhook", name },
  });
  yield* check(connection.secret.startsWith("whsec_"), "The secret is not a whsec_ value");
  const listed = yield* request("/api/connections", Connections);
  yield* check(
    listed.connections.some((item) => item.name === name) &&
      !JSON.stringify(listed).includes(connection.secret),
    "The connection list is missing the connection or shows its secret",
  );
  console.log(`Connection ${name}`);

  const key = `e2e-${crypto.randomUUID()}`;
  const body = (text: string) => ({
    repo: fixtureRepo,
    key,
    title: `e2e hooks (${agent})`,
    ...sessionAgent,
    prompt: text,
  });

  // 1. Two signed deliveries with one key: one session, two turns.
  const first = yield* deliver(
    url,
    name,
    connection.secret,
    body(prompt("Reply with only the word one.", "say one")),
  );
  yield* check(first.status === 200 || first.status === 201, `First delivery: ${first.status}`);
  const session = yield* answered(first.body).pipe(
    Effect.mapError(() =>
      failure("hooks", "The first delivery named no session", "scotty deliveries"),
    ),
  );
  const prefix = `/api/sessions/${session}`;
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  yield* poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"));
  const second = yield* deliver(
    url,
    name,
    connection.secret,
    body(prompt("Reply with only the word two.", "say two")),
  );
  yield* check(second.status === 200, `Second delivery: ${second.status}`);
  yield* check((yield* answered(second.body)) === session, "The second delivery made a session");
  yield* poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "1"));
  const conversation = yield* request(`${prefix}/conversation`, Conversation);
  yield* check(conversation.turns.length === 2, "The session does not have two turns");
  console.log("Two deliveries with one key: one session, two turns");
  // Search by the key and by the connection name finds the session.
  for (const text of [key, name]) {
    const hits = yield* request(`/api/sessions?q=${encodeURIComponent(text)}`, List);
    yield* check(
      hits.sessions.some((item) => item.identity.id === session),
      `Searching ${text} did not find the session`,
    );
  }

  // 2. A bad signature is rejected and listed.
  const bad = yield* deliver(url, name, connection.secret, body("say no"), true);
  yield* check(bad.status === 401, `Tampered delivery: ${bad.status}`);
  const deliveries = yield* request(
    `/api/deliveries?connection=${encodeURIComponent(name)}`,
    Deliveries,
  );
  const rejected = deliveries.deliveries.find((item) => item.id === bad.id);
  yield* check(rejected?.outcome === "rejected", "The bad delivery is not listed as rejected");
  yield* check(
    deliveries.deliveries.filter((item) => item.outcome === "accepted" && item.session === session)
      .length === 2,
    "The accepted deliveries are not linked to the session",
  );
  console.log("Bad signature: rejected and listed");

  // 3. The same key with another repo is a conflict.
  const other = yield* deliver(url, name, connection.secret, {
    ...body("say x"),
    repo: "someone/else",
  });
  yield* check(other.status === 409, `Key conflict: ${other.status}`);

  yield* request(`${prefix}/stop`, View, { method: "POST" }).pipe(Effect.ignore);
  const removed = yield* request(
    `/api/connections/${encodeURIComponent(name)}`,
    ConnectionRemoved,
    { method: "DELETE" },
  );
  yield* check(removed.removed, "The connection was not removed");
  console.log("Conflict: 409; connection removed");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Hooks e2e failed");
  process.exitCode = 1;
});
