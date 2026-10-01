import { Effect, Schema } from "effect";
import {
  access,
  AutomationRemoved,
  AutomationSwitched,
  CliFailure,
  client,
  InboundCreated as ConnectionCreated,
  ConnectionRemoved,
  List,
  failure,
  Runs,
  target,
  View,
} from "../cli/client.js";
import { agent, prompt, real, sessionAgent } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("automations", message, "scotty runs"));

const Origin = Schema.Struct({
  session: Schema.Struct({
    display: Schema.Struct({
      origin: Schema.NullOr(
        Schema.Struct({
          kind: Schema.String,
          automation: Schema.optional(Schema.String),
          run: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});
const Answer = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literals(["accepted", "duplicate"]),
    runs: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        automation: Schema.String,
        status: Schema.String,
        reason: Schema.NullOr(Schema.String),
        session: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

// A minute 70–130 s from now, as a cron line read in `tz`: the schedule fires once, soon.
const soon = (tz: string) => {
  const at = new Date(Date.now() + 130_000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return `${part("minute")} ${part("hour")} * * *`;
};

// A Standard Webhooks delivery, signed with the connection's secret.
const deliver = (
  url: string,
  name: string,
  secret: string,
  body: unknown,
  id = `msg_${crypto.randomUUID()}`,
) =>
  Effect.promise(async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const text = JSON.stringify(body);
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${text}`)),
    );
    const response = await fetch(`${url}/hooks/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${btoa(String.fromCharCode(...signed))}`,
      },
      body: text,
    });
    return { status: response.status, body: await response.text() };
  });

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const suffix = crypto.randomUUID().slice(0, 8);
  // A unique issue keeps this run's key away from sessions earlier runs left on the stage.
  const issue = Date.now();
  const runsOf = (name: string) => request(`/api/runs?automation=${name}`, Runs);

  // 1. A calendar schedule in a zone away from UTC fires once, into a session that names its run.
  const scheduled = `e2e-cron-${suffix}`;
  const tz = "Asia/Kolkata";
  yield* request("/api/automations", AutomationSwitched, {
    method: "POST",
    body: {
      name: scheduled,
      when: { kind: "calendar", cron: soon(tz), tz },
      repo: fixtureRepo,
      prompt: prompt("Reply with only the word digest.", "say digest"),
      agent,
      ...(real ? {} : { scripted: true }),
    },
  });
  const on = yield* request(`/api/automations/${scheduled}`, AutomationSwitched, {
    method: "PATCH",
    body: { enabled: true },
  });
  yield* check(on.enabled, "The automation did not switch on");
  console.log(`Automation ${scheduled} on, due in about two minutes (${tz})`);
  const started = Date.now();
  let fired = yield* runsOf(scheduled);
  while (!fired.runs.some((run) => run.status !== "received") && Date.now() - started < 300_000) {
    yield* Effect.sleep("5 seconds");
    fired = yield* runsOf(scheduled);
  }
  const [run, ...more] = fired.runs;
  yield* check(
    run !== undefined && more.length === 0,
    `Expected one run, got ${fired.runs.length}`,
  );
  if (run === undefined) return;
  yield* check(
    run.status === "started" && run.trigger === "schedule" && run.session !== null,
    `The run is ${run.status}${run.reason === null ? "" : ` (${run.reason})`}`,
  );
  const session = run.session ?? "";
  const view = yield* request(`/api/sessions/${session}`, Origin);
  const origin = view.session.display.origin;
  yield* check(
    origin?.kind === "automation" && origin.automation === scheduled && origin.run === run.id,
    "The session's origin does not name the automation and run",
  );
  console.log(`Schedule fired once: run ${run.id} → session ${session} → run`);
  // The run reads its turn's outcome from the session.
  while (Date.now() - started < 600_000) {
    const now = (yield* runsOf(scheduled)).runs[0];
    if (now?.outcome === "completed") break;
    yield* check(now?.outcome !== "failed", "The run's turn failed");
    yield* Effect.sleep("5 seconds");
  }
  yield* check(
    (yield* runsOf(scheduled)).runs[0]?.outcome === "completed",
    "The run's turn did not complete",
  );
  console.log("The run shows its turn completed");
  yield* request(`/api/sessions/${session}/stop`, View, { method: "POST" }).pipe(Effect.ignore);

  // 2. A delivery an event automation's `only` does not match is recorded as a skip.
  const hook = `e2e-${suffix}`;
  const connection = yield* request("/api/connections", ConnectionCreated, {
    method: "POST",
    body: { kind: "inbound", name: hook, signing: { kind: "preset", preset: "standard-webhooks" } },
  });
  const listener = `e2e-event-${suffix}`;
  yield* request("/api/automations", AutomationSwitched, {
    method: "POST",
    body: {
      name: listener,
      when: { kind: "event", connection: hook },
      only: { action: ["opened", "reopened"] },
      key: "issue-{{issue.id}}",
      repo: fixtureRepo,
      prompt: prompt("Look at {{issue.title}}", "say {{issue.title}}"),
      ...sessionAgent,
    },
  });
  yield* request(`/api/automations/${listener}`, AutomationSwitched, {
    method: "PATCH",
    body: { enabled: true },
  });
  const answer = yield* deliver(url, hook, connection.secret, {
    action: "closed",
    issue: { id: issue, title: "A closed issue" },
  });
  yield* check(answer.status === 200, `The delivery was answered ${answer.status}`);
  const answered = yield* Schema.decodeUnknownEffect(Answer)(answer.body);
  const skipped = (yield* runsOf(listener)).runs;
  yield* check(
    answered.runs.length === 1 &&
      answered.runs[0]?.status === "skipped" &&
      skipped.length === 1 &&
      skipped[0]?.trigger === "event" &&
      skipped[0]?.status === "skipped" &&
      skipped[0]?.session === null &&
      (skipped[0]?.reason ?? "").startsWith("not matched: action"),
    `The non-matching delivery gave ${JSON.stringify(skipped)}`,
  );
  console.log(`A non-matching delivery is a skip: ${skipped[0]?.reason}`);

  // A repeated event preserves a run's start or steer and appends no prompt to its session.
  let eventSession: string | null = null;
  for (const [title, status] of [
    ["first", "started"],
    ["second", "steered"],
  ]) {
    const delivery = `msg_${crypto.randomUUID()}`;
    const body = { action: "opened", issue: { id: issue, title } };
    const answers = yield* Effect.all(
      [1, 2].map(() => deliver(url, hook, connection.secret, body, delivery)),
      { concurrency: "unbounded" },
    );
    for (const answer of answers) {
      yield* check(answer.status === 200, `Event delivery answered ${answer.status}`);
      const received = yield* Schema.decodeUnknownEffect(Answer)(answer.body);
      const run = received.runs[0];
      yield* check(
        received.runs.length === 1 &&
          run?.id === `delivery:${hook}:${delivery}:${listener}` &&
          run.status === status &&
          run.session !== null &&
          (eventSession === null || run.session === eventSession),
        `Repeated delivery did not preserve its ${status} run: ${JSON.stringify(received)}`,
      );
      eventSession = run?.session ?? null;
    }
    const prefix = `/api/sessions/${eventSession}`;
    const events = () => request(`${prefix}/log`, Log);
    yield* waiter(request, prefix)(events, (log) =>
      log.some(
        (event) => event.kind === "save.done" && event.turn === (status === "started" ? "0" : "1"),
      ),
    );
    const before = yield* events();
    const retried = yield* deliver(url, hook, connection.secret, body, delivery);
    const received = yield* Schema.decodeUnknownEffect(Answer)(retried.body);
    yield* check(
      retried.status === 200 &&
        received.status === "duplicate" &&
        received.runs[0]?.status === status,
      `Settled delivery lost its ${status} outcome`,
    );
    yield* check(
      JSON.stringify(yield* events()) === JSON.stringify(before),
      "A settled delivery retry appended session events",
    );
  }
  yield* check((yield* runsOf(listener)).runs.length === 3, "Repeated deliveries made extra runs");
  const hits = yield* request(`/api/sessions?q=${listener}`, List);
  yield* check(
    hits.sessions.some((session) => session.identity.id === eventSession),
    "Searching the automation's name did not find its session",
  );
  if (eventSession !== null)
    yield* request(`/api/sessions/${eventSession}/stop`, View, { method: "POST" });
  console.log("Repeated events keep one run and preserve start and steer outcomes");

  for (const name of [scheduled, listener]) {
    const removed = yield* request(`/api/automations/${name}`, AutomationRemoved, {
      method: "DELETE",
    });
    yield* check(removed.removed, `${name} was not removed`);
  }
  yield* request(`/api/connections/${hook}`, ConnectionRemoved, { method: "DELETE" });
  console.log("Automations and connection removed");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Automations e2e failed");
  process.exitCode = 1;
});
