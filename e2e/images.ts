import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { access, CliFailure, client, Created, failure, target, View } from "../cli/client.js";
import { PromptImage, PromptImages, imageUrl, sameImages } from "../protocol/prompt.js";
import { fixtureRepo } from "../protocol/supervisor.js";
import { agent, sessionAgent } from "./lib/agent.js";
import { Log, waiter } from "./lib/wait.js";

const image = Schema.decodeUnknownSync(PromptImage)({
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V1sAAAAASUVORK5CYII=",
});
const Conversation = Schema.Struct({
  currentTurn: Schema.String,
  turns: Schema.Array(Schema.Struct({ images: PromptImages, assistant: Schema.String })),
});
const Outcome = Schema.Struct({ status: Schema.String });
const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const evidence = `work/verify/${Date.now()}-images-${agent}`;
  mkdirSync(evidence, { recursive: true });
  const key = crypto.randomUUID();
  const body = {
    title: `e2e images (${agent})`,
    repo: fixtureRepo,
    ...sessionAgent,
    prompt: "say INITIAL",
    images: [image],
    provider: "cloudflare",
  };
  const session = yield* request("/api/sessions", Created, { method: "POST", key, body });
  const prefix = `/api/sessions/${session.id}`;
  writeFileSync(`${evidence}/owned.json`, JSON.stringify([session.id]));
  console.log(`Session ${session.id}; evidence ${evidence}`);
  yield* Effect.gen(function* () {
    const poll = waiter(request, prefix);
    const digest = createHash("sha256").update(imageUrl(image)).digest("hex");
    yield* poll(
      () => request(`${prefix}/log`, Log),
      (events) => events.some((event) => event.kind === "turn.ended" && event.turn === "0"),
    );
    const first = yield* request(`${prefix}/conversation`, Conversation);
    if (
      !sameImages(first.turns[0]?.images, [image]) ||
      !first.turns[0]?.assistant.includes(`IMAGE:${digest}`)
    )
      return yield* failure(
        "images",
        "Initial image did not reach agent and conversation intact",
        "scotty log",
      );
    const duplicate = yield* request("/api/sessions", Created, { method: "POST", key, body });
    if (duplicate.id !== session.id)
      return yield* failure("images", "Create retry made another session", "scotty log");
    const token = yield* access(url);
    const expectStatus = (
      path: string,
      payload: unknown,
      status: number,
      retry = crypto.randomUUID(),
    ) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${url}${path}`, {
              method: "POST",
              headers: {
                "cf-access-token": token,
                "content-type": "application/json",
                "idempotency-key": retry,
              },
              body: JSON.stringify(payload),
            }),
          catch: () => failure("network", "Image request failed", "scotty doctor"),
        });
        if (response.status !== status)
          return yield* failure(
            "images",
            `Expected HTTP ${status}, got ${response.status}`,
            "scotty log",
          );
      });
    yield* expectStatus("/api/sessions", { ...body, images: [] }, 409, key);
    const steer = { text: "run sleep 3\nsay STEER", turn: first.currentTurn, images: [image] };
    const req = crypto.randomUUID();
    yield* request(`${prefix}/steer`, Outcome, { method: "POST", key: req, body: steer });
    yield* request(`${prefix}/steer`, Outcome, { method: "POST", key: req, body: steer });
    yield* expectStatus(`${prefix}/steer`, { ...steer, images: [] }, 409, req);
    for (const images of [
      [{ ...image, data: "not base64!" }],
      [{ ...image, mediaType: "image/svg+xml" }],
      Array(5).fill(image),
      [{ ...image, data: "AAAA".repeat(55_001) }],
      Array(4).fill({ ...image, data: "AAAA".repeat(44_000) }),
    ])
      yield* expectStatus(`${prefix}/steer`, { ...steer, images }, 400);
    yield* poll(
      () => request(`${prefix}/log`, Log),
      (events) => events.some((event) => event.kind === "turn.ended" && event.turn === steer.turn),
    );
    const conversation = yield* request(`${prefix}/conversation`, Conversation);
    if (
      conversation.turns.length !== 2 ||
      !sameImages(conversation.turns[1]?.images, [image]) ||
      !conversation.turns[1]?.assistant.includes(`IMAGE:${digest}`)
    )
      return yield* failure("images", "Steer/retry lost images or duplicated prompt", "scotty log");
    const large = Array(4).fill({ ...image, data: "AAAA".repeat(43_750) });
    yield* expectStatus(
      `${prefix}/steer`,
      { text: "\0".repeat(100_000), turn: conversation.currentTurn, images: large },
      400,
    );
    yield* request(`${prefix}/steer`, Outcome, {
      method: "POST",
      key: crypto.randomUUID(),
      body: { text: "say BOUNDARY", turn: conversation.currentTurn, images: large },
    });
    const largeDigest = createHash("sha256").update(imageUrl(large[0])).digest("hex");
    yield* poll(
      () => request(`${prefix}/conversation`, Conversation),
      (value) =>
        value.turns.some(
          (turn) =>
            sameImages(turn.images, large) && turn.assistant.includes(`IMAGE:${largeDigest}`),
        ),
    );
    console.log(
      `Images (${agent}): initial, steer, exact retries, conflicts, invalid/oversize rejection and 700 KB boundary passed`,
    );
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const log = yield* request(`${prefix}/log`, Log);
        writeFileSync(
          `${evidence}/events.jsonl`,
          log.map((event) => JSON.stringify(event)).join("\n") + "\n",
        );
      }).pipe(
        Effect.ensuring(request(`${prefix}/stop`, View, { method: "POST" }).pipe(Effect.ignore)),
        Effect.ignore,
      ),
    ),
  );
});
Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Images e2e failed");
  process.exitCode = 1;
});
