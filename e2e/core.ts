import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { SessionEvent } from "../src/session/events.js";
import { acceptedAgentEvents } from "../src/session/view.js";
import { client, config, E2eError } from "./lib/client.js";

const Created = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  branch: Schema.String,
  provider: Schema.Literal("cloudflare"),
  status: Schema.Literals(["booting", "warm"]),
});
const RequestResult = Schema.Struct({ status: Schema.String });
const Conversation = Schema.Struct({
  version: Schema.Literal(1),
  turns: Schema.Array(Schema.Struct({ assistant: Schema.String })),
});
const Log = Schema.Array(SessionEvent);
const DeviceStart = Schema.Union([
  Schema.Struct({
    verificationUrl: Schema.String,
    userCode: Schema.String,
    interval: Schema.Number,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    stage: Schema.String,
    httpStatus: Schema.NullOr(Schema.Number),
    code: Schema.NullOr(Schema.String),
  }),
]);
const DevicePoll = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), interval: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("signed-in"), expiresAt: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    stage: Schema.String,
    httpStatus: Schema.NullOr(Schema.Number),
    code: Schema.NullOr(Schema.String),
  }),
]);
const ChatGptStatus = Schema.Struct({
  status: Schema.Literals(["signed-in", "signed-out", "expiring"]),
  expiresAt: Schema.NullOr(Schema.Number),
});
const signIn = (request: ReturnType<typeof client>) =>
  Effect.gen(function* () {
    const device = yield* request("/api/credentials/chatgpt/start", DeviceStart, {
      method: "POST",
    });
    if ("status" in device)
      return yield* new E2eError({
        message: `ChatGPT sign-in start failed: ${device.stage}, HTTP ${device.httpStatus ?? "unknown"}, code ${device.code ?? "unknown"}`,
      });
    console.log(`Open ${device.verificationUrl} and enter code ${device.userCode}`);
    let signedIn = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      yield* Effect.sleep(`${Math.max(1, device.interval)} seconds`);
      const result = yield* request("/api/credentials/chatgpt/poll", DevicePoll, {
        method: "POST",
      });
      if (result.status === "signed-in") {
        signedIn = true;
        break;
      }
      if (result.status === "failed")
        return yield* new E2eError({
          message: `ChatGPT sign-in poll failed: ${result.stage}, HTTP ${result.httpStatus ?? "unknown"}, code ${result.code ?? "unknown"}`,
        });
      if (result.status === "expired")
        return yield* new E2eError({ message: "ChatGPT device authorization expired" });
    }
    if (!signedIn) return yield* new E2eError({ message: "ChatGPT sign-in timed out" });
  });
const program = Effect.gen(function* () {
  const settings = yield* config();
  const repo = yield* Schema.decodeUnknownEffect(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  )(process.env.SCOTTY_TEST_REPO).pipe(
    Effect.mapError(
      () => new E2eError({ message: "SCOTTY_TEST_REPO must name a public owner/repository" }),
    ),
  );
  const request = client(settings);
  // Sign in only when the stored ChatGPT token is missing or near expiry.
  const current = yield* request("/api/credentials/chatgpt", ChatGptStatus);
  if (current.status !== "signed-in") yield* signIn(request);
  const unique = crypto.randomUUID();
  const session = yield* request("/api/sessions", Created, {
    method: "POST",
    req: unique,
    body: {
      title: "Step 2 core",
      repo,
      // The ChatGPT token is in Codex's env; the agent's commands must not see it.
      prompt:
        "Run `env | grep -c SCOTTY_` and reply with only the word ready followed by the number it printed.",
      provider: "cloudflare",
    },
  });
  const prefix = `/api/sessions/${session.id}`;
  const poll = <A>(read: () => Effect.Effect<A, E2eError>, done: (value: A) => boolean) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 150; attempt++) {
        const value = yield* read();
        if (done(value)) return value;
        yield* Effect.sleep("2 seconds");
      }
      return yield* new E2eError({ message: "Timed out waiting for session outcome" });
    });
  const events = () => request(`${prefix}/log`, Log);
  const first = yield* poll(
    () => request(`${prefix}/conversation`, Conversation),
    (conversation) => (conversation.turns[0]?.assistant.length ?? 0) > 0,
  );
  if (!/\bready 0\b/.test(first.turns[0]?.assistant.toLowerCase() ?? ""))
    return yield* new E2eError({
      message: "Initial answer missing or SCOTTY_ env visible to commands",
    });
  const log = yield* events();
  const start = log.find((event) => event.kind === "container.start");
  const hello = log.find((event) => event.kind === "sup.hello");
  if (!start || !hello || hello.at < start.at)
    return yield* new E2eError({ message: "Missing cold-start event pair" });
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
    Effect.mapError(() => new E2eError({ message: "Worker redeploy failed" })),
  );
  if (redeploy !== 0) return yield* new E2eError({ message: "Worker redeploy failed" });
  yield* request(prefix, Schema.Struct({ version: Schema.Literal(1) }));
  const before = yield* events();
  const steerReq = crypto.randomUUID();
  yield* request(`${prefix}/steer`, RequestResult, {
    method: "POST",
    req: steerReq,
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
    return yield* new E2eError({ message: "Duplicate or lost messages after Worker redeploy" });
  const longReq = crypto.randomUUID();
  yield* request(`${prefix}/steer`, RequestResult, {
    method: "POST",
    req: longReq,
    body: { req: longReq, turn: "2", text: "Count from one to ten thousand, slowly." },
  });
  const interruptReq = crypto.randomUUID();
  yield* request(`${prefix}/interrupt`, RequestResult, {
    method: "POST",
    req: interruptReq,
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
  console.log("Core: create, answer, redeploy, steer, interrupt recorded");
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof E2eError ? error.message : "Core e2e failed");
  process.exitCode = 1;
});
