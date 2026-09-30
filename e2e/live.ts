import { BunSocket } from "@effect/platform-bun";
import { Effect, Option, Schema } from "effect";
import { WebSocketConstructor, type WebSocketLike } from "effect/unstable/socket/Socket";
import {
  access,
  CliFailure,
  Conversation,
  Created,
  failure,
  Removed,
  client,
  Session,
  target,
  View,
} from "../cli/client.js";
import { agent, prompt, sessionAgent } from "./lib/agent.js";
import { fixtureRepo } from "../protocol/supervisor.js";

// Past the Session DO's 360 s workspace deadline, so a slow start fails on its own verdict.
const limit = 420_000;
const reply = "live-reply";

const SessionFrame = Schema.Struct({
  kind: Schema.Literal("snapshot"),
  seq: Schema.Number,
  session: Session,
  conversation: Conversation,
});
const ListFrame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session"), session: Session }),
  Schema.Struct({ kind: Schema.Literal("removed"), id: Schema.String }),
]);

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("live", message, "scotty doctor"));

// One live socket: every frame it received, decoded, in order. Anything undecodable fails the test.
// The socket closes with the scope, so a failed step can't leave it holding the process open.
const listen = <A>(connect: () => WebSocketLike, schema: Schema.Codec<A>, name: string) =>
  Effect.acquireRelease(Effect.sync(connect), (socket) => Effect.sync(() => socket.close())).pipe(
    Effect.map((socket) => {
      const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema));
      const frames: A[] = [];
      const bad: string[] = [];
      let closed = false;
      socket.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        const frame = decode(text);
        if (Option.isSome(frame)) frames.push(frame.value);
        else bad.push(text.slice(0, 200));
      });
      socket.addEventListener("close", () => (closed = true));
      const fail = (message: string) => Effect.fail(failure("live", message, "scotty doctor"));
      // Waits on frames already received; this makes no request.
      const until = (done: (frames: readonly A[]) => boolean, what: string) =>
        Effect.gen(function* () {
          const started = Date.now();
          while (!done(frames)) {
            if (bad.length > 0) return yield* fail(`${name} sent an unreadable frame: ${bad[0]}`);
            if (closed) return yield* fail(`${name} closed while waiting for ${what}`);
            if (Date.now() - started > limit) return yield* fail(`Timed out waiting for ${what}`);
            yield* Effect.sleep("100 millis");
          }
          return frames;
        });
      return { frames, until, close: () => socket.close() };
    }),
  );

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  const connect = yield* WebSocketConstructor;
  const open = (path: string) => {
    const endpoint = new URL(path, url);
    endpoint.protocol = "wss:";
    return connect(endpoint.href, { headers: { "cf-access-token": token } });
  };

  // 1. The list socket is open before the session exists.
  const list = yield* listen(() => open("/api/sessions/live"), ListFrame, "The list socket");
  yield* Effect.sleep("2 seconds");
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: `e2e live (${agent})`,
      repo: fixtureRepo,
      ...sessionAgent,
      prompt: prompt(`Wait five seconds, then reply with only ${reply}.`, `sleep 5\nsay ${reply}`),
      provider: "cloudflare",
    },
  });
  const id = session.id;
  const prefix = `/api/sessions/${id}`;
  console.log(`Session ${id}`);

  // 2. The session socket's first frame is a snapshot; pushes show the turn stream, then end.
  const live = yield* listen(() => open(`${prefix}/live`), SessionFrame, "The session socket");
  yield* live.until((frames) => frames.length > 0, "the first snapshot");
  const turn = (frame: typeof SessionFrame.Type) => frame.conversation.turns[0];
  const completed = yield* live.until(
    (frames) =>
      frames.some((f) => turn(f)?.state === "completed" && turn(f)?.assistant.includes(reply)),
    "the completed turn",
  );
  const done = completed.findIndex((f) => turn(f)?.state === "completed");
  yield* check(
    completed.slice(0, done).some((f) => turn(f)?.state === "streaming"),
    "No frame showed the turn streaming before it completed",
  );
  const seqs = completed.map((f) => f.seq);
  yield* check(
    seqs.every((seq, i) => i === 0 || seq >= (seqs[i - 1] ?? 0)),
    `Frames arrived out of order: ${seqs.join(",")}`,
  );
  console.log(`Session socket: ${completed.length} frames, streaming then completed with ${reply}`);

  // 3. The list socket heard about the session.
  yield* list.until(
    (frames) => frames.some((f) => f.kind === "session" && f.session.identity.id === id),
    "the session on the list socket",
  );
  console.log("List socket: the new session was pushed");

  // 4. The owner's stop is pushed to both, as theirs.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  const byUser = (s: typeof Session.Type) =>
    s.authority.kind === "stable" && s.authority.stop?.reason === "user";
  const stopped = yield* live.until(
    (frames) => frames.some((f) => byUser(f.session)),
    "the stop on the session socket",
  );
  yield* list.until(
    (frames) =>
      frames.some((f) => f.kind === "session" && f.session.identity.id === id && byUser(f.session)),
    "the stop on the list socket",
  );
  console.log("Stop: both sockets show the session stopped by the owner");

  // 5. A new socket starts from a fresh snapshot, no older than what the last one saw.
  const last = Math.max(...stopped.map((f) => f.seq));
  live.close();
  const again = yield* listen(() => open(`${prefix}/live`), SessionFrame, "The reconnected socket");
  const [first] = yield* again.until((frames) => frames.length > 0, "the reconnect snapshot");
  yield* check(
    first !== undefined && first.seq >= last && byUser(first.session),
    `The reconnect snapshot was seq ${first?.seq}, after ${last}`,
  );
  console.log(`Reconnect: snapshot at seq ${first?.seq} (last seen ${last})`);

  // 6. Deleting the session tells the list.
  yield* request(prefix, Removed, { method: "DELETE" });
  yield* list.until(
    (frames) => frames.some((f) => f.kind === "removed" && f.id === id),
    "the removal on the list socket",
  );
  console.log("Delete: the list socket heard the session go");
});

Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(BunSocket.layerWebSocketConstructor)),
).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Live e2e failed");
  process.exitCode = 1;
});
