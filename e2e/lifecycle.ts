import { Effect } from "effect";
import {
  access,
  CliFailure,
  client,
  Created,
  failure,
  List,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { state } from "../cli/commands/common.js";
import { agent, prompt, real, sessionAgent } from "./lib/agent.js";
import { instances } from "./lib/instances.js";
import { Log, waiter } from "./lib/wait.js";
import { fixtureRepo } from "../protocol/supervisor.js";

// Longer than the 70–140 s after which Cloudflare evicted a quiet Session DO and stopped its
// container mid-turn.
const silence = 300;
// The scripted stand-in sleeps after a minute idle; the real agent keeps the default window.
const idleAfter = 60_000;
const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("lifecycle", message, "scotty doctor"));

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: `e2e lifecycle (${agent})`,
      repo: fixtureRepo,
      ...sessionAgent,
      prompt: prompt(
        `Run exactly: \`sleep ${silence}\`, then reply with only the word awake.`,
        `sleep ${silence}\nsay awake`,
      ),
      provider: "cloudflare",
      ...(real ? {} : { idleAfter }),
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);

  // 1. A turn that prints nothing for longer than a quiet Session DO stays in memory.
  yield* poll(events, (log) => log.some((e) => e.kind === "prompt.delivered"));
  const watched = (yield* events()).some((e) => e.kind === "container.watched");
  yield* check(watched, "The container was not watched once the supervisor answered");
  console.log(`Turn running; no requests to the session for ${silence + 30} s`);
  // Nothing may reach the Session DO here: a request would keep it in memory.
  yield* Effect.sleep(`${silence + 30} seconds`);
  const log = yield* poll(events, (log) =>
    log.some((e) => e.kind === "turn.ended" && e.turn === "0"),
  );
  yield* check(
    log.some((e) => e.kind === "turn.ended" && e.turn === "0" && e.state === "completed"),
    "The silent turn did not complete",
  );
  const ended = log.find((e) => e.kind === "turn.ended" && e.turn === "0")?.seq ?? 0;
  yield* check(
    !log.some((e) => e.kind === "container.stopped" && (e.seq < ended || e.reason !== "idle")),
    "The container stopped during the silent turn",
  );
  yield* check(
    !log.some((e) => e.kind === "invariant.violated"),
    "Invariant violated during the silence",
  );
  const evicted = log.some((e) => e.kind === "sup.redial");
  console.log(
    `Silent turn completed; the Session DO ${evicted ? "was evicted and reattached" : "stayed in memory"}`,
  );

  // 2. Once the turn's save is done the session is warm, then sleeps and frees its container.
  const warm = yield* poll(
    () => request(prefix, View),
    (view) =>
      view.session.progress.sleepsAt != null ||
      (view.session.authority.kind === "stable" && view.session.authority.lifecycle === "stopped"),
  );
  yield* check(
    state(warm.session).startsWith("warm · sleeps in"),
    `The idle session was not warm: ${state(warm.session)}`,
  );
  console.log(`Idle: ${state(warm.session)}`);
  yield* poll(
    events,
    (log) => log.some((e) => e.kind === "container.stopped" && e.reason === "idle"),
    { stopped: "expected" },
  );
  const listed = (yield* request("/api/sessions", List)).sessions.find(
    (item) => item.identity.id === session.id,
  );
  yield* check(
    listed !== undefined && state(listed) === "asleep · idle",
    "ls does not show the session asleep",
  );
  yield* poll(
    () => instances,
    (items) => items.every((item) => item.name !== session.id || item.state !== "running"),
    { stopped: "expected" },
  );
  console.log("Asleep: ls shows asleep · idle and the instance is not running");

  // 3. A message wakes it on a new container.
  const wake = crypto.randomUUID();
  yield* request(`${prefix}/steer`, Reply, {
    method: "POST",
    key: wake,
    body: {
      req: wake,
      turn: "1",
      text: prompt("Reply with only the word again.", "say again"),
    },
  });
  const woke = yield* poll(events, (log) =>
    log.some((e) => e.kind === "turn.ended" && e.turn === "1" && e.state === "completed"),
  );
  yield* check(
    woke.some((e) => e.kind === "sup.hello" && e.gen === 2),
    "The message did not start a new container",
  );
  console.log("Woke: a message resumed the session and its turn completed");

  // 4. The owner's stop is recorded as theirs.
  const stopped = yield* request(`${prefix}/stop`, View, { method: "POST" });
  yield* check(
    stopped.session.authority.kind === "stable" &&
      stopped.session.authority.lifecycle === "stopped",
    "Stop did not end the session stopped",
  );
  const stop = (yield* events()).findLast((e) => e.kind === "container.stopped");
  yield* check(
    stop?.kind === "container.stopped" && stop.reason === "user",
    "Stop was not recorded as the owner's",
  );
  console.log("Stopped: recorded as the owner's");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Lifecycle e2e failed");
  process.exitCode = 1;
});
