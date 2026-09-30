import { Effect, Schema } from "effect";
import {
  access,
  CliFailure,
  client,
  ConnectionCreated,
  Connections,
  ConnectionRemoved,
  Conversation,
  Created,
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
const Status = Schema.fromJsonString(
  Schema.Struct({ status: Schema.String, session: Schema.optional(Schema.NullOr(Schema.String)) }),
);
const answered = (text: string) =>
  Schema.decodeUnknownEffect(Answer)(text).pipe(Effect.map((x) => x.session));
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

// A Standard Webhooks delivery, signed with the connection's secret. /hooks/* is outside Access,
// so it carries no Access token.
const deliver = (
  url: string,
  name: string,
  secret: string,
  body: unknown,
  options: { tamper?: boolean; id?: string } = {},
) =>
  Effect.promise(async () => {
    const id = options.id ?? `msg_${crypto.randomUUID()}`;
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
      new TextEncoder().encode(`${id}.${timestamp}.${options.tamper ? `${text} ` : text}`),
    );
    const response = await fetch(`${url}/hooks/${name}`, {
      method: "POST",
      // Access answers a request it guards with a redirect to its login.
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${base64(new Uint8Array(signed))}`,
      },
      body: text,
    });
    return { id, status: response.status, body: await response.text() };
  }).pipe(
    Effect.tap((answer) =>
      check(
        answer.status < 300 || answer.status >= 400,
        `/hooks/${name} redirected (HTTP ${answer.status}): Access guards it, so no sender can reach it`,
      ),
    ),
  );

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
  // Access bypasses /hooks/* alone: a path that climbs out of it is not the API.
  for (const path of ["/hooks/%2e%2e/api/sessions", "/hooks/..%2Fapi%2Fsessions"]) {
    const escaped = yield* Effect.promise(async () => {
      const response = await fetch(`${url}${path}`, { redirect: "manual" });
      return { status: response.status, body: await response.text() };
    });
    yield* check(
      escaped.status !== 200 && !escaped.body.includes('"sessions"'),
      `${path} without an Access token answered ${escaped.status} as the API`,
    );
  }

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
  const bad = yield* deliver(url, name, connection.secret, body("say no"), { tamper: true });
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

  // 4. The same delivery id twice at once has one effect; the other answer is a duplicate.
  const turnsOf = (id: string, count: number) =>
    waiter(request, `/api/sessions/${id}`)(
      () => request(`/api/sessions/${id}/conversation`, Conversation),
      (value) => value.turns.length === count,
    );
  const once = `msg_${crypto.randomUUID()}`;
  const three = body(prompt("Reply with only the word three.", "say three"));
  const twice = yield* Effect.all(
    [1, 2].map(() => deliver(url, name, connection.secret, three, { id: once })),
    { concurrency: "unbounded" },
  );
  const answers = yield* Effect.forEach(twice, (item) =>
    Schema.decodeUnknownEffect(Status)(item.body),
  );
  yield* check(
    answers.filter((item) => item.status === "accepted").length === 1 &&
      answers.filter((item) => item.status === "duplicate").length === 1,
    `The same delivery twice gave ${answers.map((item) => item.status).join(", ")}`,
  );
  yield* turnsOf(session, 3);
  console.log("Same delivery id twice: one turn, the other a duplicate");

  // A retry after the steer's turn has ended is still a duplicate, not a new turn or a 409.
  yield* poll(events, (log) => log.filter((e) => e.kind === "turn.ended").length >= 3);
  const retried = yield* deliver(url, name, connection.secret, three, { id: once });
  yield* check(
    retried.status === 200 &&
      (yield* Schema.decodeUnknownEffect(Status)(retried.body)).status === "duplicate",
    `A retry of a steer whose turn ended gave ${retried.status} ${retried.body}`,
  );
  yield* check(
    (yield* request(`${prefix}/conversation`, Conversation)).turns.length === 3,
    "A retried steer added a turn",
  );
  console.log("A retried steer after its turn ended: a duplicate");

  // 5. A delivery that steers a stopped session resumes it.
  yield* poll(events, (log) => log.filter((e) => e.kind === "turn.ended").length >= 3);
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  const resumed = yield* deliver(
    url,
    name,
    connection.secret,
    body(prompt("Reply with only the word four.", "say four")),
  );
  yield* check(resumed.status === 200, `Delivery to a stopped session: ${resumed.status}`);
  yield* turnsOf(session, 4);
  yield* poll(events, (log) => log.filter((e) => e.kind === "turn.ended").length >= 4);
  console.log("A delivery to a stopped session resumed it");

  // 6. Two deliveries at once with one new key: one session, both prompts become turns.
  const fresh = `e2e-${crypto.randomUUID()}`;
  const pair = yield* Effect.all(
    ["five", "six"].map((word) =>
      deliver(url, name, connection.secret, {
        ...body(prompt(`Reply with only the word ${word}.`, `say ${word}`)),
        key: fresh,
      }),
    ),
    { concurrency: "unbounded" },
  );
  yield* check(
    pair.every((item) => item.status === 200),
    `Concurrent deliveries gave ${pair.map((item) => item.status).join(", ")}`,
  );
  const sessions = yield* Effect.forEach(pair, (item) =>
    Schema.decodeUnknownEffect(Status)(item.body),
  );
  const together = sessions[0]?.session;
  yield* check(
    typeof together === "string" && sessions.every((item) => item.session === together),
    "Concurrent deliveries with one key made more than one session",
  );
  if (typeof together === "string") {
    const both = yield* turnsOf(together, 2);
    yield* check(
      ["five", "six"].every((word) => both.turns.some((turn) => turn.user.includes(word))),
      "A prompt from the concurrent deliveries was lost",
    );
    yield* request(`/api/sessions/${together}/stop`, View, { method: "POST" }).pipe(Effect.ignore);
  }
  console.log("Concurrent deliveries with a new key: one session, both prompts");

  // 7. A keyed create retried with its idempotency key adds no second turn; the same key with
  // another prompt is a conflict.
  const create = (text: string) =>
    request("/api/sessions", Created, {
      method: "POST",
      key: `e2e-${key}`,
      body: {
        title: `e2e hooks retry (${agent})`,
        repo: fixtureRepo,
        prompt: text,
        provider: "cloudflare",
        key: `e2e-api-${key}`,
        ...sessionAgent,
      },
    });
  const seven = prompt("Reply with only the word seven.", "say seven");
  const made = yield* create(seven);
  const again = yield* create(seven);
  yield* check(again.id === made.id && again.steered !== true, "A retried create steered");
  yield* turnsOf(made.id, 1);
  yield* waiter(request, `/api/sessions/${made.id}`)(
    () => request(`/api/sessions/${made.id}/log`, Log),
    (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"),
  );
  yield* check(
    (yield* request(`/api/sessions/${made.id}/conversation`, Conversation)).turns.length === 1,
    "A retried create added a second turn",
  );
  const changed = yield* create("say something else").pipe(Effect.flip);
  yield* check(changed.code === "key_conflict", `A changed retry gave ${changed.code}`);
  yield* request(`/api/sessions/${made.id}/stop`, View, { method: "POST" }).pipe(Effect.ignore);
  console.log("A retried keyed create: one turn; with another prompt: 409");

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
