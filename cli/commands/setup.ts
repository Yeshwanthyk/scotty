import { Effect, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { ChatGptStatus, Polled, Started, List, failure } from "../client.js";
import { output, url, withClient } from "./common.js";

export const doctor = Command.make("doctor", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    const reply = yield* api("/api/sessions", List);
    const chatgpt = yield* api("/api/credentials/chatgpt", ChatGptStatus);
    if (chatgpt.status !== "signed-in")
      return yield* failure(
        "setup",
        chatgpt.status === "expiring"
          ? "ChatGPT sign-in expires within a day"
          : "ChatGPT is not signed in",
        "npm run --silent scotty -- signin",
        3,
      );
    yield* output({
      url: Option.getOrElse(target, () => process.env.SCOTTY_URL ?? ""),
      access: "ok",
      worker: "ok",
      sessions: reply.sessions.length,
      chatgpt: "ok",
      chatgptExpiresAt: chatgpt.expiresAt,
    });
  }),
).pipe(Command.withDescription("Check URL, Access, Worker and ChatGPT sign-in"));

export const signin = Command.make("signin", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    const start = yield* api("/api/credentials/chatgpt/start", Started, { method: "POST" });
    if ("status" in start)
      return yield* failure(
        "signin",
        `ChatGPT sign-in failed: ${start.code ?? start.stage}`,
        "scotty signin",
      );
    console.error(`Open ${start.verificationUrl} and enter code ${start.userCode}`);
    const expires = start.expiresAt;
    while (Date.now() < expires) {
      yield* Effect.sleep(`${Math.max(1, start.interval)} seconds`);
      const result = yield* api("/api/credentials/chatgpt/poll", Polled, { method: "POST" });
      if (result.status === "pending") continue;
      if (result.status === "signed-in") return yield* output(result);
      return yield* failure(
        "signin",
        result.status === "expired"
          ? "Device code expired"
          : `ChatGPT sign-in failed: ${result.code ?? result.stage}`,
        "scotty signin",
        3,
      );
    }
    return yield* failure("signin", "Device code expired", "scotty signin", 3);
  }),
).pipe(Command.withDescription("Sign in to ChatGPT with a device code"));
