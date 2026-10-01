import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import {
  access,
  AutomationRemoved,
  Automations,
  AutomationSwitched,
  CliFailure,
  client,
  ConnectionCreated,
  ConnectionRemoved,
  Conversation,
  failure,
  target,
  View,
} from "../cli/client.js";
import { readConfig } from "../cli/config.js";
import { ConnectionAuthorization } from "../src/creds/connections.js";
import { Blueprint, installation } from "../src/blueprints/blueprint.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { agent, real, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";
import { fold, initial } from "../src/session/fold.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("blueprints", message, "scotty runs; scotty log <id>"));
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

const load = (file: string) =>
  Effect.tryPromise(() => readFile(new URL(`../blueprints/${file}`, import.meta.url), "utf8")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Blueprint))),
    Effect.mapError(() => failure("blueprints", `blueprints/${file} is not a blueprint`, file)),
  );

// This run's own names, so it never touches an owner's install of the same blueprint, and a
// script for the scripted agent in place of each prompt.
const rename = (
  blueprint: Blueprint,
  suffix: string,
  scripts: Readonly<Record<string, string>>,
  mcpUrl?: string,
): Blueprint => ({
  ...blueprint,
  connections: blueprint.connections.map((connection) =>
    connection.kind === "mcp" && mcpUrl !== undefined
      ? { ...connection, name: `${connection.name}-${suffix}`, url: mcpUrl }
      : { ...connection, name: `${connection.name}-${suffix}` },
  ),
  automations: blueprint.automations.map((automation) => ({
    ...automation,
    name: `${automation.name}-${suffix}`,
    when:
      automation.when.kind === "event"
        ? { ...automation.when, connection: `${automation.when.connection}-${suffix}` }
        : automation.when,
    prompt: scripts[automation.name] ?? automation.prompt,
  })),
});

// Independent provider-shaped senders: HMAC-SHA256 hex over the raw body with the raw secret.
const hmac = async (secret: string, text: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)),
  );
  return Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const post = (
  url: string,
  headers: (text: string) => Promise<Record<string, string>>,
  body: unknown,
) =>
  Effect.promise(async () => {
    const text = JSON.stringify(body);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await headers(text)) },
      body: text,
    });
    return { status: response.status, body: await response.text() };
  }).pipe(
    Effect.flatMap((answer) =>
      answer.status === 200
        ? Schema.decodeUnknownEffect(Answer)(answer.body).pipe(
            Effect.mapError(() =>
              failure("blueprints", "Unreadable hook answer", "scotty deliveries"),
            ),
          )
        : Effect.fail(
            failure("blueprints", `Hook answered ${answer.status}`, "scotty deliveries --json"),
          ),
    ),
  );
const github = (url: string, secret: string, event: string, body: unknown) =>
  post(
    url,
    async (text) => ({
      "x-hub-signature-256": `sha256=${await hmac(secret, text)}`,
      "x-github-delivery": crypto.randomUUID(),
      "x-github-event": event,
    }),
    body,
  );
