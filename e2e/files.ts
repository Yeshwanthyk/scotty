import { Effect } from "effect";
import {
  access,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Reply,
  target,
  View,
} from "../cli/client.js";
import { fold, initial } from "../src/session/fold.js";
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("files", message, "scotty doctor"));

const download = (url: string, token: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { "cf-access-token": token },
        signal: AbortSignal.timeout(30000),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get("content-type"), bytes };
    },
    catch: () => failure("network", `GET ${url} failed`, "scotty doctor"),
  });

const signatures: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "video/webm": [0x1a, 0x45, 0xdf, 0xa3],
};

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  const started = Date.now();
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: "e2e files",
      repo: process.env.SCOTTY_HATCH_TEST_REPO ?? "",
      prompt:
        "Start the dev server, take a 390×844 screenshot of the page and a 5 second video of clicking the counter, and attach both to this chat.",
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  const ended = (turn: string) =>
    poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === turn));
  const attached = () =>
    events().pipe(Effect.map((log) => log.filter((e) => e.kind === "file.attached").length));
  // Every file in turn 0 downloads with its recorded type, size and magic bytes.
  const downloads = Effect.gen(function* () {
    const conversation = yield* request(`${prefix}/conversation`, Conversation);
    const files = conversation.turns[0]?.files ?? [];
    for (const type of Object.keys(signatures))
      yield* check(
        files.filter((file) => file.type === type).length === 1,
        `Turn 0 should hold one ${type}: ${JSON.stringify(files)}`,
      );
    for (const file of files) {
      const got = yield* download(new URL(`${prefix}/files/${file.id}`, url).href, token);
      const magic = signatures[file.type] ?? [];
      yield* check(got.status === 200, `${file.name}: HTTP ${got.status}`);
      yield* check(got.type === file.type, `${file.name}: type ${got.type}, not ${file.type}`);
      yield* check(got.bytes.length === file.size, `${file.name}: size differs from its event`);
      yield* check(
        magic.every((byte, index) => got.bytes[index] === byte),
        `${file.name}: does not start with the ${file.type} signature`,
      );
      console.log(`${file.name} (${file.type}, ${file.size} bytes): ok`);
    }
  });

  // 1–3. The agent captures and attaches a screenshot and a video in the first turn.
  yield* ended("0");
  console.log(`Turn 0 (prompt to turn end): ${Math.round((Date.now() - started) / 1000)} s`);
  yield* downloads;

  // 4. A type off the list gets 415, a file over 25 MB gets 413, and neither is recorded.
  const before = yield* attached();
  const req = crypto.randomUUID();
  yield* request(`${prefix}/steer`, Reply, {
    method: "POST",
    key: req,
    body: {
      req,
      turn: "1",
      text: [
        "Run these two commands exactly and reply with only their two outputs, one per line:",
        "printf x | curl -s -o /dev/null -w '%{http_code}\\n' -X PUT -H 'content-type: text/plain' -H 'x-scotty-name: a.txt' --data-binary @- http://files.internal/",
        "head -c 26214401 /dev/zero | curl -s -o /dev/null -w '%{http_code}\\n' -X PUT -H 'content-type: image/png' -H 'x-scotty-name: big.png' --data-binary @- http://files.internal/",
      ].join("\n"),
    },
  });
  yield* ended("1");
  const replies = yield* request(`${prefix}/conversation`, Conversation);
  const codes = replies.turns.find((turn) => turn.id === req)?.assistant ?? "";
  yield* check(/415[\s\S]*413/.test(codes), `Expected 415 then 413: ${codes}`);
  yield* check((yield* attached()) === before, "A refused upload was recorded");
  console.log("Refused uploads: 415, 413, no event");

  // 5. After a stop the files still list and download, from R2 rather than the container.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  yield* poll(events, (log) => log.reduce(fold, initial).phase === "stopped", {
    stopped: "expected",
  });
  yield* downloads;
  console.log("After stop: both files still download");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Files e2e failed");
  process.exitCode = 1;
});
