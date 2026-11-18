import { Effect } from "effect";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Removed,
  target,
  View,
} from "../cli/client.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const bigRepo = "torvalds/linux";
const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("tunnel", message, "scotty doctor"));

const upload =
  'head -c 20000000 /dev/urandom | curl -s -o /dev/null -w "upload=%{http_code}" -X PUT ' +
  '-H "content-type: image/png" -H "x-scotty-name: big.png" --data-binary @- "$SCOTTY_TUNNEL/files.internal/"';
const measure = `du -sm /workspace/repo/.git | cut -f1 | sed "s/^/pack_mb=/"; ${upload}`;

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  const began = Date.now();
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: `e2e tunnel (${agent})`,
      repo: bigRepo,
      place: "daytona",
      ...sessionAgent,
      prompt: prompt(
        `Run exactly: \`${measure}\`, then reply with its full output.`,
        `run ${measure}\nsay {{out}}`,
      ),
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  yield* poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === "0"));
  const seconds = Math.round((Date.now() - began) / 1000);
  const conversation = yield* request(`${prefix}/conversation`, Conversation);
  const reply = conversation.turns[0]?.assistant ?? "";
  const pack = Number(/pack_mb=(\d+)/.exec(reply)?.[1] ?? "0");
  yield* check(pack >= 150, `Clone of ${bigRepo} holds ${pack} MB, expected at least 150`);
  yield* check(reply.includes("upload=200"), `20 MB upload through the tunnel: ${reply}`);
  const log = yield* events();
  const drops = log.filter((e) => e.kind === "socket.closed").length;
  yield* check(drops === 0, `The supervisor link dropped ${drops} times`);
  yield* check(!log.some((e) => e.kind === "invariant.violated"), "Invariant violated");
  console.log(
    `Tunnel: cloned ${bigRepo} (${pack} MB of .git) and uploaded 20 MB in ${seconds} s, link held`,
  );

  const stops = log.filter((e) => e.kind === "place.paused").length;
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  yield* poll(events, (next) => next.filter((e) => e.kind === "place.paused").length > stops, {
    stopped: "expected",
  });
  const removed = yield* request(prefix, Removed, { method: "DELETE" });
  yield* check(removed.removed, "Session was not removed");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Tunnel e2e failed");
  process.exitCode = 1;
});