const linear = (url: string, secret: string, body: object) =>
  post(
    url,
    async (text) => ({
      "linear-signature": await hmac(secret, text),
      "linear-delivery": crypto.randomUUID(),
      "linear-event": "Issue",
    }),
    { ...body, webhookTimestamp: Date.now() },
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
  const suffix = crypto.randomUUID().slice(0, 8);
  const made = {
    connections: [] as string[],
    automations: [] as string[],
    sessions: [] as string[],
  };
  const cleanup = Effect.gen(function* () {
    for (const session of made.sessions)
      yield* request(`/api/sessions/${session}/stop`, View, { method: "POST" }).pipe(Effect.ignore);
    for (const name of made.automations)
      yield* request(`/api/automations/${name}`, AutomationRemoved, { method: "DELETE" }).pipe(
        Effect.ignore,
      );
    for (const name of made.connections)
      yield* request(`/api/connections/${name}`, ConnectionRemoved, { method: "DELETE" }).pipe(
        Effect.ignore,
      );
  });

  // The same steps as `scotty blueprint install` and the Settings sheet: check, create off, list.
  const install = (blueprint: Blueprint, secrets: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const plan = installation(blueprint, { repo: fixtureRepo, ...sessionAgent, secrets });
      if (!plan.ok) return yield* check(false, plan.problem).pipe(Effect.as([]));
      const created = [];
      for (const body of plan.installation.connections) {
        created.push(
          yield* request("/api/connections", ConnectionCreated, { method: "POST", body }),
        );
        made.connections.push(body.name);
      }
      for (const body of plan.installation.automations) {
        yield* request("/api/automations", AutomationSwitched, { method: "POST", body });
        made.automations.push(body.name);
      }
      const listed = (yield* request("/api/automations", Automations)).automations.filter(
        (automation) => blueprint.automations.some((item) => item.name === automation.name),
      );
      yield* check(
        listed.length === blueprint.automations.length &&
          listed.every((automation) => !automation.enabled && automation.repo === fixtureRepo),
        `${blueprint.name} automations were not all created off for the fixture repo`,
      );
      for (const automation of listed)
        yield* request(`/api/automations/${automation.name}`, AutomationSwitched, {
          method: "PATCH",
          body: { enabled: true },
        });
      return created;
    });
  const runOf = (answer: typeof Answer.Type, automation: string) =>
    answer.runs.find((run) => run.automation === `${automation}-${suffix}`);
  const turnEnded = (session: string, turn: string) =>
    Effect.gen(function* () {
      const prefix = `/api/sessions/${session}`;
      yield* waiter(request, prefix)(
        () => request(`${prefix}/log`, Log),
        (log) => log.some((event) => event.kind === "save.done" && event.turn === turn),
      );
      return (yield* request(`${prefix}/conversation`, Conversation)).turns.at(-1)?.assistant ?? "";
    });
  const endedBy = (session: string, run: string | undefined) =>
    Effect.gen(function* () {
      const prefix = `/api/sessions/${session}`;
      const stopped = yield* request(prefix, View);
      const log = yield* request(`${prefix}/log`, Log);
      return (
        stopped.session.authority.kind === "stable" &&
        stopped.session.authority.lifecycle === "stopped" &&
        log.some(
          (event) =>
            event.kind === "container.stopped" &&
            event.req === `run:${run}` &&
            event.reason === "ended",
        )
      );
    });

  yield* Effect.gen(function* () {
    // PR reviewer: opened starts a review on the head branch, a comment wakes it, closed ends it.
    const reviewer = rename(yield* load("pr-reviewer.json"), suffix, {
      "pr-review": "say review {{pull_request.number}}",
      "pr-review-comment": "say {{comment.body}}",
      "pr-review-end": "say closed",
    });
    const [hook] = yield* install(reviewer, {
      [`github-api-${suffix}`]: `e2e_${suffix}_token_unused`,
    });
    if (hook?.kind !== "inbound" || hook.secret === null)
      return yield* check(false, "The GitHub webhook did not come back with a generated secret");
    console.log(`Installed ${reviewer.name} off, then enabled: ${hook.url}`);
    // A unique number keeps this run's key away from sessions earlier runs left on the stage.
    const number = Date.now();
    const repository = { full_name: fixtureRepo };
    const sender = { login: "e2e-reviewer" };
    const pullRequest = (action: string) => ({
      action,
      number,
      pull_request: {
        number,
        title: "e2e change",
        draft: false,
        head: { ref: "automation-base" },
        base: { ref: "main" },
      },
      repository,
      sender,
    });
    const opened = yield* github(hook.url, hook.secret, "pull_request", pullRequest("opened"));
    const review = runOf(opened, "pr-review");
    const session = review?.session ?? null;
    yield* check(
      review?.status === "started" &&
        session !== null &&
        runOf(opened, "pr-review-end")?.status === "skipped",
      "pull_request opened did not start a review session",
    );
    if (session === null) return;
    made.sessions.push(session);
    yield* check(
      (yield* turnEnded(session, "0")).includes(`review ${number}`),
      "The review prompt did not render the pull request",
    );
    const history = yield* request(`/api/sessions/${session}/log`, Log);
    const created = history.find((event) => event.kind === "created");
    const workspace = history.find((event) => event.kind === "workspace.ready");
    yield* check(
      created?.kind === "created" &&
        created.baseBranch === "automation-base" &&
        workspace?.kind === "workspace.ready" &&
        workspace.base === "automation-base",
      "The review session is not on the pull request's head branch",
    );
    console.log(`PR opened → review session ${session} on automation-base`);
    const woken = (yield* request(`/api/sessions/${session}/log`, Log)).reduce(
      fold,
      initial,
    ).currentTurn;
    const commented = yield* github(hook.url, hook.secret, "issue_comment", {
      action: "created",
      issue: {
        number,
        pull_request: { url: `https://api.github.com/repos/${fixtureRepo}/pulls/${number}` },
      },
      comment: { body: "e2e comment", user: sender },
      repository,
      sender,
    });
    yield* check(
      runOf(commented, "pr-review-comment")?.status === "steered" &&
        runOf(commented, "pr-review-comment")?.session === session,
      "A comment did not wake the review session",
    );
    yield* check(
      (yield* turnEnded(session, woken)).includes("e2e comment"),
      "The comment did not reach the review session",
    );
    console.log("Comment → woke the review session");
    const closed = yield* github(hook.url, hook.secret, "pull_request", pullRequest("closed"));
    const end = runOf(closed, "pr-review-end");
    yield* check(
      end?.status === "ended" && end.session === session && (yield* endedBy(session, end.id)),
      "Closing the pull request did not end the review session",
    );
    console.log("PR closed → session ended");

    // Linear: an issue labelled scotty starts a session keyed by the issue, which reads it through
    // the MCP connection; other updates skip; completing the issue ends it.
    const mcpName = `linear-${suffix}`;
    const call = `call ${JSON.stringify({
      url: `http://${mcpName}.internal/api/mcp`,
      method: "POST",
      response: "mcp",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "read",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "e2e",
        method: "tools/call",
        params: { name: "read", arguments: {} },
      }),
    })}`;
    const worker = rename(
      yield* load("linear.json"),
      suffix,
      {
        "linear-new": `${call}\nsay read {{data.identifier}}`,
        "linear-labelled": `${call}\nsay read {{data.identifier}}`,
        "linear-done": "say done",
      },
      `${server}/mcp`,
    );
    const signing = `lin_wh_${crypto.randomUUID().replaceAll("-", "")}`;
    const [inbound, mcp] = yield* install(worker, { [`linear-issues-${suffix}`]: signing });
    if (inbound?.kind !== "inbound" || mcp?.kind !== "mcp")
      return yield* check(false, "The Linear blueprint did not make a webhook and an MCP server");
    yield* check(inbound.secret === null, "A pasted Linear signing secret was echoed back");
    const start = yield* request(`/api/connections/${mcp.name}/connect`, ConnectionAuthorization, {
      method: "POST",
    });
    const approved = yield* Effect.tryPromise(() =>
      fetch(start.authorizationUrl, { redirect: "manual" }),
    );
    const callback = yield* Schema.decodeUnknownEffect(Schema.String)(
      approved.headers.get("location"),
    );
    const signedIn = yield* Effect.tryPromise(() =>
      fetch(callback, { headers: { "cf-access-token": accessToken }, redirect: "manual" }),
    );
    yield* check(signedIn.status === 303, "Signing in to the MCP connection failed");
    console.log(`Installed ${worker.name} off, signed in to ${mcp.name}, then enabled`);

    const id = crypto.randomUUID();
    const issue = (labels: ReadonlyArray<string>, state = "unstarted") => ({
      id,
      identifier: "E2E-1",
      title: "e2e issue",
      labels: labels.map((name, at) => ({ id: `label-${at}`, name, color: "#5e6ad2" })),
      state: { type: state },
    });
    const issueUrl = "https://linear.app/e2e/issue/E2E-1";
    const unlabelled = yield* linear(inbound.url, signing, {
      action: "create",
      type: "Issue",
      data: issue(["bug"]),
      url: issueUrl,
    });
    yield* check(
      unlabelled.runs.every((run) => run.status === "skipped"),
      "An issue without the scotty label started a session",
    );
    const labelled = yield* linear(inbound.url, signing, {
      action: "update",
      type: "Issue",
      data: issue(["bug", "scotty"]),
      updatedFrom: { labelIds: ["label-0"] },
      url: issueUrl,
    });
    const started = runOf(labelled, "linear-labelled");
    const ticket = started?.session ?? null;
    yield* check(
      started?.status === "started" && ticket !== null,
      "Adding the scotty label did not start a session",
    );
    if (ticket === null) return;
    made.sessions.push(ticket);
    yield* check(
      (yield* turnEnded(ticket, "0")).includes("read E2E-1"),
      "The issue prompt did not render",
    );
    const outputs = (yield* request(`/api/sessions/${ticket}/log`, Log)).filter(
      (event) => event.kind === "agent.event" && JSON.stringify(event.event).includes("generation"),
    );
    yield* check(outputs.length > 0, "The session did not read through the MCP connection");
    console.log(`Label added → session ${ticket} read the issue through ${mcp.internalUrl}`);
    const edited = yield* linear(inbound.url, signing, {
      action: "update",
      type: "Issue",
      data: { ...issue(["bug", "scotty"]), title: "e2e issue, edited" },
      updatedFrom: { title: "e2e issue" },
      url: issueUrl,
    });
    yield* check(
      edited.runs.every((run) => run.status === "skipped"),
      "An update that did not change labels reached the session",
    );
    const done = yield* linear(inbound.url, signing, {
      action: "update",
      type: "Issue",
      data: issue(["bug", "scotty"], "completed"),
      updatedFrom: { stateId: "started" },
      url: issueUrl,
    });
    const finished = runOf(done, "linear-done");
    yield* check(
      finished?.status === "ended" &&
        finished.session === ticket &&
        (yield* endedBy(ticket, finished.id)),
      "Completing the issue did not end its session",
    );
    console.log(`Issue completed → session ended (${agent})`);
  }).pipe(Effect.ensuring(cleanup));
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Blueprints e2e failed");
  process.exitCode = 1;
});
