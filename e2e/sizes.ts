import { Effect, Schema } from "effect";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Removed,
  Settings,
  target,
  View,
} from "../cli/client.js";
import { state } from "../cli/commands/common.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";
import { fixtureRepo } from "../protocol/supervisor.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("sizes", message, "scotty doctor"));

// The stage's maxRunning, set by whoever deployed it for this test; `track` uses 2.
const cap = Schema.decodeUnknownOption(Schema.NumberFromString.check(Schema.isInt()))(
  process.env.SCOTTY_E2E_MAX_RUNNING,
);

const program = Effect.gen(function* () {
  if (cap._tag === "None") {
    console.log(
      "Skipped the running cap: set SCOTTY_E2E_MAX_RUNNING to the stage's maxRunning (deploy it with maxRunning: 2)",
    );
    return;
  }
  const max = cap.value;
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const settings = yield* request("/api/settings", Settings);
  yield* check(
    settings.maxRunning === max,
    `The stage's maxRunning is ${settings.maxRunning}, not ${max}; set maxRunning and deploy`,
  );
  // Fill the cap with sessions of our own, so one of them can be stopped to make room.
  const fill = max - settings.running;
  yield* check(fill >= 1, `${settings.running} of ${max} slots are taken; stop a session first`);
  const made: string[] = [];
  const create = (title: string, word: string) =>
    Effect.gen(function* () {
      const session = yield* request("/api/sessions", Created, {
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          title: `e2e sizes ${title} (${agent})`,
          repo: fixtureRepo,
          ...sessionAgent,
          prompt: prompt(`Reply with only the word ${word}.`, `say ${word}`),
          provider: "cloudflare",
        },
      });
      made.push(session.id);
      console.log(`Session ${session.id} (${title})`);
      return `/api/sessions/${session.id}`;
    });
  const answered = (prefix: string, word: string) =>
    Effect.gen(function* () {
      yield* waiter(request, prefix)(
        () => request(`${prefix}/log`, Log),
        (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"),
      );
      const conversation = yield* request(`${prefix}/conversation`, Conversation);
      yield* check(
        conversation.turns[0]?.assistant.includes(word) === true,
        `${prefix} did not answer ${word}`,
      );
    });

  yield* Effect.gen(function* () {
    // 1. Up to the cap, sessions start and answer.
    const running: string[] = [];
    for (let i = 0; i < fill; i++) {
      const prefix = yield* create(`running ${i + 1}`, `ready${i + 1}`);
      yield* answered(prefix, `ready${i + 1}`);
      running.push(prefix);
    }
    console.log(`${fill} sessions running; the cap of ${max} is full`);

    // 2. One more stops before its container, with reason cap and the message.
    const extra = yield* create("over the cap", "room");
    const refused = yield* waiter(request, extra)(
      () => request(extra, View),
      (view) => view.session.authority.kind === "stable",
      { stopped: "expected" },
    );
    const authority = refused.session.authority;
    yield* check(
      authority.kind === "stable" &&
        authority.lifecycle === "stopped" &&
        authority.stop?.reason === "cap" &&
        authority.stop.max === max,
      `The session over the cap is not stopped with reason cap: ${JSON.stringify(authority)}`,
    );
    const message = `stopped · cap: ${max} sessions are running; stop one or raise maxRunning`;
    yield* check(state(refused.session) === message, `scotty shows "${state(refused.session)}"`);
    const log = yield* request(`${extra}/log`, Log);
    yield* check(
      !log.some((e) => e.kind === "sup.hello"),
      "A container started for the session over the cap",
    );
    console.log(`Refused: "${message}"`);

    // 3. Stopping one makes room; the refused session resumes and answers.
    const [first] = running;
    if (first !== undefined) yield* request(`${first}/stop`, View, { method: "POST" });
    yield* request(`${extra}/resume`, View, { method: "POST" });
    yield* answered(extra, "room");
    console.log("Stopped one; the refused session resumed and answered");
  }).pipe(
    Effect.ensuring(
      Effect.forEach(made, (id) =>
        Effect.ignore(
          request(`/api/sessions/${id}/stop`, View, { method: "POST" }).pipe(
            Effect.andThen(request(`/api/sessions/${id}`, Removed, { method: "DELETE" })),
          ),
        ),
      ),
    ),
  );
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Sizes e2e failed");
  process.exitCode = 1;
});
