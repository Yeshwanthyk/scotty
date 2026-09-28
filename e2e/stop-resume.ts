import { fixtureRepo } from "../protocol/supervisor.js";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  List,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { Log, waiter } from "./lib/wait.js";

const Instances = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
);
const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("stop-resume", message, "scotty doctor"));

const instances = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const app = process.env.SCOTTY_CONTAINER_APP_ID ?? "";
  const child = yield* spawner.spawn(
    ChildProcess.make("npx", ["wrangler", "containers", "instances", app, "--json"], {
      stdin: "ignore",
      stderr: "ignore",
    }),
  );
  const json = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
  return yield* Schema.decodeUnknownEffect(Instances)(json);
}).pipe(
  Effect.scoped,
  Effect.provide(BunServices.layer),
  Effect.mapError(() =>
    failure("setup", "Could not list container instances", "export SCOTTY_CONTAINER_APP_ID=<id>"),
  ),
);

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const marker = `MARK-${crypto.randomUUID().slice(0, 8)}`;
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: "Step 6 stop-resume",
      repo: fixtureRepo,
      prompt: `Run exactly: \`echo ${marker} > marker.txt && rm README\`, then reply with only the word done.`,
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  const saved = (turn: string) =>
    poll(events, (log) => log.some((e) => e.kind === "save.done" && e.turn === turn));
  const answer = (turn: string, text: string) =>
    Effect.gen(function* () {
      const req = crypto.randomUUID();
      yield* request(`${prefix}/steer`, Reply, {
        method: "POST",
        key: req,
        body: { req, turn, text },
      });
      yield* poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === turn));
      const conversation = yield* request(`${prefix}/conversation`, Conversation);
      return conversation.turns.find((item) => item.id === req)?.assistant ?? "";
    });
  const lifecycle = (view: typeof View.Type) =>
    view.session.authority.kind === "stable" ? view.session.authority.lifecycle : "booting";

  // 1. The first turn writes the marker and deletes README, then a save lands in R2.
  yield* saved("0");

  // 2. Stop: listed as stopped and its container instance is no longer running.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  const listed = yield* request("/api/sessions", List);
  const entry = listed.sessions.find((item) => item.identity.id === session.id);
  yield* check(
    entry?.authority.kind === "stable" && entry.authority.lifecycle === "stopped",
    "ls does not show the session stopped",
  );
  yield* poll(
    () => instances,
    (items) => items.every((item) => item.name !== session.id || item.state !== "running"),
    { stopped: "expected" },
  );
  console.log("Stopped: ls shows stopped and the instance is not running");

  // 3. A steer resumes the same Codex thread with the saved files.
  const recalled = yield* answer("1", "What was the marker? Reply with the marker only.");
  const threads = (yield* events()).flatMap((e) => (e.kind === "agent.ready" ? [e.session] : []));
  yield* check(threads.length >= 2 && new Set(threads).size === 1, "Resume used a new thread");
  yield* check(recalled.includes(marker), "Resumed thread did not recall the marker");
  const files = yield* answer(
    "2",
    "Run exactly: `cat marker.txt; ls README` and reply with its full output.",
  );
  yield* check(
    files.includes(marker) && /no such file|cannot access/i.test(files),
    "Resumed workspace lost marker.txt or restored README",
  );
  console.log("Resumed: same thread, marker recalled, marker.txt present, README gone");

  // 4. A crash mid-turn ends stopped, not failed; resume restores the last save.
  yield* saved("2");
  const crash = crypto.randomUUID();
  yield* request(`${prefix}/steer`, Reply, {
    method: "POST",
    key: crash,
    body: {
      req: crash,
      turn: "3",
      text: "Run exactly: `sleep 5 && pkill -9 -f 'codex app-server'`",
    },
  });
  const ended = yield* poll(
    () => Effect.all([request(prefix, View), events()]),
    ([view, log]) =>
      lifecycle(view) === "stopped" ||
      lifecycle(view) === "failed" ||
      log.some((e) => e.kind === "turn.ended" && e.turn === "3"),
  );
  yield* check(
    !ended[1].some((e) => e.kind === "turn.ended" && e.turn === "3" && e.state === "completed"),
    "Crash turn completed: the kill command did not stop Codex",
  );
  const crashed = yield* poll(
    () => request(prefix, View),
    (view) => lifecycle(view) === "stopped" || lifecycle(view) === "failed",
  );
  yield* check(lifecycle(crashed) === "stopped", "Crash did not end the session stopped");
  yield* check(
    !(yield* events()).some((e) => e.kind === "invariant.violated"),
    "Invariant violated during crash",
  );
  yield* request(`${prefix}/resume`, View, { method: "POST" });
  const after = yield* answer("3", "What was the marker? Reply with the marker only.");
  yield* check(after.includes(marker), "Marker lost after crash and resume");
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  console.log("Crash: stopped without invariant violations; resume recalled the marker");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Stop-resume e2e failed");
  process.exitCode = 1;
});
