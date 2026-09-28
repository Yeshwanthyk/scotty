import { BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { acceptedAgentEvents } from "../src/session/view.js";
import {
  access,
  ChatGptStatus,
  CliFailure,
  client,
  Conversation,
  Created,
  failure,
  Polled,
  Reply,
  Started,
  target,
  View,
} from "../cli/client.js";
import { Log, waiter } from "./lib/wait.js";
import { fixtureRepo } from "../protocol/supervisor.js";

const signIn = (request: ReturnType<typeof client>) =>
  Effect.gen(function* () {
    const device = yield* request("/api/credentials/chatgpt/start", Started, {
      method: "POST",
    });
    if ("status" in device)
      return yield* failure(
        "signin",
        `ChatGPT sign-in start failed: ${device.stage}, HTTP ${device.httpStatus ?? "unknown"}, code ${device.code ?? "unknown"}`,
        "scotty auth login chatgpt",
      );
    console.log(`Open ${device.verificationUrl} and enter code ${device.userCode}`);
    let signedIn = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      yield* Effect.sleep(`${Math.max(1, device.interval)} seconds`);
      const result = yield* request("/api/credentials/chatgpt/poll", Polled, {
        method: "POST",
      });
      if (result.status === "signed-in") {
        signedIn = true;
        break;
      }
      if (result.status === "failed")
        return yield* failure(
          "signin",
          `ChatGPT sign-in poll failed: ${result.stage}, HTTP ${result.httpStatus ?? "unknown"}, code ${result.code ?? "unknown"}`,
          "scotty auth login chatgpt",
        );
      if (result.status === "expired")
        return yield* failure(
          "signin",
          "ChatGPT device authorization expired",
          "scotty auth login chatgpt",
        );
    }
    if (!signedIn)
      return yield* failure("signin", "ChatGPT sign-in timed out", "scotty auth login chatgpt");
  });
const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const token = yield* access(url);
  const request = client({ url, token });
  // Sign in only when the stored ChatGPT token is missing or near expiry.
  const current = yield* request("/api/credentials/chatgpt", ChatGptStatus);
  if (current.status !== "signed-in") yield* signIn(request);
  const unique = crypto.randomUUID();
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    key: unique,
    body: {
      title: "Step 2 core",
      repo: fixtureRepo,
      // Commands must not inherit the ChatGPT token from Codex's config. SCOTTY_HATCH, the public
      // preview URL template, is the one variable they are meant to see.
      prompt:
        "Run `env | grep SCOTTY_ | grep -vc ^SCOTTY_HATCH=` and reply with only the word ready followed by the number it printed.",
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  const poll = waiter(request, prefix);
  const events = () => request(`${prefix}/log`, Log);
  const first = yield* poll(
    () => request(`${prefix}/conversation`, Conversation),
    (conversation) => (conversation.turns[0]?.assistant.length ?? 0) > 0,
  );
  if (!/\bready 0\b/.test(first.turns[0]?.assistant.toLowerCase() ?? ""))
    return yield* failure(
      "core",
      "Initial answer missing or SCOTTY_ env visible to commands",
      "scotty doctor",
    );
  const log = yield* events();
  const start = log.find((event) => event.kind === "container.start");
  const hello = log.find((event) => event.kind === "sup.hello");
  if (!start || !hello || hello.at < start.at)
    return yield* failure("core", "Missing cold-start event pair", "scotty doctor");
  console.log(`Cold start container.start → hello: ${hello.at - start.at} ms`);
  yield* poll(events, (items) =>
    items.some((event) => event.kind === "turn.ended" && event.turn === "0"),
  );

  // The same deployment command used by the operator. Its output is not echoed.
  const redeploy = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.exitCode(
      ChildProcess.make("npm", ["run", "deploy", "--", "--stage", "dev"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError(() =>
      failure("deploy", "Worker redeploy failed", "npm run deploy -- --stage dev"),
    ),
  );
  if (redeploy !== 0)
    return yield* failure("deploy", "Worker redeploy failed", "npm run deploy -- --stage dev");
  yield* request(prefix, View);
  const before = yield* events();
  const steerReq = crypto.randomUUID();
  yield* request(`${prefix}/steer`, Reply, {
    method: "POST",
    key: steerReq,
    body: { req: steerReq, turn: "1", text: "Answer with the word steered." },
  });
  const after = yield* poll(
    events,
    (items) =>
      items.some((event) => event.kind === "turn.ended" && event.turn === "1") &&
      items.some((event) => event.kind === "prompt.delivered" && event.req === steerReq),
  );
  yield* poll(
    () => request(`${prefix}/conversation`, Conversation),
    (conversation) => conversation.turns[1]?.assistant.toLowerCase().includes("steered") ?? false,
  );
  const accepted = acceptedAgentEvents(after).filter((event) => event.kind === "agent.event");
  const numbers = accepted.map((event) => event.n);
  const prior = acceptedAgentEvents(before).filter((event) => event.kind === "agent.event");
  if (
    new Set(numbers).size !== numbers.length ||
    accepted.length <= prior.length ||
    prior.some((event, index) => accepted[index]?.seq !== event.seq)
  )
    return yield* failure(
      "core",
      "Duplicate or lost messages after Worker redeploy",
      "scotty doctor",
    );
  const longReq = crypto.randomUUID();
  yield* request(`${prefix}/steer`, Reply, {
    method: "POST",
    key: longReq,
    body: { req: longReq, turn: "2", text: "Count from one to ten thousand, slowly." },
  });
  const interruptReq = crypto.randomUUID();
  yield* request(`${prefix}/interrupt`, Reply, {
    method: "POST",
    key: interruptReq,
    body: { req: interruptReq, turn: "2" },
  });
  yield* poll(
    events,
    (items) =>
      items.some((event) => event.kind === "interrupt.requested" && event.req === interruptReq) &&
      items.some(
        (event) =>
          event.kind === "turn.ended" && event.turn === "2" && event.state === "interrupted",
      ),
  );
  const snapshot = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("bun", ["cli/main.ts", "read", session.id], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    const json = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    if ((yield* child.exitCode) !== 0)
      return yield* failure("core", "CLI read exited unsuccessfully", `scotty read ${session.id}`);
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          id: Schema.String,
          turn: Schema.Struct({ id: Schema.String, state: Schema.String }),
          messages: Schema.Array(Schema.Unknown),
        }),
      ),
    )(json);
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.mapError(() => failure("core", "CLI read failed", `scotty read ${session.id}`)),
  );
  if (
    snapshot.id !== session.id ||
    snapshot.turn.id !== longReq ||
    snapshot.turn.state !== "aborted" ||
    snapshot.messages.length > 1
  )
    return yield* failure(
      "core",
      "CLI read did not report the latest aborted turn within its default bound",
      `scotty read ${session.id}`,
    );
  yield* request(`${prefix}/stop`, View, { method: "POST" });
  console.log("Core: create, answer, redeploy, steer, interrupt, bounded read recorded");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Core e2e failed");
  process.exitCode = 1;
});
