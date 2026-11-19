import { Effect, Option, Schema } from "effect";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Removed,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { boatApi } from "../src/places/boat.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const Hatch = Schema.Struct({ url: Schema.String });
const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("boat", message, "scotty doctor"));

const server = (marker: string) => `import http from "node:http";
http.createServer((q, s) => s.end("${marker}")).listen(8080, "0.0.0.0");
`;

const get = (url: string, token: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { "cf-access-token": token },
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.text() };
    },
    catch: () => failure("network", `GET ${url} failed`, "scotty doctor"),
  });

const SandboxState = Schema.fromJsonString(
  Schema.Struct({ sandbox: Schema.Struct({ state: Schema.String }) }),
);
const sandbox = (handle: string, method: "GET" | "DELETE") =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${boatApi}/sandboxes/${encodeURIComponent(handle)}`, {
        method,
        headers: {
          authorization: `Bearer ${process.env.BOAT_API_KEY ?? ""}`,
          ...(method === "DELETE" ? { "x-ascii-confirm-delete": handle } : {}),
        },
      });
      return { status: response.status, body: await response.text() };
    },
    catch: () => failure("network", `Boat ${method} failed`, "source work/dev-env.sh"),
  });
const gone = (handle: string) =>
  sandbox(handle, "GET").pipe(
    Effect.map(
      ({ status, body }) =>
        status === 404 ||
        Option.match(Schema.decodeUnknownOption(SandboxState)(body), {
          onNone: () => false,
          onSome: (answer) => answer.sandbox.state === "cancelled",
        }),
    ),
  );

const program = Effect.gen(function* () {
  if (process.env.BOAT_API_KEY === undefined)
    return yield* failure("boat", "BOAT_API_KEY is not set", "source work/dev-env.sh");
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  const marker = `BOAT-${crypto.randomUUID().slice(0, 8)}`;
  const start =
    `echo ${marker} > marker.txt && echo ${btoa(server(marker))} | base64 -d > /workspace/server.mjs && ` +
    "setsid nohup node /workspace/server.mjs > /dev/null 2>&1 < /dev/null &";
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: `e2e boat (${agent})`,
      repo: fixtureRepo,
      place: "boat",
      size: "standard-3",
      ...sessionAgent,
      prompt: prompt(
        `Run exactly: \`${start}\`, then reply with only the word done.`,
        `run ${start}\nsay done`,
      ),
    },
  });
  yield* check(session.place === "boat", `Session was made on ${session.place}`);
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  const handles = (log: typeof Log.Type) =>
    log.flatMap((e) => (e.kind === "place.created" ? [e.handle] : []));
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
  const pauses = (log: typeof Log.Type) => log.filter((e) => e.kind === "place.paused").length;
  const stop = Effect.gen(function* () {
    const before = pauses(yield* events());
    yield* request(`${prefix}/stop`, View, { method: "POST" });
    return yield* poll(events, (log) => pauses(log) > before, { stopped: "expected" });
  });
  const cat = prompt(
    "Run exactly: `cat marker.txt` and reply with its full output.",
    "run cat marker.txt\nsay {{out}}",
  );

  yield* poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"));
  const first = handles(yield* events());
  yield* check(first.length === 1, `Expected one sandbox, saw ${first.length}`);
  const view = yield* request(prefix, View);
  yield* check(
    view.session.display.size === "standard-2",
    `Size ${view.session.display.size}, not standard-2`,
  );
  console.log(`Created: sandbox ${first[0]}, standard-3 fitted to standard-2`);

  const hatch = yield* request(`${prefix}/hatch/8080`, Hatch);
  const page = yield* poll(
    () => get(`${hatch.url}/`, token),
    (value) => value.status === 200,
  );
  yield* check(page.body.includes(marker), `Preview did not serve the marker: ${page.body}`);
  console.log("Preview: port 8080 served through the Worker");

  yield* saved("0");
  yield* stop;
  const woke = yield* answer("1", cat);
  yield* check(woke.includes(marker), "Wake from disk lost marker.txt");
  yield* check(handles(yield* events()).length === 1, "Wake from disk made a new sandbox");
  console.log("Slept and woke: same sandbox, marker.txt kept");

  yield* saved("1");
  yield* stop;
  const deleted = yield* sandbox(first[0] ?? "", "DELETE");
  yield* check(deleted.status < 300, `Boat DELETE answered ${deleted.status}`);
  const restored = yield* answer("2", cat);
  yield* check(restored.includes(marker), "Restore after delete lost marker.txt");
  const after = handles(yield* events());
  yield* check(after.length === 2 && after[1] !== first[0], "Restore did not make a new sandbox");
  yield* check(
    !(yield* events()).some((e) => e.kind === "invariant.violated"),
    "Invariant violated",
  );
  console.log(`Restored: sandbox deleted while asleep, new sandbox ${after[1]} kept marker.txt`);

  yield* stop;
  const removed = yield* request(prefix, Removed, { method: "DELETE" });
  yield* check(removed.removed, "Session was not removed");
  for (const handle of after)
    yield* check(
      yield* gone(handle),
      `Sandbox ${handle} is still there after the session was removed`,
    );
  console.log("Removed: the session's sandboxes are gone");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Boat e2e failed");
  process.exitCode = 1;
});
