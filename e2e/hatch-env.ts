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
import { Log, waiter } from "./lib/wait.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("hatch-env", message, "scotty doctor"));

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

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  const base = process.env.SCOTTY_HATCH_BASE ?? "";
  const started = Date.now();
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      title: "Step 8b hatch-env",
      repo: process.env.SCOTTY_HATCH_TEST_REPO ?? "",
      prompt:
        "Set up this repo's dev environment, start the dev server, and reply with only its URL.",
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  console.log(`Session ${session.id}`);
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  const ended = (turn: string) =>
    poll(events, (log) => log.some((e) => e.kind === "turn.ended" && e.turn === turn));
  const replyTo = (predicate: (id: string) => boolean) =>
    request(`${prefix}/conversation`, Conversation).pipe(
      Effect.map((c) => c.turns.find((item) => predicate(item.id))?.assistant ?? ""),
    );
  const answer = (turn: string, text: string) =>
    Effect.gen(function* () {
      const req = crypto.randomUUID();
      yield* request(`${prefix}/steer`, Reply, {
        method: "POST",
        key: req,
        body: { req, turn, text },
      });
      yield* ended(turn);
      return yield* replyTo((id) => id === req);
    });
  const preview = new RegExp(`https://\\d{4,5}-${session.id}\\.${base.replaceAll(".", "\\.")}`);
  // The reply names the URL and the dev server behind it answers with Vite's client.
  const serves = (reply: string) =>
    Effect.gen(function* () {
      const found = preview.exec(reply)?.[0];
      yield* check(found !== undefined, `Reply has no preview URL: ${reply}`);
      const page = yield* poll(
        () => get(`${found}/`, token),
        (value) => value.status === 200,
      );
      yield* check(page.body.includes("/@vite/client"), "Page is not served by Vite");
      return found;
    });

  // 1. The agent sets up the repo and starts the dev server.
  yield* ended("0");
  const first = yield* replyTo(() => true);
  const setup = Math.round((Date.now() - started) / 1000);
  console.log(`Setup: ${yield* serves(first)} in ${setup} s`);

  // 2. It left a committed-ready setup script behind.
  const script = yield* answer(
    "1",
    "Run `test -x .agents/setup && echo SETUP_OK` and reply with the output",
  );
  yield* check(script.includes("SETUP_OK"), `No executable .agents/setup: ${script}`);
  console.log("Setup script: .agents/setup is executable");

  // 3. After a stop, a steer brings the dev server back.
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  const resumed = Date.now();
  const again = yield* answer("2", "Bring the dev server back up and reply with only its URL");
  const restore = Math.round((Date.now() - resumed) / 1000);
  console.log(`Resume: ${yield* serves(again)} in ${restore} s`);
  yield* request(`${prefix}/stop`, View, { method: "POST" });
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Hatch-env e2e failed");
  process.exitCode = 1;
});
