import { Effect, Schema } from "effect";
import {
  AutomationRemoved,
  AutomationSwitched,
  client,
  ConnectionCreated,
  ConnectionRemoved,
  Connections,
  Conversation,
  Created,
  Deliveries,
  failure,
  GitHubStatus,
  Runs,
  View,
} from "../cli/client.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { agent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("github_events", message, "scotty deliveries"));
const Answer = Schema.fromJsonString(
  Schema.Struct({ status: Schema.String, reason: Schema.optionalKey(Schema.String) }),
);

const deliver = (url: string, secret: string, id: string, payload: unknown) =>
  Effect.promise(async () => {
    const body = JSON.stringify(payload);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": id,
        "x-github-event": "check_run",
        "x-hub-signature-256": `sha256=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      },
      body,
    });
    return { status: response.status, body: await response.text() };
  });

export function githubEvents(request: ReturnType<typeof client>) {
  return Effect.gen(function* () {
    const identity = yield* request("/api/credentials/github", GitHubStatus);
    if (identity.login === null)
      return yield* failure(
        "setup",
        "GitHub events need a stored login to prove self-event skipping",
        "scotty login github",
      );
    const suffix = crypto.randomUUID().slice(0, 8);
    const hook = `e2e-github-${suffix}`;
    const name = `e2e-babysit-${suffix}`;
    // Removed even when a check fails, so a failed run leaves nothing on the stage.
    const cleanup = Effect.gen(function* () {
      yield* request(`/api/automations/${name}`, AutomationRemoved, { method: "DELETE" }).pipe(
        Effect.ignore,
      );
      yield* request(`/api/connections/${hook}`, ConnectionRemoved, { method: "DELETE" }).pipe(
        Effect.ignore,
      );
    });
    yield* Effect.gen(function* () {
      const connection = yield* request("/api/connections", ConnectionCreated, {
        method: "POST",
        body: { kind: "inbound", name: hook, signing: { kind: "preset", preset: "github" } },
      });
      if (connection.kind !== "inbound" || connection.secret === null)
        return yield* failure(
          "github_events",
          "Expected a GitHub connection",
          "scotty connections",
        );
      const listed = yield* request("/api/connections", Connections);
      yield* check(
        listed.connections.some(
          (item) => item.kind === "inbound" && item.name === hook && item.url === connection.url,
        ),
        "The GitHub connection and hook URL were not listed",
      );
      // A unique PR number keeps this test's key separate from other runs on the fixture repo.
      const pr = Date.now();
      const key = `gh:${fixtureRepo}#${pr}`;
      const session = yield* request("/api/sessions", Created, {
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          title: `e2e github events (${agent})`,
          repo: fixtureRepo,
          prompt: "say PR ready",
          key,
          agent,
          scripted: true,
          provider: "cloudflare",
        },
      });
      const prefix = `/api/sessions/${session.id}`;
      const poll = waiter(request, prefix);
      yield* poll(
        () => request(`${prefix}/log`, Log),
        (log) => log.some((event) => event.kind === "turn.ended" && event.turn === "0"),
      );
      const payload = {
        event: "ignored",
        action: "completed",
        repository: { full_name: fixtureRepo },
        check_run: { conclusion: "failure", pull_requests: [{ number: pr }] },
        sender: { login: `external-${suffix}` },
      };
      const noAutomationId = crypto.randomUUID();
      const noAutomation = yield* deliver(
        connection.url,
        connection.secret,
        noAutomationId,
        payload,
      );
      const noAutomationAnswer = yield* Schema.decodeUnknownEffect(Answer)(noAutomation.body);
      yield* check(
        noAutomation.status === 200 &&
          noAutomationAnswer.status === "skipped" &&
          noAutomationAnswer.reason === "no_automation",
        "A delivery with no listening automation was not skipped",
      );
      yield* check(
        (yield* request(`/api/runs?automation=${name}`, Runs)).runs.length === 0,
        "A delivery with no listening automation added a run",
      );
      yield* request("/api/automations", AutomationSwitched, {
        method: "POST",
        body: {
          name,
          when: { kind: "event", connection: hook },
          only: { event: "check_run", action: "completed", "check_run.conclusion": "failure" },
          key: "gh:{{repository.full_name}}#{{check_run.pull_requests.0.number}}",
          repo: fixtureRepo,
          agent,
          scripted: true,
          prompt: "say Fixed {{repository.full_name}}#{{check_run.pull_requests.0.number}}",
        },
      });
      yield* request(`/api/automations/${name}`, AutomationSwitched, {
        method: "PATCH",
        body: { enabled: true },
      });
      const id = crypto.randomUUID();
      const accepted = yield* deliver(connection.url, connection.secret, id, payload);
      yield* check(accepted.status === 200, `Signed check_run answered ${accepted.status}`);
      yield* check(
        (yield* Schema.decodeUnknownEffect(Answer)(accepted.body)).status === "accepted",
        "The signed delivery was not accepted",
      );
      const { runs } = yield* request(`/api/runs?automation=${name}`, Runs);
      yield* check(
        runs.length === 1 &&
          runs[0]?.status === "steered" &&
          runs[0]?.session === session.id &&
          runs[0]?.key === key,
        "Babysit did not steer the session that owns the PR key",
      );
      const conversation = yield* poll(
        () => request(`${prefix}/conversation`, Conversation),
        (value) => value.turns.length === 2 && value.turns[1]?.state === "completed",
      );
      yield* check(
        conversation.turns[1]?.assistant.includes(`Fixed ${fixtureRepo}#${pr}`) === true,
        "The second turn lacks the rendered PR number",
      );
      // A delivery reaches the session only as a prompt; saves and socket events keep arriving.
      const prompts = request(`${prefix}/log`, Log).pipe(
        Effect.map((events) => JSON.stringify(events.filter((e) => e.kind === "prompt.requested"))),
      );
      const before = yield* prompts;
      const retry = yield* deliver(connection.url, connection.secret, id, payload);
      yield* check(
        retry.status === 200 &&
          (yield* Schema.decodeUnknownEffect(Answer)(retry.body)).status === "duplicate",
        "Redelivery was not answered duplicate",
      );
      yield* check(
        (yield* request(`/api/runs?automation=${name}`, Runs)).runs.length === 1,
        "Redelivery added a run",
      );
      yield* check((yield* prompts) === before, "Redelivery added a prompt");
      const badId = crypto.randomUUID();
      const bad = yield* deliver(connection.url, `${connection.secret}-wrong`, badId, payload);
      yield* check(bad.status === 401, `Bad signature answered ${bad.status}`);
      const ownId = crypto.randomUUID();
      const own = yield* deliver(connection.url, connection.secret, ownId, {
        ...payload,
        sender: { login: identity.login },
      });
      const skipped = yield* Schema.decodeUnknownEffect(Answer)(own.body);
      yield* check(
        own.status === 200 &&
          skipped.status === "skipped" &&
          skipped.reason === "own_github_identity",
        "The stored GitHub login was not skipped",
      );
      const log = yield* request(`/api/deliveries?connection=${hook}`, Deliveries);
      yield* check(
        log.deliveries.some(
          (item) =>
            item.id === noAutomationId &&
            item.outcome === "skipped" &&
            item.reason === "no_automation" &&
            item.session === null,
        ),
        "The skip with no listening automation was not listed",
      );
      yield* check(
        log.deliveries.some(
          (item) => item.id === id && item.outcome === "accepted" && item.session === session.id,
        ),
        "The accepted delivery was not listed",
      );
      yield* check(
        log.deliveries.some(
          (item) =>
            item.id === badId && item.outcome === "rejected" && item.reason === "bad_signature",
        ),
        "Bad signature was not listed",
      );
      yield* check(
        log.deliveries.some(
          (item) =>
            item.id === ownId &&
            item.outcome === "skipped" &&
            item.reason === "own_github_identity" &&
            item.session === null,
        ),
        "The self-authored skip was not listed",
      );
      yield* check(
        (yield* request(`/api/runs?automation=${name}`, Runs)).runs.length === 1,
        "A rejected or self-authored event added a run",
      );
      yield* check((yield* prompts) === before, "A rejected or self-authored event added a prompt");
      yield* request(`${prefix}/stop`, View, { method: "POST" });
      yield* request(`/api/automations/${name}`, AutomationRemoved, { method: "DELETE" });
      yield* request(`/api/connections/${hook}`, ConnectionRemoved, { method: "DELETE" });
      console.log(
        "GitHub babysit: second turn, retry, bad signature, self-event and no-automation skips proved",
      );
    }).pipe(Effect.ensuring(cleanup));
  });
}
