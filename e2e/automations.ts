import { Effect, Schema } from "effect";
import {
  access,
  AutomationRemoved,
  AutomationSwitched,
  CliFailure,
  client,
  InboundCreated as ConnectionCreated,
  ConnectionRemoved,
  Created,
  List,
  failure,
  Runs,
  RunFired,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { agent, prompt, real, sessionAgent } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { Log, waiter } from "./lib/wait.js";
import { fold, initial } from "../src/session/fold.js";
import type { Action } from "../src/automations/automation.js";

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
  const mainWorkspace = (yield* request(`/api/sessions/${session}/log`, Log)).find(
    (event) => event.kind === "workspace.ready",
  );
  yield* request(`/api/sessions/${session}/stop`, View, { method: "POST" }).pipe(Effect.ignore);

  // 2. A delivery an event automation's `only` does not match is recorded as a skip.
  const hook = `e2e-${suffix}`;
  const connection = yield* request("/api/connections", ConnectionCreated, {
    method: "POST",
    body: { kind: "inbound", name: hook, signing: { kind: "preset", preset: "standard-webhooks" } },
  });
  const listener = `e2e-event-${suffix}`;
  const startDefinition = {
    when: { kind: "event", connection: hook },
    only: { action: ["opened", "reopened"], "issue.title": { kind: "contains", value: "issue" } },
    except: { "issue.title": { kind: "contains", value: "[skip]" } },
    key: "issue-{{issue.id}}",
    branch: "{{issue.branch}}",
    repo: fixtureRepo,
    prompt: prompt("Look at {{issue.title}}", "say {{issue.title}}"),
    ...sessionAgent,
  };
  yield* request("/api/automations", AutomationSwitched, {
    method: "POST",
    body: {
      name: listener,
      ...startDefinition,
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
  const startDeliveries: { delivery: string; body: unknown; status: string }[] = [];
  for (const [title, status] of [
    ["first", "started"],
    ["second", "steered"],
  ] as const) {
    const delivery = `msg_${crypto.randomUUID()}`;
    const body = {
      action: "opened",
      issue: { id: issue, title: `${title} issue`, branch: "automation-base" },
    };
    startDeliveries.push({ delivery, body, status });
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
  console.log("Repeated events keep one run and preserve start and steer outcomes");

  if (eventSession === null)
    return yield* failure("automations", "No event session", "scotty runs");
  const prefix = `/api/sessions/${eventSession}`;
  const events = () => request(`${prefix}/log`, Log);
  const history = yield* events();
  const created = history.find((event) => event.kind === "created");
  const workspace = history.find((event) => event.kind === "workspace.ready");
  yield* check(
    created?.kind === "created" &&
      created.baseBranch === "automation-base" &&
      created.branch === `scotty/${eventSession}` &&
      workspace?.kind === "workspace.ready" &&
      workspace.base === "automation-base" &&
      workspace.branch === created.branch &&
      mainWorkspace?.kind === "workspace.ready" &&
      workspace.commit !== mainWorkspace.commit,
    "The templated branch was not cloned as the work branch's base",
  );

  for (const [title, reason] of [
    ["unrelated", "not matched: issue.title"],
    ["[skip] issue", "except matched: issue.title"],
  ]) {
    const answer = yield* deliver(url, hook, connection.secret, {
      action: "opened",
      issue: { id: issue, title, branch: "automation-base" },
    });
    const received = yield* Schema.decodeUnknownEffect(Answer)(answer.body);
    yield* check(
      answer.status === 200 &&
        received.runs[0]?.status === "skipped" &&
        received.runs[0]?.reason?.startsWith(reason) === true,
      `Filter did not skip ${title}`,
    );
  }
  const missing = yield* deliver(url, hook, connection.secret, {
    action: "opened",
    issue: { id: issue, title: "an issue" },
  });
  const missingBranch = yield* Schema.decodeUnknownEffect(Answer)(missing.body);
  yield* check(
    missingBranch.runs[0]?.status === "skipped" &&
      missingBranch.runs[0]?.reason === "no issue.branch for branch",
    "A missing branch field was not skipped",
  );
  yield* check(
    JSON.stringify(yield* events()) === JSON.stringify(history),
    "Filtered or missing-branch events reached the session",
  );
  console.log("Contains, except and missing branch fields skip with the matching rule");

  const putAction = (action: typeof Action.Type, key: string, repo = fixtureRepo) =>
    request(`/api/automations/${listener}`, AutomationSwitched, {
      method: "PUT",
      body: {
        when: { kind: "event", connection: hook },
        action,
        key,
        repo,
        prompt: prompt("Reply with the word awake.", "say awake"),
        ...sessionAgent,
      },
    });
  const runNow = () =>
    request(`/api/automations/${listener}/run`, RunFired, { method: "POST", body: {} });
  const absentKey = `absent-${issue}`;
  yield* putAction("wake", absentKey);
  const noSession = yield* runNow();
  yield* check(
    noSession.status === "skipped" &&
      noSession.reason === "no_session" &&
      noSession.session === null,
    "Wake without a session did not skip",
  );
  yield* check(
    (yield* request(`/api/sessions?q=${absentKey}`, List)).sessions.length === 0,
    "Wake created a session",
  );
  yield* putAction("end", absentKey);
  const noEnd = yield* runNow();
  yield* check(
    noEnd.status === "skipped" && noEnd.reason === "no_session",
    "End without a session did not skip",
  );

  const key = `issue-${issue}`;
  yield* putAction("wake", key);
  const turn = (yield* events()).reduce(fold, initial).currentTurn;
  const woke = yield* runNow();
  yield* check(
    woke.status === "steered" && woke.session === eventSession,
    "Wake did not steer the key's session",
  );
  yield* waiter(request, prefix)(events, (log) =>
    log.some((event) => event.kind === "save.done" && event.turn === turn),
  );

  // API retry ids also keep the session they steered, independently of its routing key.
  const retry = `api-${suffix}`;
  const retryBody = {
    title: "Retry identity",
    repo: fixtureRepo,
    key,
    prompt: prompt("Say retry.", "say retry"),
    provider: "cloudflare",
    ...sessionAgent,
  };
  const retryTurn = (yield* events()).reduce(fold, initial).currentTurn;
  yield* request("/api/sessions", Created, { method: "POST", key: retry, body: retryBody });
  yield* waiter(request, prefix)(events, (log) =>
    log.some((event) => event.kind === "save.done" && event.turn === retryTurn),
  );

  yield* putAction("end", key, "octocat/Hello-World");
  yield* request(`/api/automations/${listener}`, AutomationSwitched, {
    method: "PATCH",
    body: { enabled: true },
  });
  const beforeConflict = yield* events();
  const conflict = yield* deliver(url, hook, connection.secret, {});
  const conflictRun = (yield* Schema.decodeUnknownEffect(Answer)(conflict.body)).runs[0];
  yield* check(
    conflict.status === 200 &&
      conflictRun?.status === "failed" &&
      conflictRun.reason === "key or retry id used by another repo, agent or prompt" &&
      JSON.stringify(yield* events()) === JSON.stringify(beforeConflict),
    "An end with a mismatched repo was not refused without stopping the session",
  );

  yield* putAction("end", key);
  yield* request(`/api/automations/${listener}`, AutomationSwitched, {
    method: "PATCH",
    body: { enabled: true },
  });
  const endDelivery = `msg_${crypto.randomUUID()}`;
  const ended = yield* deliver(url, hook, connection.secret, {}, endDelivery);
  const endedRun = (yield* Schema.decodeUnknownEffect(Answer)(ended.body)).runs[0];
  yield* check(
    ended.status === 200 && endedRun?.status === "ended" && endedRun.session === eventSession,
    "End did not reach the key's session",
  );
  const stopped = yield* request(prefix, View);
  yield* check(
    stopped.session.authority.kind === "stable" &&
      stopped.session.authority.lifecycle === "stopped",
    "End did not stop the session",
  );
  yield* check(
    (yield* events()).filter(
      (event) =>
        event.kind === "container.stopped" &&
        event.req === `run:${endedRun?.id}` &&
        event.reason === "ended",
    ).length === 1,
    "End's stop was not recorded with reason ended",
  );

  const ownerTurn = (yield* events()).reduce(fold, initial).currentTurn;
  yield* request(`${prefix}/steer`, Reply, {
    method: "POST",
    body: { turn: ownerTurn, text: prompt("Reply with the word resumed.", "say resumed") },
  });
  yield* waiter(request, prefix)(events, (log) =>
    log.some((event) => event.kind === "save.done" && event.turn === ownerTurn),
  );
  const resumed = yield* events();
  // This goes directly to the DO with the end's request id, bypassing settled-run dedupe.
  yield* request(`${prefix}/stop`, View, { method: "POST", key: `run:${endedRun?.id}` });
  yield* check(
    JSON.stringify(yield* events()) === JSON.stringify(resumed),
    "The Session DO repeated a stop request after owner resume",
  );
  const again = yield* deliver(url, hook, connection.secret, {}, endDelivery);
  yield* check(
    (yield* Schema.decodeUnknownEffect(Answer)(again.body)).runs[0]?.status === "ended" &&
      JSON.stringify(yield* events()) === JSON.stringify(resumed),
    "An end retry stopped the owner-resumed session",
  );

  yield* putAction("wake", key);
  const released = yield* runNow();
  yield* check(
    released.status === "skipped" && released.reason === "no_session",
    "An ended key still reached its old session",
  );
  yield* putAction("start", key);
  const fresh = yield* runNow();
  yield* check(
    fresh.status === "started" && fresh.session !== null && fresh.session !== eventSession,
    "Start reused the ended session's key reservation",
  );
  const apiRetry = yield* request("/api/sessions", Created, {
    method: "POST",
    key: retry,
    body: retryBody,
  });
  yield* check(
    apiRetry.id === eventSession &&
      apiRetry.steered === false &&
      JSON.stringify(yield* events()) === JSON.stringify(resumed),
    "A keyed API retry followed the replacement session",
  );

  // Prune the 500-run history, then replay old requests with the key held by a replacement.
  if (fresh.session === null)
    return yield* failure("automations", "No replacement session", "scotty runs");
  const replacement = `/api/sessions/${fresh.session}`;
  yield* waiter(request, replacement)(
    () => request(`${replacement}/log`, Log),
    (log) => log.some((event) => event.kind === "save.done" && event.turn === "0"),
  );
  const replacementHistory = yield* request(`${replacement}/log`, Log);
  yield* putAction("end", absentKey);
  yield* Effect.forEach(Array.from({ length: 501 }), () => runNow(), {
    concurrency: 8,
    discard: true,
  });
  yield* check(
    !(yield* runsOf(listener)).runs.some((run) => run.id === endedRun?.id),
    "The end run was not pruned",
  );
  yield* putAction("end", key);
  yield* request(`/api/automations/${listener}`, AutomationSwitched, {
    method: "PATCH",
    body: { enabled: true },
  });
  const replayedEnd = yield* deliver(url, hook, connection.secret, {}, endDelivery);
  const replayedAnswer = yield* Schema.decodeUnknownEffect(Answer)(replayedEnd.body);
  const replayedRun = replayedAnswer.runs[0];
  yield* check(
    replayedEnd.status === 200 &&
      replayedAnswer.status === "accepted" &&
      replayedRun?.status === "ended" &&
      replayedRun.session === eventSession &&
      JSON.stringify(yield* events()) === JSON.stringify(resumed) &&
      JSON.stringify(yield* request(`${replacement}/log`, Log)) ===
        JSON.stringify(replacementHistory),
    "A pruned end retry stopped the original or replacement session",
  );
  yield* request(`/api/automations/${listener}`, AutomationSwitched, {
    method: "PUT",
    body: startDefinition,
  });
  yield* request(`/api/automations/${listener}`, AutomationSwitched, {
    method: "PATCH",
    body: { enabled: true },
  });
  for (const { delivery, body, status } of startDeliveries) {
    const answer = yield* deliver(url, hook, connection.secret, body, delivery);
    const received = yield* Schema.decodeUnknownEffect(Answer)(answer.body);
    const run = received.runs[0];
    yield* check(
      answer.status === 200 &&
        received.status === "accepted" &&
        run?.status === status &&
        run.session === eventSession &&
        JSON.stringify(yield* events()) === JSON.stringify(resumed) &&
        JSON.stringify(yield* request(`${replacement}/log`, Log)) ===
          JSON.stringify(replacementHistory),
      "A pruned start or steer retry followed the replacement session",
    );
  }
  const listed = yield* request("/api/sessions", List);
  yield* check(
    listed.sessions.some((session) => session.identity.id === eventSession) &&
      listed.sessions.some((session) => session.identity.id === fresh.session),
    "Releasing the key removed a session from the index",
  );
  yield* request(`/api/sessions/${fresh.session}/stop`, View, { method: "POST" });
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  console.log(
    "Wake skips without a session; end stops and releases; owner messages resume; start makes a new session",
  );

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
